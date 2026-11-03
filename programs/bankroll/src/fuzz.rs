//! G5: invariant fuzzing of the real engine. 10,000 games replay on one reused `Table` value:
//! 9,000 games of `sim.py`'s greedy bots (1,000 per player count and target, for the game-length
//! comparison with `sim.py --no-trades`) and 1,000 chaos games of random, often illegal,
//! actions with random timeouts, VRF retries, late callbacks and emergency refunds.
//!
//! `cargo test --release -p bankroll fuzz_ -- --ignored --nocapture`
use super::board::*;
use super::engine::encode_name;
use super::*;

const PARITY_GAMES: usize = 1_000;
const CHAOS_GAMES: usize = 1_000;
const MAX_STEPS: usize = 200_000;
/// `sim.py --no-trades` (5,000 games each, seed 20261103): players, target, p50, p95, p99 rounds.
const SIM_NO_TRADES: [(usize, u64, u32, u32, u32); 9] = [
    (2, 3000, 22, 38, 46),
    (2, 5000, 59, 95, 111),
    (2, 7000, 96, 154, 181),
    (3, 3000, 17, 28, 35),
    (3, 5000, 46, 75, 90),
    (3, 7000, 74, 124, 142),
    (4, 3000, 14, 24, 29),
    (4, 5000, 39, 69, 82),
    (4, 7000, 62, 116, 133),
];
/// Sanity band for the comparison: p50, p95 and p99 each within 10% of the simulator.
const BAND: f64 = 0.10;

/// What the chaos games exercised, printed so a vacuous run is visible.
#[derive(Default, Debug)]
struct ChaosStats {
    accepted: u64,
    rejected: u64,
    stale_callbacks_rejected: u64,
    lobby_refunds: u64,
    by_target: u64,
    last_standing: u64,
    idle_ranking: u64,
    ordering_refunds: u64,
    emergency_refunds: u64,
}

/// SplitMix64: deterministic, dependency-free.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn bytes(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.next().to_le_bytes());
        }
        out
    }
    fn wallet(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.bytes())
    }
}

/// Money conservation for one finished or refunded game: every atom of the pot is paid to a seat,
/// kept as the fee, or is rounding dust smaller than the seat count.
fn assert_conserved(pot: u64, paid: u64, finished: bool, context: &str) {
    if !finished {
        assert_eq!(paid, pot, "{context}: an unfinished game refunds every entry");
        return;
    }
    let fee = pot * FEE_BPS / 10_000;
    assert!(paid + fee <= pot, "{context}: payouts {paid} exceed pot {pot} minus fee");
    let dust = pot - fee - paid;
    assert!(dust < MAX_SEATS as u64, "{context}: dust {dust}");
}

/// Structural invariants that hold after every successful instruction.
fn assert_consistent(table: &Table, context: &str) {
    let n = table.count();
    for (space, lot) in table.board.iter().enumerate() {
        let spec = BOARD[space];
        if lot.owner != NO_OWNER {
            assert!(matches!(spec.kind, SpaceKind::City | SpaceKind::Public), "{context}: owned non-property {space}");
            assert!(table.is_active(lot.owner as usize), "{context}: space {space} owned by an inactive seat");
        }
        assert!(lot.buildings <= MAX_BUILDINGS, "{context}: buildings");
        if lot.buildings > 0 {
            assert!(spec.kind == SpaceKind::City && lot.owner != NO_OWNER, "{context}: stray buildings on {space}");
        }
    }
    for seat in 0..n {
        let state = &table.seats[seat];
        assert!((state.position as usize) < SPACES && state.jail_turns <= JAIL_TURNS, "{context}");
        if !table.is_active(seat) {
            assert_eq!(state.cash, 0, "{context}: eliminated cash is discarded");
            assert!(state.eliminated_at <= table.elimination_seq, "{context}: unclosed elimination mark");
        }
    }
    if table.phase != TablePhase::Playing {
        assert_eq!(table.vrf_purpose, VrfPurpose::None, "{context}: VRF pending outside play");
        return;
    }
    let pending = matches!(table.stage, Stage::Ordering | Stage::Rolling);
    assert!(
        matches!(table.stage, Stage::Ordering | Stage::PreRoll | Stage::Rolling | Stage::BuyDecision),
        "{context}: stage {:?}",
        table.stage
    );
    assert_eq!(pending, table.vrf_purpose != VrfPurpose::None, "{context}: VRF pending only while waiting");
    if table.stage == Stage::Ordering {
        return;
    }
    let active: Vec<usize> = (0..n).filter(|&seat| table.is_active(seat)).collect();
    assert!(active.len() >= 2, "{context}: play continued with {} active seats", active.len());
    assert!(table.is_active(table.current_seat()), "{context}: the turn belongs to an eliminated seat");
    assert!(table.rolls_this_turn <= MAX_ROLLS_PER_TURN, "{context}");
    for &seat in &active {
        let worth = table.net_worth(seat);
        assert!(worth > 0 && table.seats[seat].cash >= BANKRUPT_CASH_BELOW, "{context}: seat {seat} should be bankrupt");
        assert!(worth < table.target as i64, "{context}: seat {seat} reached the target without ending the game");
    }
}

/// After `open`, the table equals a freshly created one apart from identity, nonces and config.
fn assert_fresh(table: &Table, index: u16, bump: u8, game_nonce: u64, vrf_nonce: u64, host: Pubkey, host_name: [u8; NAME_LEN]) {
    let mut fresh = Table {
        index,
        bump,
        game_nonce,
        vrf_nonce,
        phase: TablePhase::Lobby,
        host,
        entry: table.entry,
        max_players: table.max_players,
        target: table.target,
        player_count: 1,
        lobby_deadline: table.lobby_deadline,
        last_action_at: table.last_action_at,
        ..Table::default()
    };
    fresh.seats[0].wallet = host;
    fresh.seats[0].name = host_name;
    assert_eq!(*table, fresh, "state survived the reset");
}

/// Opens the reused table and seats `players`, checking the reset.
fn seat_players(table: &mut Table, rng: &mut Rng, players: usize, max_players: u8, target: u64, entry: u64, now: i64) -> Vec<Pubkey> {
    let wallets: Vec<Pubkey> = (0..players).map(|_| rng.wallet()).collect();
    let (index, bump, game_nonce, vrf_nonce) = (table.index, table.bump, table.game_nonce, table.vrf_nonce);
    let host_name = encode_name("host").unwrap();
    table.open(wallets[0], host_name, entry, max_players, target, now).unwrap();
    assert_fresh(table, index, bump, game_nonce + 1, vrf_nonce, wallets[0], host_name);
    for wallet in &wallets[1..] {
        table.join(*wallet, encode_name("guest").unwrap(), table.game_nonce, now).unwrap();
    }
    wallets
}

/// Settles a finished table (or runs the emergency refund) and checks conservation.
fn close_out(table: &mut Table, rng: &mut Rng, now: &mut i64, emergency: bool, context: &str) {
    let pot = table.pot().unwrap();
    if table.phase == TablePhase::Finished && !emergency {
        let payouts = table.payouts().unwrap();
        assert_conserved(pot, payouts.iter().sum(), true, context);
        table.record_settlement(payouts);
    } else {
        let finished = table.phase == TablePhase::Finished;
        if finished {
            *now = (table.last_action_at + IDLE_SECONDS).max(table.ended_at) + EMERGENCY_SECONDS + rng.below(5) as i64;
            table.force_timeout(*now).unwrap();
        }
        assert_eq!(table.phase, TablePhase::Refunding, "{context}");
        let mut paid = 0;
        for seat in 0..table.count() {
            paid += table.refund(seat).unwrap().1;
        }
        assert_conserved(pot, paid, finished, context);
    }
    assert_eq!(table.phase, TablePhase::Free, "{context}: the table returns to the pool");
}

/// `sim.py`'s greedy bot for one PreRoll: sell out of negative cash, build, then bail or roll.
/// Returns false once its turn is over (a sale bankrupted it or the game ended).
fn bot_preroll(table: &mut Table, now: i64) -> bool {
    let seat = table.current_seat();
    let wallet = table.seats[seat].wallet;
    while table.seats[seat].cash < 0 {
        let sale = (0..SPACES)
            .filter(|&space| table.board[space].owner as usize == seat)
            .min_by_key(|&space| (table.board[space].buildings > 0, BOARD[space].price));
        let Some(space) = sale else { break };
        table.sell(wallet, space as u8, now).unwrap();
        if table.phase != TablePhase::Playing || !table.is_active(seat) {
            return false;
        }
    }
    loop {
        let build = (0..SPACES)
            .filter(|&space| {
                let spec = BOARD[space];
                spec.kind == SpaceKind::City
                    && table.board[space].owner as usize == seat
                    && table.board[space].buildings < MAX_BUILDINGS
                    && table.seats[seat].cash - spec.building_cost >= 150
                    && table.owns_group(seat, spec.group)
            })
            .min_by_key(|&space| (table.board[space].buildings, -BOARD[space].rent));
        let Some(space) = build else { break };
        table.build(wallet, space as u8, now).unwrap();
    }
    true
}

/// One game of sim bots with no timeouts. Returns the final round.
fn parity_game(table: &mut Table, rng: &mut Rng, players: usize, target: u64, now: &mut i64) -> u32 {
    seat_players(table, rng, players, players as u8, target, 1_000_000, *now);
    let host = table.host;
    table.start(host, *now).unwrap();
    for step in 0.. {
        assert!(step < MAX_STEPS, "parity game did not end");
        *now += 1;
        match (table.phase, table.stage) {
            (TablePhase::Playing, Stage::Ordering | Stage::Rolling) => {
                table.consume_randomness(rng.bytes(), table.vrf_nonce, *now).unwrap();
            }
            (TablePhase::Playing, Stage::PreRoll) => {
                if !bot_preroll(table, *now) {
                    continue;
                }
                let seat = table.current_seat();
                let wallet = table.seats[seat].wallet;
                if table.seats[seat].jail_turns > 0 && table.seats[seat].cash >= 500 {
                    table.pay_bail(wallet, *now).unwrap();
                } else {
                    table.roll(wallet, *now).unwrap();
                }
            }
            (TablePhase::Playing, Stage::BuyDecision) => {
                let seat = table.current_seat();
                let wallet = table.seats[seat].wallet;
                let price = BOARD[table.seats[seat].position as usize].price;
                if table.seats[seat].cash - price >= 100 {
                    table.buy(wallet, *now).unwrap();
                } else {
                    table.pass(wallet, *now).unwrap();
                }
            }
            (TablePhase::Finished, _) => break,
            other => panic!("parity game stuck in {other:?}"),
        }
        assert_consistent(table, "parity");
    }
    let round = table.round;
    close_out(table, rng, now, false, "parity");
    round
}

/// One chaos game: random callers, random (often illegal) instructions, random clock jumps.
/// Every rejected instruction must leave the table byte-for-byte unchanged.
fn chaos_game(table: &mut Table, rng: &mut Rng, game: usize, now: &mut i64, stats: &mut ChaosStats) {
    let players = 2 + rng.below(3) as usize;
    let max_players = players as u8 + rng.below(MAX_SEATS as u64 + 1 - players as u64) as u8;
    let target = TARGETS[rng.below(3) as usize];
    let entry = ENTRIES[rng.below(3) as usize];
    let mut wallets = seat_players(table, rng, players, max_players, target, entry, *now);
    wallets.push(rng.wallet()); // A stranger.
    if rng.chance(5) {
        let caller = if rng.chance(50) { wallets[0] } else { wallets[1] };
        *now += if rng.chance(50) { LOBBY_SECONDS } else { 0 };
        if table.cancel_or_expire(caller, *now).is_ok() {
            close_out(table, rng, now, false, "lobby refund");
            stats.lobby_refunds += 1;
            return;
        }
    }
    table.start(wallets[0], *now).unwrap();
    let mut stale_nonces: Vec<u64> = Vec::new();
    for step in 0.. {
        let context = format!("chaos game {game} step {step}");
        assert!(step < MAX_STEPS, "{context}: did not end");
        if table.phase != TablePhase::Playing {
            break;
        }
        *now += match rng.below(100) {
            0..=79 => rng.below(4) as i64,
            80..=97 => rng.below(60) as i64,
            98 => rng.below(2 * IDLE_SECONDS as u64) as i64,
            _ => 0,
        };
        let caller = wallets[rng.below(wallets.len() as u64) as usize];
        let current = table.seats[table.current_seat()].wallet;
        // Bias towards the current seat so games progress.
        let actor = if rng.chance(70) { current } else { caller };
        let space = if rng.chance(80) { rng.below(SPACES as u64) as u8 } else { rng.below(256) as u8 };
        let before = table.clone();
        let pending = table.vrf_nonce;
        let result = match rng.below(100) {
            0..=29 => table.roll(actor, *now).map(|_| ()),
            30..=49 => {
                // The oracle answers the pending request, or a late/forged one arrives.
                let nonce = match rng.below(10) {
                    0 if !stale_nonces.is_empty() => stale_nonces[rng.below(stale_nonces.len() as u64) as usize],
                    1 => rng.next(),
                    _ => pending,
                };
                let late = nonce != pending;
                let result = table.consume_randomness(rng.bytes(), nonce, *now);
                if late {
                    assert!(result.is_err(), "{context}: a stale callback was accepted");
                    stats.stale_callbacks_rejected += 1;
                }
                result
            }
            50..=59 => table.buy(actor, *now),
            60..=64 => table.pass(actor, *now),
            65..=74 => table.build(actor, space, *now),
            75..=79 => table.sell(actor, space, *now),
            80..=84 => table.pay_bail(actor, *now),
            85..=96 => table.force_timeout(*now),
            97 => table.start(caller, *now),
            98 => table.join(caller, encode_name("late").unwrap(), table.game_nonce, *now),
            _ => table.refund(rng.below(MAX_SEATS as u64) as usize).map(|_| ()),
        };
        match result {
            Err(_) => {
                assert_eq!(*table, before, "{context}: a rejected instruction mutated the table");
                stats.rejected += 1;
            }
            Ok(()) => {
                stats.accepted += 1;
                if table.vrf_nonce != pending {
                    stale_nonces.push(pending);
                }
                assert_consistent(table, &context);
            }
        }
    }
    assert!(
        matches!(table.phase, TablePhase::Finished | TablePhase::Refunding),
        "chaos game {game} ended in {:?}",
        table.phase
    );
    assert_consistent(table, "chaos end");
    let n = table.count();
    let active = (0..n).filter(|&seat| table.is_active(seat)).count();
    if table.phase == TablePhase::Refunding {
        stats.ordering_refunds += 1;
    } else if active <= 1 {
        stats.last_standing += 1;
    } else if (0..n).any(|seat| table.is_active(seat) && table.net_worth(seat) >= table.target as i64) {
        stats.by_target += 1;
    } else {
        stats.idle_ranking += 1;
    }
    let emergency = table.phase == TablePhase::Finished && rng.chance(10);
    stats.emergency_refunds += emergency as u64;
    close_out(table, rng, now, emergency, &format!("chaos game {game}"));
}

fn percentile(sorted: &[u32], q: usize) -> u32 {
    let rank = (q * sorted.len()).div_ceil(100).max(1);
    sorted[rank.min(sorted.len()) - 1]
}

#[test]
#[ignore = "G5: 10,000 games; run with --release -- --ignored"]
fn fuzz_ten_thousand_games_on_one_reused_table() {
    let mut table = Table { index: 9, bump: 251, board: [Lot::default(); SPACES], ..Table::default() };
    let mut rng = Rng(20_261_103);
    let mut now = 1_000_000i64;
    let mut outside_band = Vec::new();
    println!("players target | engine p50 p95 p99 max | sim p50 p95 p99 | p50/p95/p99 diff");
    for (players, target, sim_p50, sim_p95, sim_p99) in SIM_NO_TRADES {
        let mut rounds: Vec<u32> = (0..PARITY_GAMES)
            .map(|_| parity_game(&mut table, &mut rng, players, target, &mut now))
            .collect();
        rounds.sort_unstable();
        let (p50, p95, p99) = (percentile(&rounds, 50), percentile(&rounds, 95), percentile(&rounds, 99));
        let diff = |engine: u32, sim: u32| (engine as f64 - sim as f64) / sim as f64;
        println!(
            "{players} {target} | {p50} {p95} {p99} {} | {sim_p50} {sim_p95} {sim_p99} | {:+.1}% {:+.1}% {:+.1}%",
            rounds[rounds.len() - 1],
            100.0 * diff(p50, sim_p50),
            100.0 * diff(p95, sim_p95),
            100.0 * diff(p99, sim_p99)
        );
        if [(p50, sim_p50), (p95, sim_p95), (p99, sim_p99)].iter().any(|&(engine, sim)| diff(engine, sim).abs() > BAND) {
            outside_band.push((players, target));
        }
    }
    let mut stats = ChaosStats::default();
    for game in 0..CHAOS_GAMES {
        chaos_game(&mut table, &mut rng, game, &mut now, &mut stats);
    }
    println!("chaos: {stats:?}");
    println!("{} games on one Table; final game_nonce {}", 9 * PARITY_GAMES + CHAOS_GAMES, table.game_nonce);
    assert_eq!(table.game_nonce as usize, 9 * PARITY_GAMES + CHAOS_GAMES);
    assert!(outside_band.is_empty(), "game length outside ±10% of sim.py --no-trades: {outside_band:?}");
}
