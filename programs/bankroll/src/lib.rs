use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, Token, TokenAccount, Transfer},
};
use ephemeral_rollups_sdk::{
    anchor::delegate, consts::ESPL_TOKEN_PROGRAM_ID, cpi::DelegateConfig,
    dlp_api::state::DelegationRecord,
};
use ephemeral_vrf_sdk::{
    anchor::{vrf, vrf_callback},
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

#[rustfmt::skip]
pub mod board;
pub mod engine;
pub mod state;
pub use state::*;

declare_id!("72xAdhJ15tqVXZ95oKKxBYfEbJpJsDThcMCwwtonibEq");
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
pub const PUBLIC_VALIDATOR: Pubkey = pubkey!("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
pub const ADMIN: Pubkey = pubkey!("653bMLonrEbTNbSM9g1vH8PJATH1uh6wYNr9SYEJSzsY");
pub const TABLE_SEED: &[u8] = b"table_v1";
pub const TREASURY_SEED: &[u8] = b"treasury";

#[program]
pub mod bankroll {
    use super::*;

    pub fn create_table(ctx: Context<CreateTable>, index: u16) -> Result<()> {
        let table = &mut ctx.accounts.table;
        table.index = index;
        table.bump = ctx.bumps.table;
        Ok(())
    }

    pub fn delegate_table(ctx: Context<DelegateTable>, index: u16) -> Result<()> {
        ctx.accounts.delegate_table(
            &ctx.accounts.admin,
            &[TABLE_SEED, &index.to_le_bytes()],
            DelegateConfig {
                validator: Some(PUBLIC_VALIDATOR),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// A zero-SOL host claims a Free table and pays its own entry in the same instruction.
    pub fn open_table(
        mut ctx: Context<EnterTable>,
        name: String,
        entry: u64,
        max_players: u8,
        target: u64,
    ) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let now = Clock::get()?.unix_timestamp;
        let accounts = &mut ctx.accounts;
        accounts.table.open(
            accounts.player.key(),
            engine::encode_name(&name)?,
            entry,
            max_players,
            target,
            now,
        )?;
        pay_entry(accounts)
    }

    pub fn join_table(mut ctx: Context<EnterTable>, expected_nonce: u64, name: String) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let now = Clock::get()?.unix_timestamp;
        let accounts = &mut ctx.accounts;
        accounts.table.join(
            accounts.player.key(),
            engine::encode_name(&name)?,
            expected_nonce,
            now,
        )?;
        pay_entry(accounts)
    }

    pub fn cancel_or_expire(ctx: Context<TableAction>) -> Result<()> {
        ctx.accounts
            .table
            .cancel_or_expire(ctx.accounts.signer.key(), Clock::get()?.unix_timestamp)
    }

    /// Returns one full entry, with no fee, from a Refunding table.
    pub fn refund_player(ctx: Context<RefundPlayer>, seat: u8) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let wallet = ctx.accounts.table.refund(seat as usize)?;
        let player_token = &ctx.accounts.player_token;
        require_keys_eq!(player_token.owner, wallet, GameError::InvalidAccount);
        require_keys_eq!(
            player_token.key(),
            get_associated_token_address(&wallet, &USDC_MINT),
            GameError::InvalidAccount
        );
        transfer_from_table(
            &ctx.accounts.table,
            &ctx.accounts.table_token,
            player_token.to_account_info(),
            &ctx.accounts.token_program,
            ctx.accounts.table.entry,
        )
    }

    pub fn start_game(mut ctx: Context<RequestRandomness>) -> Result<()> {
        let accounts = &mut ctx.accounts;
        accounts
            .table
            .start(accounts.payer.key(), Clock::get()?.unix_timestamp)?;
        let ix = vrf_request(accounts.payer.key(), &accounts.table);
        accounts.invoke_signed_vrf(&accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn roll(mut ctx: Context<RequestRandomness>) -> Result<()> {
        let accounts = &mut ctx.accounts;
        accounts
            .table
            .roll(accounts.payer.key(), Clock::get()?.unix_timestamp)?;
        let ix = vrf_request(accounts.payer.key(), &accounts.table);
        accounts.invoke_signed_vrf(&accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn consume_randomness(
        ctx: Context<ConsumeRandomness>,
        randomness: [u8; 32],
        request_nonce: u64,
    ) -> Result<()> {
        ctx.accounts.table.consume_randomness(
            randomness,
            request_nonce,
            Clock::get()?.unix_timestamp,
        )
    }

    pub fn buy(ctx: Context<TableAction>) -> Result<()> {
        ctx.accounts
            .table
            .buy(ctx.accounts.signer.key(), Clock::get()?.unix_timestamp)
    }

    pub fn pass(ctx: Context<TableAction>) -> Result<()> {
        ctx.accounts
            .table
            .pass(ctx.accounts.signer.key(), Clock::get()?.unix_timestamp)
    }

    pub fn force_timeout(ctx: Context<TableAction>) -> Result<()> {
        ctx.accounts
            .table
            .force_timeout(Clock::get()?.unix_timestamp)
    }

    /// Pays every ranked share from table custody in one transaction, sweeps the fee, dust and
    /// any stray deposit to the treasury, requires custody to end at zero and frees the table.
    /// `remaining_accounts` holds (canonical ATA, eATA) for every seat, in seat order.
    pub fn settle<'info>(ctx: Context<'info, Settle<'info>>) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let payouts = ctx.accounts.table.payouts()?;
        let count = ctx.accounts.table.count();
        let custody = ctx.accounts.table_token.amount;
        require!(
            custody >= ctx.accounts.table.pot()?,
            GameError::CustodyShort
        );
        let remaining = ctx.remaining_accounts;
        require!(remaining.len() == count * 2, GameError::InvalidAccount);
        let mut paid = 0u64;
        for ((seat, payout), pair) in ctx.accounts.table.seats[..count]
            .iter()
            .zip(payouts)
            .zip(remaining.chunks(2))
        {
            let destination = Account::<TokenAccount>::try_from(&pair[0])?;
            require_keys_eq!(destination.mint, USDC_MINT, GameError::InvalidAccount);
            require_keys_eq!(destination.owner, seat.wallet, GameError::InvalidAccount);
            require_keys_eq!(
                pair[0].key(),
                get_associated_token_address(&seat.wallet, &USDC_MINT),
                GameError::InvalidAccount
            );
            require_keys_eq!(
                pair[1].key(),
                custody_address(seat.wallet),
                GameError::InvalidAccount
            );
            require_keys_eq!(*pair[1].owner, ESPL_TOKEN_PROGRAM_ID, GameError::InvalidAccount);
            if payout > 0 {
                transfer_from_table(
                    &ctx.accounts.table,
                    &ctx.accounts.table_token,
                    pair[0].clone(),
                    &ctx.accounts.token_program,
                    payout,
                )?;
            }
            paid = paid.checked_add(payout).ok_or(GameError::Overflow)?;
        }
        transfer_from_table(
            &ctx.accounts.table,
            &ctx.accounts.table_token,
            ctx.accounts.treasury_token.to_account_info(),
            &ctx.accounts.token_program,
            custody.checked_sub(paid).ok_or(GameError::Overflow)?,
        )?;
        ctx.accounts.table_token.reload()?;
        require!(
            ctx.accounts.table_token.amount == 0,
            GameError::CustodyNotEmpty
        );
        ctx.accounts.table.record_settlement(payouts);
        Ok(())
    }
}

fn pay_entry(accounts: &mut EnterTable) -> Result<()> {
    token::transfer(
        CpiContext::new(
            accounts.token_program.key(),
            Transfer {
                from: accounts.player_token.to_account_info(),
                to: accounts.table_token.to_account_info(),
                authority: accounts.player.to_account_info(),
            },
        ),
        accounts.table.entry,
    )
}

fn vrf_request(payer: Pubkey, table: &Account<Table>) -> anchor_lang::solana_program::instruction::Instruction {
    create_request_randomness_ix(RequestRandomnessParams {
        payer,
        oracle_queue: ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE,
        callback_program_id: ID,
        callback_discriminator: instruction::ConsumeRandomness::DISCRIMINATOR.to_vec(),
        caller_seed: solana_sha256_hasher::hashv(&[
            b"bankroll-vrf-v1",
            table.key().as_ref(),
            &table.vrf_nonce.to_le_bytes(),
        ])
        .to_bytes(),
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: table.key(),
            is_signer: false,
            is_writable: true,
        }]),
        callback_args: Some(table.vrf_nonce.to_le_bytes().to_vec()),
    })
}

/// On base a Table is DLP-owned (or not yet delegated). Only on the ER can its canonical
/// public-validator delegation record and a program-owned Table coexist.
fn require_public_er(record: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        *record.owner,
        ephemeral_rollups_sdk::id(),
        GameError::InvalidAccount
    );
    let data = record.try_borrow_data()?;
    let record = DelegationRecord::try_from_bytes_with_discriminator(&data)
        .map_err(|_| error!(GameError::InvalidAccount))?;
    require_keys_eq!(
        record.authority,
        PUBLIC_VALIDATOR,
        GameError::InvalidAccount
    );
    require_keys_eq!(record.owner, crate::ID, GameError::InvalidAccount);
    Ok(())
}

pub fn custody_address(owner: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), USDC_MINT.as_ref()], &ESPL_TOKEN_PROGRAM_ID).0
}

pub fn treasury_address() -> Pubkey {
    Pubkey::find_program_address(&[TREASURY_SEED], &crate::ID).0
}

fn transfer_from_table<'info>(
    table: &Account<'info, Table>,
    from: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let index = table.index.to_le_bytes();
    let bump = [table.bump];
    let seeds: &[&[u8]] = &[TABLE_SEED, &index, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to,
                authority: table.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct CreateTable<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = TABLE_SPACE, seeds = [TABLE_SEED, &index.to_le_bytes()], bump)]
    pub table: Box<Account<'info, Table>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(index: u16)]
pub struct DelegateTable<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    /// CHECK: Canonical table PDA, created by `create_table`; the DLP takes ownership.
    #[account(mut, del, seeds = [TABLE_SEED, &index.to_le_bytes()], bump)]
    pub table: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct EnterTable<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.index.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: Canonical live delegation record, validated by require_public_er.
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&table.key()))]
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&player.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = player)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&table.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = table)]
    pub table_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical public table custody restored to its original owner on the ER.
    #[account(address = custody_address(table.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub table_eata: UncheckedAccount<'info>,
    /// CHECK: Canonical public player custody on the same ER.
    #[account(address = custody_address(player.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub player_eata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TableAction<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.index.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
}

#[derive(Accounts)]
pub struct RefundPlayer<'info> {
    #[account(mut, seeds = [TABLE_SEED, &table.index.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: Canonical live delegation record, validated by require_public_er.
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&table.key()))]
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&table.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = table)]
    pub table_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = USDC_MINT)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical public table custody on the ER.
    #[account(address = custody_address(table.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub table_eata: UncheckedAccount<'info>,
    /// CHECK: Canonical public refund destination custody on the same ER.
    #[account(address = custody_address(player_token.owner), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub player_eata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, &table.index.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: Canonical public queue must be restored to VRF ownership on the ER.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE, owner = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeRandomness<'info> {
    #[account(mut, seeds = [TABLE_SEED, &table.index.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [TABLE_SEED, &table.index.to_le_bytes()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    /// CHECK: Canonical live delegation record, validated by require_public_er.
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&table.key()))]
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&table.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = table)]
    pub table_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical public table custody on the ER.
    #[account(address = custody_address(table.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub table_eata: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&treasury_address(), &USDC_MINT), token::mint = USDC_MINT, constraint = treasury_token.owner == treasury_address() @ GameError::InvalidAccount)]
    pub treasury_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical shared protocol custody on the same ER.
    #[account(address = custody_address(treasury_address()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub treasury_eata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[cfg(test)]
mod tests;
