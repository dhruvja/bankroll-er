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
pub const TABLE_SEED: &[u8] = b"table_v2";
pub const TREASURY_SEED: &[u8] = b"treasury";

#[program]
pub mod bankroll {
    use super::*;

    pub fn create_table(ctx: Context<CreateTable>, index: u16) -> Result<()> {
        let table = &mut ctx.accounts.table;
        table.index = index;
        table.bump = ctx.bumps.table;
        // `init` zeroes the account, which would read as seat 0 owning every space.
        table.board = [Lot::default(); board::SPACES];
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
        theme: u8,
        start_cash: u64,
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
            theme,
            start_cash,
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

    /// Returns one seat's money from a Refunding table: the full entry with no fee, or the ranked
    /// payout when the game had finished. Anyone may send it; the money only ever goes to the
    /// seat's own canonical accounts. If those are gone, the share stays until the refund grace
    /// (`stage_deadline`) ends and then goes to the treasury, so a closed account cannot keep the
    /// table out of the pool. The refund that frees the table sweeps what custody still holds (a
    /// finished game's fee, stray deposits) to the treasury, so a Free table holds nothing.
    pub fn refund_player(mut ctx: Context<RefundPlayer>, seat: u8) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let grace_over = Clock::get()?.unix_timestamp >= ctx.accounts.table.stage_deadline;
        let (wallet, amount) = ctx.accounts.table.refund(seat as usize)?;
        let accounts = &mut ctx.accounts;
        if amount > 0 {
            let live = payable(wallet, &accounts.player_token, &accounts.player_custody_record)?;
            let destination = if live {
                accounts.player_token.to_account_info()
            } else {
                require!(grace_over, GameError::RecipientMissing);
                accounts.treasury_token.to_account_info()
            };
            transfer_from_table(
                &accounts.table,
                &accounts.table_token,
                destination,
                &accounts.token_program,
                amount,
            )?;
        }
        if accounts.table.phase == TablePhase::Free {
            accounts.table_token.reload()?;
            let rest = accounts.table_token.amount;
            if rest > 0 {
                let treasury = accounts.treasury_token.to_account_info();
                transfer_from_table(
                    &accounts.table,
                    &accounts.table_token,
                    treasury,
                    &accounts.token_program,
                    rest,
                )?;
            }
        }
        Ok(())
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

    /// Rolls (or re-requests a missing roll). A jailed seat's roll serves a jail turn and needs no
    /// randomness, so it sends no VRF request.
    pub fn roll(mut ctx: Context<RequestRandomness>) -> Result<()> {
        let accounts = &mut ctx.accounts;
        let needs_randomness = accounts
            .table
            .roll(accounts.payer.key(), Clock::get()?.unix_timestamp)?;
        if needs_randomness {
            let ix = vrf_request(accounts.payer.key(), &accounts.table);
            accounts.invoke_signed_vrf(&accounts.payer.to_account_info(), &ix)?;
        }
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

    pub fn build(ctx: Context<TableAction>, space: u8) -> Result<()> {
        ctx.accounts
            .table
            .build(ctx.accounts.signer.key(), space, Clock::get()?.unix_timestamp)
    }

    pub fn sell(ctx: Context<TableAction>, space: u8) -> Result<()> {
        ctx.accounts
            .table
            .sell(ctx.accounts.signer.key(), space, Clock::get()?.unix_timestamp)
    }

    /// The signer leaves the game; its properties go back on sale.
    pub fn forfeit(ctx: Context<TableAction>) -> Result<()> {
        ctx.accounts
            .table
            .forfeit(ctx.accounts.signer.key(), Clock::get()?.unix_timestamp)
    }

    pub fn pay_bail(ctx: Context<TableAction>) -> Result<()> {
        ctx.accounts
            .table
            .pay_bail(ctx.accounts.signer.key(), Clock::get()?.unix_timestamp)
    }

    pub fn open_trade(ctx: Context<TableAction>, space: u8) -> Result<()> {
        ctx.accounts
            .table
            .open_trade(ctx.accounts.signer.key(), space, Clock::get()?.unix_timestamp)
    }

    pub fn offer_trade(ctx: Context<TableAction>, space: u8) -> Result<()> {
        ctx.accounts
            .table
            .offer_trade(ctx.accounts.signer.key(), space, Clock::get()?.unix_timestamp)
    }

    /// The lander accepts `seat`'s current offer of `space`.
    pub fn accept_trade(ctx: Context<TableAction>, seat: u8, space: u8) -> Result<()> {
        ctx.accounts.table.accept_trade(
            ctx.accounts.signer.key(),
            seat,
            space,
            Clock::get()?.unix_timestamp,
        )
    }

    pub fn force_timeout(ctx: Context<TableAction>) -> Result<()> {
        ctx.accounts
            .table
            .force_timeout(Clock::get()?.unix_timestamp)
    }

    /// Pays every ranked share from table custody in one transaction, sweeps the fee, dust and
    /// any stray deposit to the treasury and frees the table. `remaining_accounts` holds (canonical
    /// ATA, delegation record of its eATA) for every seat, in seat order; only paid seats' accounts
    /// are read, so a seat with nothing to receive cannot block settlement. A paid seat whose
    /// accounts are gone or no longer delegated here cannot block it either: its share stays in
    /// custody and the table waits in Refunding for that seat alone.
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
        let (mut paid, mut owed, mut unpaid) = (0u64, 0u64, [false; MAX_SEATS]);
        for (seat, pair) in remaining.chunks(2).enumerate() {
            let payout = payouts[seat];
            if payout == 0 {
                continue;
            }
            if payable(ctx.accounts.table.seats[seat].wallet, &pair[0], &pair[1])? {
                transfer_from_table(
                    &ctx.accounts.table,
                    &ctx.accounts.table_token,
                    pair[0].clone(),
                    &ctx.accounts.token_program,
                    payout,
                )?;
                paid = paid.checked_add(payout).ok_or(GameError::Overflow)?;
            } else {
                unpaid[seat] = true;
                owed = owed.checked_add(payout).ok_or(GameError::Overflow)?;
            }
        }
        let fee = custody
            .checked_sub(paid)
            .and_then(|rest| rest.checked_sub(owed))
            .ok_or(GameError::Overflow)?;
        transfer_from_table(
            &ctx.accounts.table,
            &ctx.accounts.table_token,
            ctx.accounts.treasury_token.to_account_info(),
            &ctx.accounts.token_program,
            fee,
        )?;
        ctx.accounts.table_token.reload()?;
        require!(
            ctx.accounts.table_token.amount == owed,
            GameError::CustodyNotEmpty
        );
        ctx.accounts
            .table
            .record_settlement(payouts, unpaid, Clock::get()?.unix_timestamp);
        Ok(())
    }

    /// ADMIN moves accrued fees from the treasury custody to its own canonical account on the ER,
    /// capped at the treasury balance, then withdraws them through the Payments API.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        require!(
            amount > 0 && amount <= ctx.accounts.treasury_token.amount,
            GameError::InvalidAmount
        );
        let bump = [ctx.bumps.treasury];
        let seeds: &[&[u8]] = &[TREASURY_SEED, &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.treasury_token.to_account_info(),
                    to: ctx.accounts.admin_token.to_account_info(),
                    authority: ctx.accounts.treasury.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }
}

/// Whether `wallet`'s canonical USDC ATA can receive a payout on this ER. The ER projects that
/// ATA from the wallet's eATA and holds it (writable) only while the eATA is delegated to this
/// validator, so the proof is the eATA's live delegation record, not account owners: an owner
/// can undelegate the ATA and leave a Token-owned, read-only clone behind. False when that record
/// is gone or points elsewhere, or the ATA is closed or frozen. Any other address, mint or owner
/// is an error, so a caller can only ever show that the seat's own accounts are gone, never
/// redirect its money.
fn payable(wallet: Pubkey, token: &AccountInfo, custody_record: &AccountInfo) -> Result<bool> {
    require_keys_eq!(
        token.key(),
        get_associated_token_address(&wallet, &USDC_MINT),
        GameError::InvalidAccount
    );
    let custody = custody_address(wallet);
    require_keys_eq!(
        custody_record.key(),
        ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&custody),
        GameError::InvalidAccount
    );
    let live = delegated_to_public_er(custody_record, ESPL_TOKEN_PROGRAM_ID);
    if *token.owner != Token::id() || !live {
        return Ok(false);
    }
    let Ok(account) = TokenAccount::try_deserialize(&mut &token.try_borrow_data()?[..]) else {
        return Ok(false);
    };
    // A live canonical ATA always has this mint and owner; anything else is not the seat's account.
    require_keys_eq!(account.mint, USDC_MINT, GameError::InvalidAccount);
    require_keys_eq!(account.owner, wallet, GameError::InvalidAccount);
    Ok(!account.is_frozen())
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
    require!(
        delegated_to_public_er(record, crate::ID),
        GameError::InvalidAccount
    );
    Ok(())
}

/// Whether `record` is a live delegation record of an account owned by `owner` and delegated to
/// the public validator.
fn delegated_to_public_er(record: &AccountInfo, owner: Pubkey) -> bool {
    if *record.owner != ephemeral_rollups_sdk::id() {
        return false;
    }
    let Ok(data) = record.try_borrow_data() else {
        return false;
    };
    DelegationRecord::try_from_bytes_with_discriminator(&data)
        .is_ok_and(|record| record.authority == PUBLIC_VALIDATOR && record.owner == owner)
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
    /// CHECK: The seat's canonical USDC ATA, checked by `payable` when the refund is nonzero. Not
    /// `mut`: clients pass it writable when it is live and read-only when it is gone (the ER
    /// rejects writable accounts it does not hold), and a transfer to it needs it writable.
    pub player_token: UncheckedAccount<'info>,
    /// CHECK: Canonical public table custody on the ER.
    #[account(address = custody_address(table.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub table_eata: UncheckedAccount<'info>,
    /// CHECK: Delegation record of the seat's canonical eATA, checked by `payable`.
    pub player_custody_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&treasury_address(), &USDC_MINT), token::mint = USDC_MINT, constraint = treasury_token.owner == treasury_address() @ GameError::InvalidAccount)]
    pub treasury_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical shared protocol custody on the same ER.
    #[account(address = custody_address(treasury_address()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub treasury_eata: UncheckedAccount<'info>,
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

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(address = ADMIN)]
    pub admin: Signer<'info>,
    /// CHECK: Dataless PDA that owns the treasury custody and signs its transfers.
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&treasury.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = treasury)]
    pub treasury_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical shared protocol custody; restored to the ESPL program only on the ER.
    #[account(address = custody_address(treasury.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub treasury_eata: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&ADMIN, &USDC_MINT), token::mint = USDC_MINT, token::authority = admin)]
    pub admin_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: The admin's canonical public custody on the same ER.
    #[account(address = custody_address(ADMIN), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub admin_eata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[cfg(test)]
mod fuzz;
#[cfg(test)]
mod tests;
