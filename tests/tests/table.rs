//! Runs the production SBF (`target/deploy/bankroll.so`, build G2 first) with real SPL Token CPIs.
//! Delegation records, ER account ownership, eATA custody and the VRF identity signature are
//! fixtures. Requests run against the real VRF program (`tests/fixtures/vrf_program.so`, dumped
//! from devnet) and a copy of the ER queue (`tests/fixtures/ephemeral_queue.bin`); no oracle runs
//! here, so callbacks are delivered by the scoped identity with signature verification disabled.
use anchor_lang::{
    prelude::AccountMeta, AccountDeserialize, AccountSerialize, InstructionData, Space,
    ToAccountMetas,
};
use bankroll::{
    custody_address, treasury_address, Stage, Table, TablePhase, VrfPurpose, ADMIN, NO_OWNER,
    REFUND_GRACE_SECONDS, TABLE_SEED, TABLE_SPACE, USDC_MINT,
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_interface::state::{Account as TokenAccount, AccountState};
use std::path::PathBuf;

const USDC: u64 = 1_000_000;
const ESPL: Address = ephemeral_rollups_sdk::consts::ESPL_TOKEN_PROGRAM_ID;
const T0: i64 = 10_000;

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: bankroll::ID, accounts: accounts.to_account_metas(None), data: data.data() }
}
fn ata(owner: Address) -> Address {
    Address::find_program_address(
        &[owner.as_ref(), spl_token_interface::ID.as_ref(), USDC_MINT.as_ref()],
        &ephemeral_rollups_sdk::consts::ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}
fn record(table: Address) -> Address {
    ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&table)
}
fn set_data(svm: &mut LiteSVM, address: Address, owner: Address, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
        .unwrap();
}
/// A live delegation record of `delegated` (owned by `owner`) to the public validator.
fn set_public_record(svm: &mut LiteSVM, delegated: Address, owner: Address) {
    let mut data = 100u64.to_le_bytes().to_vec();
    data.extend_from_slice(bankroll::PUBLIC_VALIDATOR.as_ref());
    data.extend_from_slice(owner.as_ref());
    data.extend_from_slice(&[0; 24]);
    set_data(svm, record(delegated), ephemeral_rollups_sdk::id(), data);
}
/// The wallet's eATA as the ER shows it, plus its delegation record (what projects the ATA here).
fn set_custody(svm: &mut LiteSVM, owner: Address) {
    let mut data = owner.to_bytes().to_vec();
    data.extend_from_slice(USDC_MINT.as_ref());
    data.extend_from_slice(&[0; 16]);
    set_data(svm, custody_address(owner), ESPL, data);
    set_public_record(svm, custody_address(owner), ESPL);
}
/// The delegation record of the wallet's eATA, which `payable` reads.
fn custody_record(owner: Address) -> Address {
    record(custody_address(owner))
}
fn set_token(svm: &mut LiteSVM, owner: Address, mint: Address, amount: u64, frozen: bool) {
    let token = TokenAccount {
        mint,
        owner,
        amount,
        state: if frozen { AccountState::Frozen } else { AccountState::Initialized },
        ..TokenAccount::default()
    };
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(token, &mut data).unwrap();
    set_data(svm, ata(owner), spl_token_interface::ID, data);
    set_custody(svm, owner);
}
fn balance(svm: &LiteSVM, owner: Address) -> u64 {
    svm.get_account(&ata(owner))
        .filter(|account| !account.data.is_empty())
        .map_or(0, |account| TokenAccount::unpack(&account.data).unwrap().amount)
}

struct Harness {
    svm: LiteSVM,
    payer: Keypair,
    players: Vec<Keypair>,
    table: Address,
    treasury: Address,
}

impl Harness {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_sigverify(false);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        svm.add_program_from_file(bankroll::ID, root.join("target/deploy/bankroll.so"))
            .expect("build the production SBF first (gate G2)");
        svm.add_program_from_file(ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID, root.join("tests/fixtures/vrf_program.so"))
            .unwrap();
        let queue = std::fs::read(root.join("tests/fixtures/ephemeral_queue.bin")).unwrap();
        set_data(&mut svm, ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE, ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID, queue);
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        let (table, bump) = Address::find_program_address(&[TABLE_SEED, &7u16.to_le_bytes()], &bankroll::ID);
        let treasury = treasury_address();
        let mut h = Self { svm, payer, players: (0..4).map(|_| Keypair::new()).collect(), table, treasury };
        h.write(&Table { index: 7, bump, ..Table::default() });
        set_public_record(&mut h.svm, table, bankroll::ID);
        set_token(&mut h.svm, table, USDC_MINT, 0, false);
        set_token(&mut h.svm, treasury, USDC_MINT, 0, false);
        for player in &h.players {
            // Players hold USDC but zero lamports; the network fee payer is separate.
            set_token(&mut h.svm, player.pubkey(), USDC_MINT, USDC, false);
        }
        h.clock(T0);
        h
    }
    fn clock(&mut self, now: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = now;
        self.svm.set_sysvar(&clock);
    }
    fn read(&self) -> Table {
        Table::try_deserialize(&mut self.svm.get_account(&self.table).unwrap().data.as_slice()).unwrap()
    }
    fn write(&mut self, table: &Table) {
        let mut data = Vec::new();
        table.try_serialize(&mut data).unwrap();
        data.resize(TABLE_SPACE, 0);
        set_data(&mut self.svm, self.table, bankroll::ID, data);
    }
    fn wallet(&self, seat: usize) -> Address {
        self.players[seat].pubkey()
    }
    fn send(&mut self, signers: &[&Keypair], instruction: Instruction) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let mut all = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(&[instruction], Some(&self.payer.pubkey()), &all, self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
    }
    /// Delivers a VRF callback as the scoped identity (signature verification is off).
    fn callback(&mut self, signer: Address, randomness: [u8; 32], nonce: u64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let mut instruction = ix(
            bankroll::accounts::ConsumeRandomness { vrf_program_identity: signer, table: self.table },
            bankroll::instruction::ConsumeRandomness { randomness, request_nonce: nonce },
        );
        instruction.accounts[0].is_signer = true;
        self.svm.expire_blockhash();
        let mut tx = Transaction::new_with_payer(&[instruction], Some(&self.payer.pubkey()));
        tx.message.recent_blockhash = self.svm.latest_blockhash();
        self.svm.send_transaction(tx)
    }
    fn enter(&self, seat: usize, data: impl InstructionData) -> Instruction {
        let player = self.wallet(seat);
        ix(
            bankroll::accounts::EnterTable {
                player,
                table: self.table,
                delegation_record: record(self.table),
                player_token: ata(player),
                table_token: ata(self.table),
                table_eata: custody_address(self.table),
                player_eata: custody_address(player),
                token_program: spl_token_interface::ID,
            },
            data,
        )
    }
    fn open(&mut self, players: u8, target: u64) {
        let open = self.enter(0, bankroll::instruction::OpenTable { name: "Host".into(), entry: USDC, max_players: players, target, theme: 0 });
        let host = self.players[0].insecure_clone();
        self.send(&[&host], open).unwrap();
    }
    fn join(&mut self, seat: usize, nonce: u64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let join = self.enter(seat, bankroll::instruction::JoinTable { expected_nonce: nonce, name: format!("P{seat}") });
        let player = self.players[seat].insecure_clone();
        self.send(&[&player], join)
    }
    fn action(&mut self, seat: usize, data: impl InstructionData) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let signer = self.players[seat].insecure_clone();
        let action = ix(bankroll::accounts::TableAction { signer: signer.pubkey(), table: self.table }, data);
        self.send(&[&signer], action)
    }
    fn roll_ix(&self, seat: usize) -> Instruction {
        ix(
            bankroll::accounts::RequestRandomness {
                payer: self.wallet(seat),
                table: self.table,
                oracle_queue: ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE,
                program_identity: Address::find_program_address(&[b"identity"], &bankroll::ID).0,
                vrf_program: ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID,
                slot_hashes: ephemeral_vrf_sdk::compat::slot_hashes::ID,
                system_program: Address::default(),
            },
            bankroll::instruction::Roll {},
        )
    }
    fn roll(&mut self, seat: usize) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let signer = self.players[seat].insecure_clone();
        let roll = self.roll_ix(seat);
        self.send(&[&signer], roll)
    }
    fn settle_ix(&self) -> Instruction {
        let mut instruction = ix(
            bankroll::accounts::Settle {
                table: self.table,
                delegation_record: record(self.table),
                table_token: ata(self.table),
                table_eata: custody_address(self.table),
                treasury_token: ata(self.treasury),
                treasury_eata: custody_address(self.treasury),
                token_program: spl_token_interface::ID,
            },
            bankroll::instruction::Settle {},
        );
        let table = self.read();
        for seat in &table.seats[..table.player_count as usize] {
            instruction.accounts.push(AccountMeta::new(ata(seat.wallet), false));
            instruction.accounts.push(AccountMeta::new_readonly(custody_record(seat.wallet), false));
        }
        instruction
    }
    /// A refund with the seat's ATA writable, as clients send it when the account is live.
    fn refund_ix(&self, seat: u8) -> Instruction {
        let mut instruction = self.closed_refund_ix(seat);
        instruction.accounts[3].is_writable = true;
        instruction
    }
    /// A refund with the seat's ATA read-only, as clients send it when the account is gone.
    fn closed_refund_ix(&self, seat: u8) -> Instruction {
        let wallet = self.read().seats[seat as usize].wallet;
        ix(
            bankroll::accounts::RefundPlayer {
                table: self.table,
                delegation_record: record(self.table),
                table_token: ata(self.table),
                player_token: ata(wallet),
                table_eata: custody_address(self.table),
                player_custody_record: custody_record(wallet),
                treasury_token: ata(self.treasury),
                treasury_eata: custody_address(self.treasury),
                token_program: spl_token_interface::ID,
            },
            bankroll::instruction::RefundPlayer { seat },
        )
    }
    /// `withdraw_fees` signed by `admin` (signature verification is off, so ADMIN needs no key).
    fn withdraw_fees(&mut self, admin: Address, admin_token: Address, amount: u64) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let instruction = ix(
            bankroll::accounts::WithdrawFees {
                admin,
                treasury: self.treasury,
                treasury_token: ata(self.treasury),
                treasury_eata: custody_address(self.treasury),
                admin_token,
                admin_eata: custody_address(ADMIN),
                token_program: spl_token_interface::ID,
            },
            bankroll::instruction::WithdrawFees { amount },
        );
        self.unsigned(&[instruction])
    }
    /// Sends with every non-payer signer flag set but no signatures (sigverify is off).
    fn unsigned(&mut self, instructions: &[Instruction]) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let mut tx = Transaction::new_with_payer(instructions, Some(&self.payer.pubkey()));
        tx.message.recent_blockhash = self.svm.latest_blockhash();
        self.svm.send_transaction(tx)
    }
    fn snapshot(&self) -> Vec<Vec<u8>> {
        let mut keys = vec![self.table, ata(self.table), ata(self.treasury)];
        keys.extend(self.players.iter().map(|player| ata(player.pubkey())));
        keys.iter().map(|key| self.svm.get_account(key).unwrap_or_default().data).collect()
    }
    /// Opens a 3-player lobby with real entry transfers, then fixtures a started game with turn
    /// order equal to seat order (the start VRF request needs the live oracle).
    fn playing(&mut self, players: usize, target: u64) {
        self.open(players as u8, target);
        for seat in 1..players {
            self.join(seat, 1).unwrap();
        }
        let mut table = self.read();
        table.phase = TablePhase::Playing;
        table.stage = Stage::PreRoll;
        table.stage_deadline = T0 + 30;
        table.order = [0, 1, 2, 3];
        table.round = 1;
        for seat in &mut table.seats[..players] {
            seat.cash = 2000;
        }
        self.write(&table);
    }
    fn finish(&mut self, cash: &[i64]) {
        let mut table = self.read();
        for (seat, value) in table.seats.iter_mut().zip(cash) {
            seat.cash = *value;
        }
        table.phase = TablePhase::Finished;
        table.stage = Stage::Idle;
        table.ended_at = table.last_action_at;
        self.write(&table);
    }
}

fn close(svm: &mut LiteSVM, address: Address) {
    svm.set_account(address, Account::default()).unwrap();
}

fn die(value: u8) -> [u8; 32] {
    let mut randomness = [0u8; 32];
    randomness[..8].copy_from_slice(&((value - 1) as u64).to_le_bytes());
    randomness
}

fn scoped_identity() -> Address {
    ephemeral_vrf_sdk::consts::scoped_vrf_identity(&bankroll::ID)
}

#[test]
fn zero_sol_players_open_join_and_settle_the_exact_three_player_split() {
    let mut h = Harness::new();
    h.open(3, 2500);
    assert!(h.join(1, 0).is_err(), "stale invite nonce");
    h.join(1, 1).unwrap();
    h.join(2, 1).unwrap();
    assert!(h.join(3, 1).is_err(), "table full");
    assert_eq!(balance(&h.svm, h.table), 3 * USDC);
    assert_eq!(h.read().game_nonce, 1);
    for seat in 0..3 {
        assert_eq!(balance(&h.svm, h.wallet(seat)), 0);
        assert_eq!(h.svm.get_balance(&h.wallet(seat)).unwrap_or(0), 0, "players never hold lamports");
    }
    let mut table = h.read();
    table.phase = TablePhase::Playing;
    table.stage = Stage::Rolling;
    table.vrf_purpose = VrfPurpose::Roll;
    table.order = [2, 0, 1, 3];
    table.seats[2].cash = 2_350;
    table.seats[2].position = 27;
    table.seats[0].cash = 2_200;
    table.seats[1].cash = 2_100;
    h.write(&table);
    h.callback(scoped_identity(), die(1), table.vrf_nonce).unwrap();
    assert_eq!(h.read().phase, TablePhase::Finished, "salary lifts seat 2 to the $2.5k target");

    let settle = h.settle_ix();
    let result = h.send(&[], settle.clone()).unwrap();
    eprintln!("settle CU {}", result.compute_units_consumed);
    assert!(result.compute_units_consumed < 200_000, "settle CU {}", result.compute_units_consumed);
    assert_eq!(balance(&h.svm, h.wallet(2)), 2_010_000);
    assert_eq!(balance(&h.svm, h.wallet(0)), 900_000);
    assert_eq!(balance(&h.svm, h.wallet(1)), 0);
    assert_eq!(balance(&h.svm, h.treasury), 90_000);
    assert_eq!(balance(&h.svm, h.table), 0);
    let table = h.read();
    assert_eq!(table.phase, TablePhase::Free);
    assert_eq!([table.seats[0].payout, table.seats[1].payout, table.seats[2].payout], [900_000, 0, 2_010_000]);
    let before = h.snapshot();
    assert!(h.send(&[], settle).is_err(), "settle is single use");
    assert_eq!(before, h.snapshot());
}

#[test]
fn four_seat_settle_with_ties_fits_and_sweeps_dust_and_strays_to_the_treasury() {
    let mut h = Harness::new();
    h.playing(4, 7000);
    let mut token = TokenAccount::unpack(&h.svm.get_account(&ata(h.table)).unwrap().data).unwrap();
    token.amount += 123;
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(token, &mut data).unwrap();
    set_data(&mut h.svm, ata(h.table), spl_token_interface::ID, data);
    h.finish(&[4000, 4000, 4000, 1000]);
    let settle = h.settle_ix();
    let result = h.send(&[], settle).unwrap();
    eprintln!("settle CU {}", result.compute_units_consumed);
    assert!(result.compute_units_consumed < 200_000, "settle CU {}", result.compute_units_consumed);
    for seat in 0..3 {
        assert_eq!(balance(&h.svm, h.wallet(seat)), 1_293_333);
    }
    assert_eq!(balance(&h.svm, h.wallet(3)), 0);
    assert_eq!(balance(&h.svm, h.treasury), 4 * USDC + 123 - 3 * 1_293_333);
    assert_eq!(balance(&h.svm, h.table), 0);
}

#[test]
fn lobby_cancel_refunds_every_entry_exactly_once_and_frees_the_table() {
    let mut h = Harness::new();
    h.open(4, 5000);
    h.join(1, 1).unwrap();
    assert!(h.action(1, bankroll::instruction::CancelOrExpire {}).is_err(), "guest cannot cancel early");
    h.action(0, bankroll::instruction::CancelOrExpire {}).unwrap();
    assert!(h.join(2, 1).is_err());
    for seat in [1u8, 0] {
        let refund = h.refund_ix(seat);
        h.send(&[], refund.clone()).unwrap();
        assert!(h.send(&[], refund).is_err(), "double refund");
        assert_eq!(balance(&h.svm, h.wallet(seat as usize)), USDC);
    }
    assert_eq!(balance(&h.svm, h.table), 0);
    assert_eq!(balance(&h.svm, h.treasury), 0);
    assert_eq!(h.read().phase, TablePhase::Free);

    h.open(2, 2500);
    h.clock(T0 + 600);
    h.action(1, bankroll::instruction::CancelOrExpire {}).unwrap();
    assert_eq!(h.read().phase, TablePhase::Refunding, "anyone may expire a stale lobby");
}

#[test]
fn substituted_custody_recipient_treasury_or_mint_cannot_take_funds() {
    let mut h = Harness::new();
    h.playing(3, 2500);
    h.finish(&[3000, 2000, 1000]);
    let attacker = Keypair::new().pubkey();
    set_token(&mut h.svm, attacker, USDC_MINT, 0, false);
    let base = h.settle_ix();
    let mut cases = Vec::new();
    for index in [2usize, 3, 4, 5, 7, 8] {
        let mut instruction = base.clone();
        instruction.accounts[index].pubkey = match index {
            2 | 4 | 7 => ata(attacker),
            8 => custody_record(attacker),
            _ => custody_address(attacker),
        };
        cases.push(instruction);
    }
    let mut short = base.clone();
    short.accounts.truncate(base.accounts.len() - 2);
    cases.push(short);
    for instruction in cases {
        let before = h.snapshot();
        assert!(h.send(&[], instruction.clone()).is_err(), "{:?}", instruction.accounts);
        assert_eq!(before, h.snapshot());
    }
    let first = h.wallet(0);
    set_token(&mut h.svm, first, Address::new_unique(), 0, false);
    let before = h.snapshot();
    assert!(h.send(&[], base).is_err(), "wrong-mint recipient");
    assert_eq!(before, h.snapshot());

    let mut table = h.read();
    table.phase = TablePhase::Refunding;
    table.seats[0].payout = 2_010_000;
    h.write(&table);
    set_token(&mut h.svm, first, USDC_MINT, 0, false);
    let mut refund = h.refund_ix(0);
    refund.accounts[3].pubkey = ata(attacker);
    refund.accounts[5].pubkey = custody_record(attacker);
    let mut treasury = h.refund_ix(0);
    treasury.accounts[6].pubkey = ata(attacker);
    treasury.accounts[7].pubkey = custody_address(attacker);
    // Even after the refund grace, another wallet's accounts never count as the seat's.
    for now in [T0, T0 + 30 + REFUND_GRACE_SECONDS] {
        h.clock(now);
        for instruction in [refund.clone(), treasury.clone()] {
            let before = h.snapshot();
            assert!(h.send(&[], instruction).is_err(), "refund to another wallet");
            assert_eq!(before, h.snapshot());
        }
    }
}

#[test]
fn money_instructions_reject_base_clones_missing_records_and_foreign_custody() {
    for case in 0..5 {
        let mut h = Harness::new();
        let mut open = h.enter(0, bankroll::instruction::OpenTable { name: "Host".into(), entry: USDC, max_players: 2, target: 2500, theme: 0 });
        match case {
            0 => h.svm.set_account(record(h.table), Account::default()).unwrap(),
            1 => {
                let mut account = h.svm.get_account(&record(h.table)).unwrap();
                account.data[8..40].copy_from_slice(Address::new_unique().as_ref());
                h.svm.set_account(record(h.table), account).unwrap();
            }
            2 => {
                // The base copy of a delegated table is DLP-owned.
                let mut account = h.svm.get_account(&h.table).unwrap();
                account.owner = ephemeral_rollups_sdk::id();
                h.svm.set_account(h.table, account).unwrap();
            }
            3 => {
                let mut account = h.svm.get_account(&custody_address(h.table)).unwrap();
                account.owner = ephemeral_rollups_sdk::id();
                h.svm.set_account(custody_address(h.table), account).unwrap();
            }
            _ => open.accounts[5].pubkey = custody_address(h.wallet(1)),
        }
        let before = h.snapshot();
        let host = h.players[0].insecure_clone();
        assert!(h.send(&[&host], open).is_err(), "case {case}");
        assert_eq!(before, h.snapshot(), "case {case}");
    }
}

#[test]
fn spoofed_or_stale_vrf_callbacks_are_rejected_and_the_genuine_one_drives_play() {
    let mut h = Harness::new();
    h.playing(2, 7000);
    let roll = ix(
        bankroll::accounts::RequestRandomness {
            payer: h.wallet(0),
            table: h.table,
            oracle_queue: ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE,
            program_identity: Address::find_program_address(&[b"identity"], &bankroll::ID).0,
            vrf_program: ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID,
            slot_hashes: ephemeral_vrf_sdk::compat::slot_hashes::ID,
            system_program: Address::default(),
        },
        bankroll::instruction::Roll {},
    );
    let host = h.players[0].insecure_clone();
    let queue = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE;
    let mut account = h.svm.get_account(&queue).unwrap();
    account.owner = Address::default();
    h.svm.set_account(queue, account).unwrap();
    let before = h.snapshot();
    assert!(h.send(&[&host], roll).is_err(), "the oracle queue must be VRF-owned on the ER");
    assert_eq!(before, h.snapshot());

    // Fixture the state `roll` leaves behind: Rolling with request nonce 5.
    let mut table = h.read();
    table.stage = Stage::Rolling;
    table.vrf_purpose = VrfPurpose::Roll;
    table.vrf_nonce = 5;
    h.write(&table);
    let before = h.snapshot();
    let attacker = Keypair::new().pubkey();
    assert!(h.callback(attacker, die(1), 5).is_err(), "impostor identity");
    let mut unsigned = ix(
        bankroll::accounts::ConsumeRandomness { vrf_program_identity: scoped_identity(), table: h.table },
        bankroll::instruction::ConsumeRandomness { randomness: die(1), request_nonce: 5 },
    );
    unsigned.accounts[0].is_signer = false;
    assert!(h.send(&[], unsigned).is_err(), "unsigned identity");
    assert!(h.callback(scoped_identity(), die(1), 4).is_err(), "stale nonce");
    assert_eq!(before, h.snapshot());

    h.callback(scoped_identity(), die(1), 5).unwrap();
    let table = h.read();
    assert_eq!((table.seats[0].position, table.stage, table.vrf_purpose), (1, Stage::BuyDecision, VrfPurpose::None));
    assert!(h.callback(scoped_identity(), die(1), 5).is_err(), "replay");
    assert!(h.action(1, bankroll::instruction::Buy {}).is_err(), "not seat 1's decision");
    h.action(0, bankroll::instruction::Buy {}).unwrap();
    let table = h.read();
    assert_eq!((table.board[1].owner, table.seats[0].cash, table.turn), (0, 1940, 1));

    h.clock(table.stage_deadline - 1);
    assert!(h.action(0, bankroll::instruction::ForceTimeout {}).is_err());
    h.clock(table.stage_deadline);
    h.action(0, bankroll::instruction::ForceTimeout {}).unwrap();
    let table = h.read();
    assert_eq!((table.seats[1].strikes, table.turn, table.round), (1, 0, 2));
}

#[test]
fn a_reused_table_carries_no_state_from_the_previous_game() {
    let mut h = Harness::new();
    h.playing(3, 5000);
    let mut table = h.read();
    table.board[1].owner = 2;
    table.board[23].buildings = 2;
    table.seats[1].strikes = 2;
    table.seats[2].eliminated_at = 1;
    table.elimination_seq = 1;
    table.vrf_nonce = 9;
    table.last_roll = 6;
    table.trade.space = 12;
    h.write(&table);
    h.finish(&[5000, 2000, 0]);
    let settle = h.settle_ix();
    h.send(&[], settle).unwrap();
    for seat in 0..4 {
        let wallet = h.wallet(seat);
        set_token(&mut h.svm, wallet, USDC_MINT, USDC, false);
    }
    h.clock(T0 + 50);
    let open = h.enter(3, bankroll::instruction::OpenTable { name: "Next".into(), entry: USDC, max_players: 2, target: 2500, theme: 0 });
    let host = h.players[3].insecure_clone();
    h.send(&[&host], open).unwrap();
    let table = h.read();
    let mut expected = Table {
        index: 7,
        bump: table.bump,
        game_nonce: 2,
        vrf_nonce: 9,
        phase: TablePhase::Lobby,
        host: h.wallet(3),
        entry: USDC,
        max_players: 2,
        target: 2500,
        player_count: 1,
        lobby_deadline: T0 + 50 + 600,
        last_action_at: T0 + 50,
        ..Table::default()
    };
    expected.seats[0].wallet = h.wallet(3);
    expected.seats[0].name = *b"Next\0\0\0\0\0\0\0\0\0\0\0\0";
    assert_eq!(table, expected);
    assert!(table.board.iter().all(|lot| lot.owner == NO_OWNER && lot.buildings == 0));
    let account = h.svm.get_account(&h.table).unwrap();
    assert!(account.data[8 + bankroll::Table::INIT_SPACE..].iter().all(|byte| *byte == 0), "reserved tail stays zero");
    assert!(h.join(0, 1).is_err(), "the previous game's invite is stale");
    h.join(0, 2).unwrap();
}

#[test]
fn emergency_refund_pays_ranked_shares_when_settle_keeps_failing() {
    let mut h = Harness::new();
    h.playing(3, 2500);
    h.finish(&[3500, 2000, 1000]);
    set_token(&mut h.svm, h.treasury, USDC_MINT, 0, true);
    let settle = h.settle_ix();
    let before = h.snapshot();
    assert!(h.send(&[], settle.clone()).is_err(), "a frozen treasury makes settle fail");
    assert_eq!(before, h.snapshot());
    let last = h.read().last_action_at;
    h.clock(last + 3600 + 1800 - 1);
    assert!(h.action(1, bankroll::instruction::ForceTimeout {}).is_err());
    h.clock(last + 3600 + 1800);
    h.action(1, bankroll::instruction::ForceTimeout {}).unwrap();
    assert_eq!(h.read().phase, TablePhase::Refunding);
    assert!(h.send(&[], settle).is_err(), "no settle after the emergency switch");
    // The zero-payout seat is done at the switch, so its closed accounts never matter.
    let loser = h.wallet(2);
    close(&mut h.svm, ata(loser));
    close(&mut h.svm, custody_record(loser));
    assert!(h.read().seats[2].refunded);
    assert!(h.send(&[], h.closed_refund_ix(2)).is_err(), "nothing left to refund");
    set_token(&mut h.svm, h.treasury, USDC_MINT, 0, false);
    for (seat, expected) in [(0u8, 2_010_000), (1, 900_000)] {
        let refund = h.refund_ix(seat);
        h.send(&[], refund.clone()).unwrap();
        assert!(h.send(&[], refund).is_err(), "double refund");
        assert_eq!(balance(&h.svm, h.wallet(seat as usize)), expected, "ranked share, never the entry");
    }
    assert_eq!(balance(&h.svm, h.table), 0, "the last refund sweeps the fee out of custody");
    assert_eq!(balance(&h.svm, h.treasury), 90_000);
    assert_eq!(h.read().phase, TablePhase::Free);
}

#[test]
fn a_losing_seat_cannot_block_settle_by_closing_its_token_accounts() {
    let mut h = Harness::new();
    h.playing(2, 2500);
    h.finish(&[3500, 1000]);
    let loser = h.wallet(1);
    close(&mut h.svm, ata(loser));
    close(&mut h.svm, custody_record(loser));
    let settle = h.settle_ix();
    h.send(&[], settle).unwrap();
    assert_eq!(balance(&h.svm, h.wallet(0)), 1_940_000);
    assert_eq!(balance(&h.svm, h.treasury), 60_000);
    assert_eq!(balance(&h.svm, h.table), 0);
    assert_eq!(h.read().phase, TablePhase::Free);
}

/// Randomness that rolls `value` and, on a Lucky space, draws card `card` (1-12), matching the
/// program's `sha256(r, "card") % 12`.
fn die_and_card(value: u8, card: u8) -> [u8; 32] {
    let mut randomness = die(value);
    for counter in 0u64.. {
        randomness[8..16].copy_from_slice(&counter.to_le_bytes());
        let hash = solana_sha256_hasher::hashv(&[&randomness, b"card"]).to_bytes();
        if u64::from_le_bytes(hash[..8].try_into().unwrap()) % 12 == card as u64 - 1 {
            return randomness;
        }
    }
    unreachable!()
}

#[test]
fn a_late_callback_after_a_vrf_re_request_fails_and_a_jailed_roll_skips_the_oracle() {
    let mut h = Harness::new();
    h.playing(2, 7000);
    let result = h.roll(0).unwrap();
    eprintln!("roll request CU {}", result.compute_units_consumed);
    let first = h.read();
    assert_eq!((first.stage, first.vrf_purpose), (Stage::Rolling, VrfPurpose::Roll));
    assert_eq!(h.svm.get_balance(&h.wallet(0)).unwrap_or(0), 0, "the zero-SOL roller paid nothing");

    h.clock(T0 + 14);
    let before = h.snapshot();
    assert!(h.roll(0).is_err(), "no re-request before the VRF timeout");
    assert_eq!(before, h.snapshot());
    h.clock(T0 + 15);
    h.roll(0).unwrap();
    let retried = h.read();
    assert_eq!(retried.vrf_nonce, first.vrf_nonce + 1, "the re-request bumps the nonce");
    let before = h.snapshot();
    assert!(h.callback(scoped_identity(), die(1), first.vrf_nonce).is_err(), "late callback for the voided request");
    assert_eq!(before, h.snapshot());
    h.callback(scoped_identity(), die(1), retried.vrf_nonce).unwrap();
    assert_eq!((h.read().seats[0].position, h.read().stage), (1, Stage::BuyDecision));
    h.action(0, bankroll::instruction::Pass {}).unwrap();

    // Seat 1 is jailed: its roll serves the turn and sends no VRF request.
    let mut table = h.read();
    table.seats[1].jail_turns = 2;
    table.seats[1].position = 7;
    h.write(&table);
    let queue = h.svm.get_account(&ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE).unwrap().data;
    h.roll(1).unwrap();
    let table = h.read();
    assert_eq!((table.seats[1].jail_turns, table.seats[1].position, table.turn), (1, 7, 0));
    assert_eq!((table.vrf_nonce, table.vrf_purpose), (retried.vrf_nonce, VrfPurpose::None));
    assert_eq!(queue, h.svm.get_account(&ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE).unwrap().data, "no request queued");
}

#[test]
fn bankruptcy_and_forfeit_rank_through_settle() {
    let mut h = Harness::new();
    h.playing(4, 7000);
    // Seat 0 lands on seat 1's full-Dark-Blue Tokyo with 3 buildings ($1,050) holding $100: bankrupt.
    let mut table = h.read();
    table.board[25] = bankroll::Lot { owner: 1, buildings: 3 };
    table.board[26].owner = 1;
    table.board[27].owner = 1;
    table.board[1].owner = 0;
    table.seats[0].cash = 100;
    table.seats[0].position = 22;
    table.seats[3].strikes = 2;
    h.write(&table);
    h.roll(0).unwrap();
    h.callback(scoped_identity(), die(3), h.read().vrf_nonce).unwrap();
    let table = h.read();
    assert_eq!((table.seats[0].eliminated_at, table.board[1].owner, table.turn), (1, NO_OWNER, 1));
    assert_eq!(table.seats[1].cash, 2000 + 1050);

    // Seats 1 and 2 time out once; seat 3's third strike forfeits it.
    for _ in 0..3 {
        let deadline = h.read().stage_deadline;
        h.clock(deadline);
        h.action(1, bankroll::instruction::ForceTimeout {}).unwrap();
    }
    let table = h.read();
    assert_eq!((table.seats[3].eliminated_at, table.elimination_seq, table.phase), (2, 2, TablePhase::Playing));

    // Nobody acts for an hour: the game ends by ranking.
    h.clock(table.last_action_at + 3600);
    h.action(2, bankroll::instruction::ForceTimeout {}).unwrap();
    assert_eq!(h.read().phase, TablePhase::Finished);
    let settle = h.settle_ix();
    h.send(&[], settle).unwrap();
    // 4 seats, pot 4.00: 60/27/10. Active seats by net worth, then the later elimination.
    for (seat, expected) in [(1, 2_400_000), (2, 1_080_000), (3, 400_000), (0, 0)] {
        assert_eq!(balance(&h.svm, h.wallet(seat)), expected, "seat {seat}");
    }
    assert_eq!(balance(&h.svm, h.treasury), 120_000);
    assert_eq!(balance(&h.svm, h.table), 0);
    assert_eq!(h.read().phase, TablePhase::Free);
}

#[test]
fn the_worst_case_roll_callback_fits_the_vrf_callback_budget() {
    // A 6 lands on Lucky Card (21) and every card is drawn in turn. The move cards add the heaviest
    // landing: card 10 moves seat 0 onto seat 1's Power Plant (all four publics, $100) and card 11
    // onto seat 1's Paris in a full Yellow group with 3 buildings ($780). Either rent takes seat 0
    // below -$500 and releases seven holdings. Three seats remain, so every end condition is evaluated.
    let mut worst = 0;
    for card in 1..=12u8 {
        let mut h = Harness::new();
        h.playing(4, 7000);
        let mut table = h.read();
        for space in [18usize, 19, 20] {
            table.board[space] = bankroll::Lot { owner: 1, buildings: 3 };
        }
        for space in [3usize, 10, 17, 24] {
            table.board[space].owner = 1;
        }
        for space in [1usize, 2, 4, 5, 6, 8, 9] {
            table.board[space] = bankroll::Lot { owner: 0, buildings: if space == 1 || space == 2 { 3 } else { 0 } };
        }
        for space in [11usize, 12, 13, 16] {
            table.board[space] = bankroll::Lot { owner: 2, buildings: 2 };
        }
        table.seats[0].cash = -450;
        table.seats[0].position = 15;
        table.stage = Stage::Rolling;
        table.vrf_purpose = VrfPurpose::Roll;
        h.write(&table);
        let result = h.callback(scoped_identity(), die_and_card(6, card), table.vrf_nonce).unwrap();
        let after = h.read();
        eprintln!("card {card}: consume_randomness CU {}", result.compute_units_consumed);
        if let Some((space, rent)) = match card {
            10 => Some((24, 100)),
            11 => Some((18, 780)),
            _ => None,
        } {
            assert_eq!((after.seats[0].position, after.seats[0].eliminated_at), (space, 1), "bankrupt on card {card} rent");
            assert_eq!(after.seats[1].cash, 2000 + rent);
            assert!(after.board.iter().all(|lot| lot.owner != 0));
            assert_eq!(after.turn, 1);
        }
        worst = worst.max(result.compute_units_consumed);
    }
    eprintln!("worst consume_randomness CU {worst} (budget 200,000; VRF callback cap ~272,000)");
    assert!(worst < 200_000, "worst-case callback CU {worst}");
}

#[test]
fn an_accepted_trade_swaps_with_the_chosen_seat_and_only_the_lander_or_active_seats_act() {
    let mut h = Harness::new();
    h.playing(4, 7000);
    // Seat 0 holds Seoul; seat 1 Lisbon; seat 2 Berlin; seat 3 was eliminated (its holdings released).
    let mut table = h.read();
    for (space, owner) in [(11usize, 0u8), (1, 1), (12, 2)] {
        table.board[space].owner = owner;
    }
    table.seats[3].eliminated_at = 1;
    table.seats[3].cash = 0;
    table.elimination_seq = 1;
    table.seats[0].position = 12;
    h.write(&table);
    h.roll(0).unwrap();
    h.callback(scoped_identity(), die(2), h.read().vrf_nonce).unwrap();
    assert_eq!(h.read().stage, Stage::TradeOpen, "landing on Auction with tradeable holdings");
    assert!(h.action(1, bankroll::instruction::OpenTrade { space: 1 }).is_err(), "only the lander opens");
    h.action(0, bankroll::instruction::OpenTrade { space: 11 }).unwrap();

    h.action(1, bankroll::instruction::OfferTrade { space: 1 }).unwrap();
    h.action(2, bankroll::instruction::OfferTrade { space: 12 }).unwrap();
    let before = h.snapshot();
    assert!(h.action(3, bankroll::instruction::OfferTrade { space: 19 }).is_err(), "an eliminated seat cannot offer");
    assert!(h.action(1, bankroll::instruction::AcceptTrade { seat: 2, space: 12 }).is_err(), "a non-lander cannot accept");
    assert!(h.action(0, bankroll::instruction::AcceptTrade { seat: 1, space: 12 }).is_err(), "seat 1 never offered Berlin");
    assert_eq!(h.snapshot(), before, "rejected trade calls change nothing");

    let cash = h.read().seats.map(|seat| seat.cash);
    let accept = h.action(0, bankroll::instruction::AcceptTrade { seat: 2, space: 12 }).unwrap();
    eprintln!("accept_trade CU {}", accept.compute_units_consumed);
    let table = h.read();
    assert_eq!((table.board[11].owner, table.board[12].owner, table.board[1].owner), (2, 0, 1), "swapped with seat 2 only");
    assert_eq!(table.seats.map(|seat| seat.cash), [cash[0] + 100, cash[1], cash[2] + 100, cash[3]]);
    assert_eq!((table.stage, table.turn, table.trade), (Stage::PreRoll, 1, bankroll::Trade::default()));
}

#[test]
fn withdraw_fees_is_admin_only_capped_at_the_treasury_and_er_only() {
    let mut h = Harness::new();
    set_token(&mut h.svm, h.treasury, USDC_MINT, 500_000, false);
    set_token(&mut h.svm, ADMIN, USDC_MINT, 0, false);
    let stranger = h.wallet(1);
    let before = h.snapshot();
    assert!(h.withdraw_fees(stranger, ata(ADMIN), 100_000).is_err(), "non-admin signer");
    assert!(h.withdraw_fees(stranger, ata(stranger), 100_000).is_err(), "non-admin to its own account");
    assert!(h.withdraw_fees(ADMIN, ata(stranger), 100_000).is_err(), "admin to another wallet");
    assert!(h.withdraw_fees(ADMIN, ata(ADMIN), 0).is_err(), "zero");
    assert!(h.withdraw_fees(ADMIN, ata(ADMIN), 500_001).is_err(), "above the treasury balance");
    assert_eq!(before, h.snapshot());
    // On base the treasury custody is DLP-owned, so the ER-only guard rejects it.
    let mut eata = h.svm.get_account(&custody_address(h.treasury)).unwrap();
    let er_owner = eata.owner;
    eata.owner = ephemeral_rollups_sdk::id();
    h.svm.set_account(custody_address(h.treasury), eata.clone()).unwrap();
    assert!(h.withdraw_fees(ADMIN, ata(ADMIN), 100_000).is_err(), "base clone");
    eata.owner = er_owner;
    h.svm.set_account(custody_address(h.treasury), eata).unwrap();

    h.withdraw_fees(ADMIN, ata(ADMIN), 300_000).unwrap();
    assert_eq!((balance(&h.svm, ADMIN), balance(&h.svm, h.treasury)), (300_000, 200_000));
    h.withdraw_fees(ADMIN, ata(ADMIN), 200_000).unwrap();
    assert_eq!((balance(&h.svm, ADMIN), balance(&h.svm, h.treasury)), (500_000, 0));
    assert!(h.withdraw_fees(ADMIN, ata(ADMIN), 1).is_err(), "an empty treasury");
}

/// A Refunding seat whose token accounts are gone holds its share for the refund grace only;
/// then anyone may send it to the treasury, and the table returns to the pool with custody 0.
#[test]
fn a_closed_refund_account_cannot_keep_the_table_out_of_the_pool() {
    let mut h = Harness::new();
    h.open(3, 2500);
    h.join(1, 1).unwrap();
    h.join(2, 1).unwrap();
    h.action(0, bankroll::instruction::CancelOrExpire {}).unwrap();
    assert_eq!(h.read().stage_deadline, T0 + REFUND_GRACE_SECONDS);
    let gone = h.wallet(1);
    close(&mut h.svm, ata(gone));
    close(&mut h.svm, custody_record(gone));
    let before = h.snapshot();
    assert!(h.send(&[], h.closed_refund_ix(1)).is_err(), "the share waits for the grace");
    // A live seat cannot be pushed to the treasury by passing its ATA read-only.
    h.clock(T0 + REFUND_GRACE_SECONDS);
    assert!(h.send(&[], h.closed_refund_ix(0)).is_err(), "a live account must receive its refund");
    assert_eq!(before, h.snapshot());
    h.clock(T0);
    h.send(&[], h.refund_ix(0)).unwrap();
    h.send(&[], h.refund_ix(2)).unwrap();
    assert_eq!(h.read().phase, TablePhase::Refunding);
    h.clock(T0 + REFUND_GRACE_SECONDS);
    h.send(&[], h.closed_refund_ix(1)).unwrap();
    assert_eq!((balance(&h.svm, h.wallet(0)), balance(&h.svm, h.wallet(2))), (USDC, USDC));
    assert_eq!((balance(&h.svm, h.treasury), balance(&h.svm, h.table)), (USDC, 0));
    assert_eq!(h.read().phase, TablePhase::Free);
}

/// A paid seat whose ATA is no longer delegated here cannot block the others: they are paid, the
/// fee goes to the treasury, and the table waits in Refunding for that seat, which can still
/// collect. The seat undelegated its ATA, so the ER still shows a Token-owned, unfrozen ATA that
/// it will not write (passed read-only); only its eATA's delegation record is gone.
#[test]
fn settle_pays_the_live_seats_and_holds_an_undelegated_seats_share() {
    let mut h = Harness::new();
    h.playing(3, 2500);
    h.finish(&[3500, 2000, 1000]);
    let second = h.wallet(1);
    close(&mut h.svm, custody_record(second));
    let mut settle = h.settle_ix();
    settle.accounts[9].is_writable = false;
    h.clock(T0 + 5);
    h.send(&[], settle).unwrap();
    assert_eq!(balance(&h.svm, h.wallet(0)), 2_010_000);
    assert_eq!((balance(&h.svm, h.treasury), balance(&h.svm, h.table)), (90_000, 900_000));
    let table = h.read();
    assert_eq!((table.phase, table.stage_deadline), (TablePhase::Refunding, T0 + 5 + REFUND_GRACE_SECONDS));
    assert_eq!(table.seats[..3].iter().map(|seat| (seat.payout, seat.refunded)).collect::<Vec<_>>(),
        [(2_010_000, true), (900_000, false), (0, true)]);
    // The seat recreates its accounts and collects its ranked share before the grace ends.
    set_token(&mut h.svm, second, USDC_MINT, 0, false);
    h.send(&[], h.refund_ix(1)).unwrap();
    assert_eq!((balance(&h.svm, second), balance(&h.svm, h.table)), (900_000, 0));
    assert_eq!(h.read().phase, TablePhase::Free);
}

/// Everyone left a 3-player game. After the idle deadline the returning current seat cannot act,
/// and one transaction from a fresh, unseated, zero-SOL wallet ends, ranks and settles the game.
#[test]
fn a_fresh_client_ends_ranks_and_settles_an_abandoned_game_in_one_transaction() {
    let mut h = Harness::new();
    h.playing(3, 7000);
    let mut table = h.read();
    table.seats[0].cash = 1_500;
    table.seats[1].cash = 2_400;
    table.seats[2].cash = 2_100;
    h.write(&table);
    let idle = table.last_action_at + 3600;
    h.clock(idle - 1);
    let before = h.snapshot();
    h.clock(idle);
    assert!(h.roll(0).is_err(), "the current seat cannot revive the game");
    assert!(h.action(0, bankroll::instruction::Pass {}).is_err());
    assert_eq!(before, h.snapshot());
    let fresh = Keypair::new();
    let timeout = ix(bankroll::accounts::TableAction { signer: fresh.pubkey(), table: h.table }, bankroll::instruction::ForceTimeout {});
    let settle = h.settle_ix();
    h.svm.expire_blockhash();
    // The ER charges no fee; LiteSVM does, so the harness payer covers it.
    let tx = Transaction::new_signed_with_payer(&[timeout, settle], Some(&h.payer.pubkey()), &[&h.payer, &fresh], h.svm.latest_blockhash());
    h.svm.send_transaction(tx).unwrap();
    let table = h.read();
    assert_eq!(table.phase, TablePhase::Free);
    assert!(table.seats[..3].iter().all(|seat| seat.strikes == 0 && seat.eliminated_at == 0), "nobody forfeited");
    assert_eq!([balance(&h.svm, h.wallet(0)), balance(&h.svm, h.wallet(1)), balance(&h.svm, h.wallet(2))], [0, 2_010_000, 900_000]);
    assert_eq!((balance(&h.svm, h.treasury), balance(&h.svm, h.table)), (90_000, 0));
}
