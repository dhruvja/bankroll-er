//! Throwaway spike for on-demand tables: a delegated program PDA sponsors ER-only (ephemeral)
//! Table accounts that a zero-SOL host creates, rolls VRF dice into, and closes on the ER.
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    anchor::{delegate, MagicProgram},
    consts::EPHEMERAL_VAULT_ID,
    cpi::DelegateConfig,
    ephemeral_accounts::EphemeralAccount,
};
use ephemeral_vrf_sdk::{
    anchor::{vrf, vrf_callback},
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

declare_id!("6ry644nw1mhuggqxWPVAZLwpyDwbsPvPydSkBVMzWD7X");

pub const PUBLIC_VALIDATOR: Pubkey = pubkey!("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
pub const ADMIN: Pubkey = pubkey!("653bMLonrEbTNbSM9g1vH8PJATH1uh6wYNr9SYEJSzsY");
pub const SPONSOR_SEED: &[u8] = b"sponsor";
pub const TABLE_SEED: &[u8] = b"eph_table";
/// Same size as the real Table, so the measured rent matches production.
pub const TABLE_SPACE: u32 = 1503;

#[program]
pub mod bankroll_eph_spike {
    use super::*;

    pub fn init_sponsor(ctx: Context<InitSponsor>) -> Result<()> {
        ctx.accounts.sponsor.bump = ctx.bumps.sponsor;
        Ok(())
    }

    pub fn delegate_sponsor(ctx: Context<DelegateSponsor>) -> Result<()> {
        ctx.accounts.delegate_sponsor(
            &ctx.accounts.admin,
            &[SPONSOR_SEED],
            DelegateConfig { validator: Some(PUBLIC_VALIDATOR), ..Default::default() },
        )?;
        Ok(())
    }

    /// ER only. The sponsor PDA pays the ER rent; the table PDA signs its own creation.
    pub fn create_table(ctx: Context<TableLifecycle>, id: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        let sponsor_bump = [accounts.sponsor.bump];
        let (_, table_bump) = Pubkey::find_program_address(&[TABLE_SEED, &id.to_le_bytes()], &ID);
        let table_bump = [table_bump];
        let id_bytes = id.to_le_bytes();
        let sponsor_seeds: &[&[u8]] = &[SPONSOR_SEED, &sponsor_bump];
        let table_seeds: &[&[u8]] = &[TABLE_SEED, &id_bytes, &table_bump];
        EphemeralAccount::new(&accounts.sponsor.to_account_info(), &accounts.table, &accounts.vault)
            .with_signer_seeds(&[sponsor_seeds, table_seeds])
            .create(TABLE_SPACE)?;
        let table = Table { id, host: accounts.host.key(), nonce: 0, pending: false, die: 0, fulfilled: 0, bump: table_bump[0] };
        let mut data = accounts.table.try_borrow_mut_data()?;
        table.try_serialize(&mut &mut data[..])?;
        Ok(())
    }

    /// ER only. The host closes it; the rent goes back to the sponsor.
    pub fn close_table(ctx: Context<TableLifecycle>, id: u64) -> Result<()> {
        let accounts = &ctx.accounts;
        require_keys_eq!(*accounts.table.owner, ID, SpikeError::NotHost);
        let table = Table::try_deserialize(&mut &accounts.table.try_borrow_data()?[..])?;
        require!(table.id == id && table.host == accounts.host.key(), SpikeError::NotHost);
        let sponsor_bump = [accounts.sponsor.bump];
        let sponsor_seeds: &[&[u8]] = &[SPONSOR_SEED, &sponsor_bump];
        EphemeralAccount::new(&accounts.sponsor.to_account_info(), &accounts.table, &accounts.vault)
            .with_signer_seeds(&[sponsor_seeds])
            .close()?;
        Ok(())
    }

    /// Base layer. Anyone may sweep SOL someone sent to an unused table address (which would stop the
    /// ER from creating the table there); the caller keeps it.
    pub fn unblock_table(ctx: Context<UnblockTable>, id: u64) -> Result<()> {
        let table = &ctx.accounts.table;
        require_keys_eq!(*table.owner, anchor_lang::system_program::ID, SpikeError::NotHost);
        require!(table.data_is_empty(), SpikeError::NotHost);
        let bump = [ctx.bumps.table];
        let id_bytes = id.to_le_bytes();
        let seeds: &[&[u8]] = &[TABLE_SEED, &id_bytes, &bump];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer { from: table.to_account_info(), to: ctx.accounts.caller.to_account_info() },
                &[seeds],
            ),
            table.lamports(),
        )
    }

    pub fn request_roll(ctx: Context<RequestRoll>) -> Result<()> {
        let table = &mut ctx.accounts.table;
        require!(!table.pending, SpikeError::StaleRequest);
        table.nonce = table.nonce.checked_add(1).ok_or(SpikeError::Overflow)?;
        table.pending = true;
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeRoll::DISCRIMINATOR.to_vec(),
            caller_seed: caller_seed(table.key(), table.nonce),
            accounts_metas: Some(vec![SerializableAccountMeta { pubkey: table.key(), is_signer: false, is_writable: true }]),
            callback_args: Some(table.nonce.to_le_bytes().to_vec()),
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn consume_roll(ctx: Context<ConsumeRoll>, randomness: [u8; 32], nonce: u64) -> Result<()> {
        let table = &mut ctx.accounts.table;
        require!(table.pending && table.nonce == nonce, SpikeError::StaleRequest);
        table.die = ephemeral_vrf_sdk::rnd::random_u8_with_range(&randomness, 1, 6);
        table.pending = false;
        table.fulfilled = table.fulfilled.checked_add(1).ok_or(SpikeError::Overflow)?;
        Ok(())
    }
}

fn caller_seed(table: Pubkey, nonce: u64) -> [u8; 32] {
    let mut seed = table.to_bytes();
    seed[..8].copy_from_slice(&nonce.to_le_bytes());
    seed
}

#[account]
pub struct Sponsor {
    pub bump: u8,
}

#[account]
pub struct Table {
    pub id: u64,
    pub host: Pubkey,
    pub nonce: u64,
    pub pending: bool,
    pub die: u8,
    pub fulfilled: u32,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitSponsor<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + 1, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: Account<'info, Sponsor>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSponsor<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    /// CHECK: Fixed-seed sponsor PDA; the DLP takes ownership.
    #[account(mut, del, seeds = [SPONSOR_SEED], bump)]
    pub sponsor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct TableLifecycle<'info> {
    pub host: Signer<'info>,
    #[account(mut, seeds = [SPONSOR_SEED], bump = sponsor.bump)]
    pub sponsor: Account<'info, Sponsor>,
    /// CHECK: The table PDA; created or closed through the magic program.
    #[account(mut, seeds = [TABLE_SEED, &id.to_le_bytes()], bump)]
    pub table: AccountInfo<'info>,
    /// CHECK: Ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: AccountInfo<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct UnblockTable<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: The table PDA while it is a plain system account on base.
    #[account(mut, seeds = [TABLE_SEED, &id.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.id.to_le_bytes()], bump = table.bump)]
    pub table: Account<'info, Table>,
    /// CHECK: Canonical public queue.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE, owner = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeRoll<'info> {
    #[account(mut, seeds = [TABLE_SEED, &table.id.to_le_bytes()], bump = table.bump)]
    pub table: Account<'info, Table>,
}

#[error_code]
pub enum SpikeError {
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Callback does not match the pending request")]
    StaleRequest,
    #[msg("Only the host may close the table")]
    NotHost,
}
