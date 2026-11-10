use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    token::{self, Token, TokenAccount, Transfer},
};
use ephemeral_rollups_sdk::{
    anchor::delegate,
    consts::{EPHEMERAL_VAULT_ID, ESPL_TOKEN_PROGRAM_ID, MAGIC_PROGRAM_ID},
    cpi::DelegateConfig,
    dlp_api::state::DelegationRecord,
    ephemeral_accounts::{self, EphemeralAccount},
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
pub const TABLE_SEED: &[u8] = b"table_v3";
pub const HOUSE_SEED: &[u8] = b"house";
pub const TREASURY_SEED: &[u8] = b"treasury";

#[program]
pub mod bankroll {
    use super::*;

    /// ADMIN creates the house on base once. It is funded with SOL for table rent and delegated.
    pub fn init_house(ctx: Context<InitHouse>) -> Result<()> {
        ctx.accounts.house.bump = ctx.bumps.house;
        Ok(())
    }

    pub fn delegate_house(ctx: Context<DelegateHouse>) -> Result<()> {
        ctx.accounts.delegate_house(
            &ctx.accounts.admin,
            &[HOUSE_SEED],
            DelegateConfig {
                validator: Some(PUBLIC_VALIDATOR),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// A zero-SOL host opens its own table and pays its entry into the vault. On the host's first
    /// game, or after its table was closed, the house creates the table on the ER and gives it a
    /// fresh nonce range. Otherwise the host's Free table re-opens in place; a table still in a
    /// game cannot, so each wallet hosts one table at a time.
    pub fn open_table(
        mut ctx: Context<OpenTable>,
        name: String,
        entry: u64,
        max_players: u8,
        target: u64,
        theme: u8,
        start_cash: u64,
    ) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let now = Clock::get()?.unix_timestamp;
        let table_bump = ctx.bumps.table;
        let accounts = &mut ctx.accounts;
        let host = accounts.host.key();
        let info = accounts.table.to_account_info();
        let mut table = if *info.owner == crate::ID {
            Box::new(EphemeralTable::try_deserialize(&mut &info.try_borrow_data()?[..])?)
        } else {
            let house = accounts.house.to_account_info();
            let floor = Rent::get()?
                .minimum_balance(house.data_len())
                .checked_add(ephemeral_accounts::rent(TABLE_SPACE as u32))
                .ok_or(GameError::Overflow)?;
            require!(house.lamports() >= floor, GameError::HouseOutOfRent);
            let house_bump = [accounts.house.bump];
            let table_bump = [table_bump];
            let house_seeds: &[&[u8]] = &[HOUSE_SEED, &house_bump];
            let table_seeds: &[&[u8]] = &[TABLE_SEED, host.as_ref(), &table_bump];
            EphemeralAccount::new(&house, &info, &accounts.rent_vault)
                .with_signer_seeds(&[house_seeds, table_seeds])
                .create(TABLE_SPACE as u32)?;
            let nonce = accounts.house.next_table_nonce()?;
            Box::new(EphemeralTable::new(host, table_bump[0], nonce))
        };
        table.open(
            host,
            engine::encode_name(&name)?,
            entry,
            max_players,
            target,
            theme,
            start_cash,
            now,
        )?;
        table.credit(&mut accounts.house, table.entry)?;
        pay_entry(
            &accounts.host,
            &accounts.player_token,
            &accounts.vault_token,
            &accounts.token_program,
            table.entry,
        )?;
        let mut data = info.try_borrow_mut_data()?;
        table.try_serialize(&mut &mut data[..])
    }

    pub fn join_table(mut ctx: Context<JoinTable>, expected_nonce: u64, name: String) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let now = Clock::get()?.unix_timestamp;
        let accounts = &mut ctx.accounts;
        accounts.table.join(
            accounts.player.key(),
            engine::encode_name(&name)?,
            expected_nonce,
            now,
        )?;
        let entry = accounts.table.entry;
        accounts.table.credit(&mut accounts.house, entry)?;
        pay_entry(
            &accounts.player,
            &accounts.player_token,
            &accounts.vault_token,
            &accounts.token_program,
            entry,
        )
    }

    /// Anyone closes a Free table that holds nothing once the grace after its last game has
    /// passed. The ER-only account is deleted and its rent goes back to the house.
    pub fn close_table(ctx: Context<CloseTable>) -> Result<()> {
        let accounts = &ctx.accounts;
        let info = accounts.table.to_account_info();
        let table = Box::new(EphemeralTable::try_deserialize(&mut &info.try_borrow_data()?[..])?);
        let address = Pubkey::create_program_address(
            &[TABLE_SEED, table.host.as_ref(), &[table.bump]],
            &crate::ID,
        )
        .map_err(|_| GameError::InvalidAccount)?;
        require_keys_eq!(info.key(), address, GameError::InvalidAccount);
        table.require_closable(Clock::get()?.unix_timestamp)?;
        let house_bump = [accounts.house.bump];
        let house_seeds: &[&[u8]] = &[HOUSE_SEED, &house_bump];
        EphemeralAccount::new(&accounts.house.to_account_info(), &info, &accounts.rent_vault)
            .with_signer_seeds(&[house_seeds])
            .close()?;
        Ok(())
    }

    /// Base layer. SOL sent to a host's table address before the table exists makes the ER clone
    /// a funded system account there, and the magic program then refuses to create the table, so
    /// that wallet could never host. Anyone may sweep that SOL to themselves to clear the address.
    pub fn unblock_table(ctx: Context<UnblockTable>, host: Pubkey) -> Result<()> {
        let table = &ctx.accounts.table;
        let lamports = table.lamports();
        require!(
            *table.owner == anchor_lang::system_program::ID && table.data_is_empty() && lamports > 0,
            GameError::TableNotBlocked
        );
        let bump = [ctx.bumps.table];
        let seeds: &[&[u8]] = &[TABLE_SEED, host.as_ref(), &bump];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: table.to_account_info(),
                    to: ctx.accounts.caller.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
        )
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
    /// table from being freed. The refund that frees the table sends what it still holds (a
    /// finished game's fee and dust) to the treasury, so a Free table holds nothing.
    pub fn refund_player(mut ctx: Context<RefundPlayer>, seat: u8) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let now = Clock::get()?.unix_timestamp;
        let accounts = &mut ctx.accounts;
        let grace_over = now >= accounts.table.stage_deadline;
        let (wallet, amount) = accounts.table.refund(seat as usize, now)?;
        if amount > 0 {
            let live = payable(wallet, &accounts.player_token, &accounts.player_custody_record)?;
            let destination = if live {
                accounts.player_token.to_account_info()
            } else {
                require!(grace_over, GameError::RecipientMissing);
                accounts.treasury_token.to_account_info()
            };
            pay_from_vault(
                &mut accounts.table,
                &mut accounts.house,
                &accounts.vault_token,
                destination,
                &accounts.token_program,
                amount,
            )?;
        }
        if accounts.table.phase == TablePhase::Free && accounts.table.held > 0 {
            let rest = accounts.table.held;
            let treasury = accounts.treasury_token.to_account_info();
            pay_from_vault(
                &mut accounts.table,
                &mut accounts.house,
                &accounts.vault_token,
                treasury,
                &accounts.token_program,
                rest,
            )?;
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

    /// Pays every ranked share from the vault in one transaction, sends the fee and dust to the
    /// treasury and frees the table. `remaining_accounts` holds (canonical ATA, delegation record
    /// of its eATA) for every seat, in seat order; only paid seats' accounts are read, so a seat
    /// with nothing to receive cannot block settlement. A paid seat whose accounts are gone or no
    /// longer delegated here cannot block it either: the table keeps holding its share and waits
    /// in Refunding for that seat alone.
    pub fn settle<'info>(mut ctx: Context<'info, Settle<'info>>) -> Result<()> {
        require_public_er(&ctx.accounts.delegation_record)?;
        let remaining = ctx.remaining_accounts;
        let accounts = &mut ctx.accounts;
        let payouts = accounts.table.payouts()?;
        let count = accounts.table.count();
        require!(
            accounts.table.held == accounts.table.pot()?,
            GameError::CustodyShort
        );
        require!(remaining.len() == count * 2, GameError::InvalidAccount);
        let (mut owed, mut unpaid) = (0u64, [false; MAX_SEATS]);
        for (seat, pair) in remaining.chunks(2).enumerate() {
            let payout = payouts[seat];
            if payout == 0 {
                continue;
            }
            if payable(accounts.table.seats[seat].wallet, &pair[0], &pair[1])? {
                pay_from_vault(
                    &mut accounts.table,
                    &mut accounts.house,
                    &accounts.vault_token,
                    pair[0].clone(),
                    &accounts.token_program,
                    payout,
                )?;
            } else {
                unpaid[seat] = true;
                owed = owed.checked_add(payout).ok_or(GameError::Overflow)?;
            }
        }
        let fee = accounts
            .table
            .held
            .checked_sub(owed)
            .ok_or(GameError::Overflow)?;
        let treasury = accounts.treasury_token.to_account_info();
        pay_from_vault(
            &mut accounts.table,
            &mut accounts.house,
            &accounts.vault_token,
            treasury,
            &accounts.token_program,
            fee,
        )?;
        accounts
            .table
            .record_settlement(payouts, unpaid, Clock::get()?.unix_timestamp)
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

fn pay_entry<'info>(
    player: &Signer<'info>,
    player_token: &Account<'info, TokenAccount>,
    vault_token: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    entry: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program.key(),
            Transfer {
                from: player_token.to_account_info(),
                to: vault_token.to_account_info(),
                authority: player.to_account_info(),
            },
        ),
        entry,
    )
}

/// Every transfer out of the shared vault goes through here: it is first debited from the acting
/// table's `held` and the house `liability`, so no table can pay out more than it holds.
fn pay_from_vault<'info>(
    table: &mut EphemeralTable,
    house: &mut Account<'info, House>,
    vault_token: &Account<'info, TokenAccount>,
    to: AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    table.debit(house, amount)?;
    let bump = [house.bump];
    let seeds: &[&[u8]] = &[HOUSE_SEED, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault_token.to_account_info(),
                to,
                authority: house.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

fn vrf_request(payer: Pubkey, table: &Account<EphemeralTable>) -> anchor_lang::solana_program::instruction::Instruction {
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

/// On base the house is DLP-owned. Only on the ER can its canonical public-validator delegation
/// record and a program-owned house coexist.
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

pub fn house_address() -> Pubkey {
    Pubkey::find_program_address(&[HOUSE_SEED], &crate::ID).0
}

pub fn table_address(host: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TABLE_SEED, host.as_ref()], &crate::ID).0
}

#[derive(Accounts)]
pub struct InitHouse<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = HOUSE_SPACE, seeds = [HOUSE_SEED], bump)]
    pub house: Account<'info, House>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateHouse<'info> {
    #[account(mut, address = ADMIN)]
    pub admin: Signer<'info>,
    /// CHECK: Canonical house PDA, created by `init_house`; the DLP takes ownership.
    #[account(mut, del, seeds = [HOUSE_SEED], bump)]
    pub house: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OpenTable<'info> {
    pub host: Signer<'info>,
    /// CHECK: The host's table, missing or an EphemeralTable; `open_table` creates or
    /// deserializes it. Only this program can sign for the address, so only it can create it.
    #[account(mut, seeds = [TABLE_SEED, host.key().as_ref()], bump)]
    pub table: UncheckedAccount<'info>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    /// CHECK: The house's canonical live delegation record, validated by require_public_er.
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&house.key()))]
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&host.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = host)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&house.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = house)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical public vault custody restored to its original owner on the ER.
    #[account(address = custody_address(house.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub vault_eata: UncheckedAccount<'info>,
    /// CHECK: Canonical public player custody on the same ER.
    #[account(address = custody_address(host.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub player_eata: UncheckedAccount<'info>,
    /// CHECK: The ER's ephemeral rent vault; the magic program checks it.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub rent_vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, called only to create a missing table.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct JoinTable<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.host.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, EphemeralTable>>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    /// CHECK: The house's canonical live delegation record, validated by require_public_er.
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&house.key()))]
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&player.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = player)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&house.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = house)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical public vault custody restored to its original owner on the ER.
    #[account(address = custody_address(house.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub vault_eata: UncheckedAccount<'info>,
    /// CHECK: Canonical public player custody on the same ER.
    #[account(address = custody_address(player.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub player_eata: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseTable<'info> {
    /// CHECK: An EphemeralTable; `close_table` deserializes it and checks its address.
    #[account(mut, owner = crate::ID)]
    pub table: UncheckedAccount<'info>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    /// CHECK: The ER's ephemeral rent vault; the magic program checks it.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub rent_vault: UncheckedAccount<'info>,
    /// CHECK: The magic program, which deletes the table.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(host: Pubkey)]
pub struct UnblockTable<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: The host's table address while base shows it as a funded system account; the
    /// handler checks the owner, data and lamports.
    #[account(mut, seeds = [TABLE_SEED, host.as_ref()], bump)]
    pub table: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TableAction<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.host.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, EphemeralTable>>,
}

#[derive(Accounts)]
pub struct RefundPlayer<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.host.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, EphemeralTable>>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    /// CHECK: The house's canonical live delegation record, validated by require_public_er.
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&house.key()))]
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&house.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = house)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: The seat's canonical USDC ATA, checked by `payable` when the refund is nonzero. Not
    /// `mut`: clients pass it writable when it is live and read-only when it is gone (the ER
    /// rejects writable accounts it does not hold), and a transfer to it needs it writable.
    pub player_token: UncheckedAccount<'info>,
    /// CHECK: Canonical public vault custody on the ER.
    #[account(address = custody_address(house.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub vault_eata: UncheckedAccount<'info>,
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
    #[account(mut, seeds = [TABLE_SEED, table.host.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, EphemeralTable>>,
    /// CHECK: Canonical public queue must be restored to VRF ownership on the ER.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE, owner = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeRandomness<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.host.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, EphemeralTable>>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.host.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, EphemeralTable>>,
    #[account(mut, seeds = [HOUSE_SEED], bump = house.bump)]
    pub house: Account<'info, House>,
    /// CHECK: The house's canonical live delegation record, validated by require_public_er.
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&house.key()))]
    pub delegation_record: UncheckedAccount<'info>,
    #[account(mut, address = get_associated_token_address(&house.key(), &USDC_MINT), token::mint = USDC_MINT, token::authority = house)]
    pub vault_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical public vault custody on the ER.
    #[account(address = custody_address(house.key()), owner = ESPL_TOKEN_PROGRAM_ID)]
    pub vault_eata: UncheckedAccount<'info>,
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
