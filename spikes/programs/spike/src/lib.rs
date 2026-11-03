//! Phase 01 throwaway spike (delete-later after phase 02): VRF payer, scoped callback and
//! PDA-custody payout measurements on the public devnet ER.
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, Token, TokenAccount, Transfer},
};
use ephemeral_rollups_sdk::{anchor::delegate, consts::ESPL_TOKEN_PROGRAM_ID, cpi::DelegateConfig};
use ephemeral_vrf_sdk::{
    anchor::{vrf, vrf_callback},
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

declare_id!("BNykdw1BfGo9qDfMQdTCjVhJF5AhncTCLkYNYLm5GPBC");

pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
pub const PUBLIC_VALIDATOR: Pubkey = pubkey!("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
pub const PROBE_SEED: &[u8] = b"probe";
pub const ADMIN: Pubkey = pubkey!("653bMLonrEbTNbSM9g1vH8PJATH1uh6wYNr9SYEJSzsY");

#[program]
pub mod bankroll_spike {
    use super::*;

    pub fn init_probe(ctx: Context<InitProbe>) -> Result<()> {
        ctx.accounts.probe.bump = ctx.bumps.probe;
        Ok(())
    }

    pub fn delegate_probe(ctx: Context<DelegateProbe>) -> Result<()> {
        ctx.accounts.delegate_probe(
            &ctx.accounts.payer,
            &[PROBE_SEED],
            DelegateConfig {
                validator: Some(PUBLIC_VALIDATOR),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Any signer may pay; F1 checks whether a zero-SOL wallet can.
    pub fn request_roll(ctx: Context<RequestRoll>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.nonce = probe.nonce.checked_add(1).ok_or(SpikeError::Overflow)?;
        probe.pending = true;
        probe.requested_at = Clock::get()?.unix_timestamp;
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeRoll::DISCRIMINATOR.to_vec(),
            caller_seed: probe.nonce.to_le_bytes().repeat(4).try_into().unwrap_or([0; 32]),
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: probe.key(),
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(probe.nonce.to_le_bytes().to_vec()),
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn consume_roll(ctx: Context<ConsumeRoll>, randomness: [u8; 32], nonce: u64) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        require!(probe.pending && probe.nonce == nonce, SpikeError::StaleRequest);
        let mut word = [0u8; 8];
        word.copy_from_slice(&randomness[..8]);
        probe.die = (u64::from_le_bytes(word) % 6) as u8 + 1;
        probe.pending = false;
        probe.fulfilled = probe.fulfilled.checked_add(1).ok_or(SpikeError::Overflow)?;
        Ok(())
    }

    /// F8: pays `amounts[i]` from probe custody to remaining_accounts pairs
    /// (canonical ATA, eATA), validating each pair the way settle will.
    pub fn payout<'info>(ctx: Context<'info, Payout<'info>>, amounts: Vec<u64>) -> Result<()> {
        let remaining = ctx.remaining_accounts;
        require!(
            !amounts.is_empty() && remaining.len() == amounts.len() * 2,
            SpikeError::InvalidAccount
        );
        let bump = [ctx.accounts.probe.bump];
        let seeds: &[&[u8]] = &[PROBE_SEED, &bump];
        for (amount, pair) in amounts.iter().zip(remaining.chunks(2)) {
            let destination = Account::<TokenAccount>::try_from(&pair[0])?;
            require_keys_eq!(destination.mint, USDC_MINT, SpikeError::InvalidAccount);
            require_keys_eq!(
                pair[0].key(),
                get_associated_token_address(&destination.owner, &USDC_MINT),
                SpikeError::InvalidAccount
            );
            require_keys_eq!(
                pair[1].key(),
                custody_address(destination.owner),
                SpikeError::InvalidAccount
            );
            require_keys_eq!(*pair[1].owner, ESPL_TOKEN_PROGRAM_ID, SpikeError::InvalidAccount);
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.custody.to_account_info(),
                        to: pair[0].clone(),
                        authority: ctx.accounts.probe.to_account_info(),
                    },
                    &[seeds],
                ),
                *amount,
            )?;
        }
        ctx.accounts.custody.reload()?;
        msg!("custody remaining {}", ctx.accounts.custody.amount);
        Ok(())
    }
}

pub fn custody_address(owner: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), USDC_MINT.as_ref()], &ESPL_TOKEN_PROGRAM_ID).0
}

#[account]
#[derive(InitSpace)]
pub struct Probe {
    pub nonce: u64,
    pub requested_at: i64,
    pub fulfilled: u32,
    pub die: u8,
    pub pending: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Probe::INIT_SPACE, seeds = [PROBE_SEED], bump)]
    pub probe: Account<'info, Probe>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Fixed-seed probe PDA owned by this program.
    #[account(mut, del, seeds = [PROBE_SEED], bump)]
    pub probe: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
    /// CHECK: Canonical public queue, VRF-owned on the ER.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE, owner = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeRoll<'info> {
    #[account(mut, seeds = [PROBE_SEED], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(address = ADMIN)]
    pub caller: Signer<'info>,
    #[account(seeds = [PROBE_SEED], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
    #[account(mut, address = get_associated_token_address(&probe.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = probe)]
    pub custody: Account<'info, TokenAccount>,
    /// CHECK: Canonical probe custody eATA, restored to its owner on the ER.
    #[account(address = custody_address(probe.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub custody_eata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum SpikeError {
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Callback does not match the pending request")]
    StaleRequest,
    #[msg("Invalid account")]
    InvalidAccount,
}
