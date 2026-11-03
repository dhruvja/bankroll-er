//! G5: invariant fuzzing of the real engine. 91,000 games replay on one reused `Table` value:
//! 90,000 games of `sim.py`'s greedy bots (5,000 per player count and target, with and without
//! Auction trades, for the game-length comparison with `sim.py`) and 1,000 chaos games of random,
//! often illegal, actions with random timeouts, VRF retries, late callbacks, trades and emergency
//! refunds. A second test measures two colluding trade bots in 4-player games.
//!
//! `cargo test --release -p bankroll fuzz_ -- --ignored --nocapture`
use super::board::*;
use super::engine::encode_name;
use super::*;

/// As many games per combination as `sim.py`, so percentile noise stays inside the band.
const PARITY_GAMES: usize = 5_000;
const CHAOS_GAMES: usize = 1_000;
const MAX_STEPS: usize = 200_000;
/// `sim.py` trades mode (5,000 games each, seed 20261103): players, target, p50, p95, p99 rounds.
const SIM_TRADES: [(usize, u64, u32, u32, u32); 9] = [
    (2, 3000, 19, 33, 40),
    (2, 5000, 52, 87, 103),
    (2, 7000, 80, 141, 171),
    (3, 3000, 15, 23, 28),
    (3, 5000, 37, 59, 70),
    (3, 7000, 59, 100, 126),
    (4, 3000, 12, 20, 23),
    (4, 5000, 30, 47, 57),
    (4, 7000, 46, 78, 95),
];
/// `sim.py` trades mode, completed trades per game, in `SIM_TRADES` order.
const SIM_TRADES_PER_GAME: [f64; 9] = [0.90, 2.23, 2.66, 1.12, 2.95, 3.64, 1.06, 2.98, 3.82];
/// `sim.py --no-trades`, same seed and size.
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
/// Sanity band for the comparison: p50, p95, p99 and trades per game each within 10% of the simulator.
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
    trades_opened: u64,
    offers: u64,
    trades_completed: u64,
    cash_flows_checked: u64,
    roll_flows_checked: u64,
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
    if table.stage != Stage::TradeOffers {
        assert_eq!(table.trade, Trade::default(), "{context}: trade state outside TradeOffers");
    }
    if table.phase != TablePhase::Playing {
        assert_eq!(table.vrf_purpose, VrfPurpose::None, "{context}: VRF pending outside play");
        return;
    }
    let pending = matches!(table.stage, Stage::Ordering | Stage::Rolling);
    assert!(table.stage != Stage::Idle, "{context}: idle stage in play");
    if matches!(table.stage, Stage::TradeOpen | Stage::TradeOffers) {
        let lander = table.current_seat();
        assert_eq!(BOARD[table.seats[lander].position as usize].kind, SpaceKind::Auction, "{context}: trade off the Auction space");
    }
    if table.stage == Stage::TradeOffers {
        // Nothing can sell, build or eliminate during TradeOffers, so every live offer stays valid.
        let lander = table.current_seat();
        let unbuilt_of = |seat: usize, space: u8| {
            let lot = table.board[space as usize];
            lot.owner as usize == seat && lot.buildings == 0
        };
        assert!(unbuilt_of(lander, table.trade.space), "{context}: the lander's side is no longer tradeable");
        assert_eq!(table.stage_deadline, table.trade.deadline + TRADE_DECISION_SECONDS, "{context}");
        for (seat, &offer) in table.trade.offers.iter().enumerate() {
            if offer != NO_OFFER {
                assert!(seat != lander && table.is_active(seat) && unbuilt_of(seat, offer), "{context}: invalid offer from seat {seat}");
            }
        }
    }
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
/// "Fresh" is built the way `create_table` builds it, from zeroed account bytes plus an unowned
/// board, so a wrong `Default` cannot hide a field that `open` forgets to reset.
fn assert_fresh(table: &Table, index: u16, bump: u8, game_nonce: u64, vrf_nonce: u64, host: Pubkey, host_name: [u8; NAME_LEN]) {
    let mut fresh = Table::deserialize(&mut &[0u8; Table::INIT_SPACE][..]).unwrap();
    fresh.board = [Lot { owner: NO_OWNER, buildings: 0 }; SPACES];
    fresh.index = index;
    fresh.bump = bump;
    fresh.game_nonce = game_nonce;
    fresh.vrf_nonce = vrf_nonce;
    fresh.phase = TablePhase::Lobby;
    fresh.host = host;
    fresh.entry = table.entry;
    fresh.max_players = table.max_players;
    fresh.target = table.target;
    fresh.player_count = 1;
    fresh.lobby_deadline = table.lobby_deadline;
    fresh.last_action_at = table.last_action_at;
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
        // Sometimes a paid seat's token accounts are gone at settle; it then pulls its share later.
        let unpaid = payouts.map(|payout| payout > 0 && rng.chance(5));
        table.record_settlement(payouts, unpaid, *now);
        for seat in (0..table.count()).filter(|&seat| unpaid[seat]) {
            assert_eq!(
                table.refund(seat).unwrap().1,
                payouts[seat],
                "{context}: deferred share"
            );
        }
    } else {
        let finished = table.phase == TablePhase::Finished;
        if finished {
            *now = (table.last_action_at + IDLE_SECONDS).max(table.ended_at) + EMERGENCY_SECONDS + rng.below(5) as i64;
            table.force_timeout(*now).unwrap();
        }
        assert_eq!(table.phase, TablePhase::Refunding, "{context}");
        let mut paid = 0;
        for seat in 0..table.count() {
            if table.seats[seat].refunded {
                assert!(
                    finished && table.seats[seat].payout == 0,
                    "{context}: only a zero share is done at the switch"
                );
                continue;
            }
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

fn unbuilt(table: &Table, seat: usize) -> Vec<usize> {
    (0..SPACES)
        .filter(|&space| table.board[space].owner as usize == seat && table.board[space].buildings == 0)
        .collect()
}

/// A city of a group `seat` already holds whole.
fn in_full_group(table: &Table, seat: usize, space: usize) -> bool {
    BOARD[space].kind == SpaceKind::City && table.owns_group(seat, BOARD[space].group)
}

/// A property `seat` can swap away without breaking up a group it is building: a public, or a
/// city whose group holds no other city of `seat`'s.
fn loose(table: &Table, seat: usize, space: usize) -> bool {
    BOARD[space].kind == SpaceKind::Public
        || (0..SPACES).all(|other| {
            other == space || BOARD[other].kind != SpaceKind::City || BOARD[other].group != BOARD[space].group || table.board[other].owner as usize != seat
        })
}

/// Whether `seat` would own the whole city group of `gain` after receiving it (`sim.py completes`).
fn completes(table: &Table, seat: usize, gain: usize) -> bool {
    BOARD[gain].kind == SpaceKind::City
        && (0..SPACES)
            .filter(|&space| BOARD[space].kind == SpaceKind::City && BOARD[space].group == BOARD[gain].group)
            .all(|space| space == gain || table.board[space].owner as usize == seat)
}

/// Other seats' unbuilt properties that would complete one of the lander's groups.
fn wanted(table: &Table, lander: usize) -> Vec<usize> {
    (0..SPACES)
        .filter(|&space| {
            let owner = table.board[space].owner;
            owner != NO_OWNER && owner as usize != lander && table.board[space].buildings == 0 && completes(table, lander, space)
        })
        .collect()
}

/// First element with the highest price, like Python's `max` (`max_by_key` keeps the last).
fn priciest(spaces: impl DoubleEndedIterator<Item = usize>) -> Option<usize> {
    spaces.rev().max_by_key(|&space| BOARD[space].price)
}

fn cheapest(spaces: impl Iterator<Item = usize>) -> Option<usize> {
    spaces.min_by_key(|&space| BOARD[space].price)
}

/// How a bot trades. `Sim` is `sim.py`'s policy; `Never` always passes (the no-trades runs);
/// `Collude` makes seats a and b farm the bonus with each other whenever one of them lands on
/// Auction, handing the partner a group-completing property when they can and otherwise only
/// `loose` ones. An `exclusive` pair
/// also never offers to anyone else; otherwise it still trades with the others as `Sim` does and
/// takes a group-completing offer from them over the partner's.
#[derive(Clone, Copy, PartialEq)]
enum TradePolicy {
    Sim,
    Never,
    Collude { a: usize, b: usize, exclusive: bool },
}

impl TradePolicy {
    fn partner(self, seat: usize) -> Option<usize> {
        match self {
            TradePolicy::Collude { a, b, .. } if seat == a => Some(b),
            TradePolicy::Collude { a, b, .. } if seat == b => Some(a),
            _ => None,
        }
    }

    /// The colluding lander's partner, when the partner could take part in a swap.
    fn trading_partner(self, table: &Table, lander: usize) -> Option<usize> {
        self.partner(lander).filter(|&partner| table.is_active(partner) && !unbuilt(table, partner).is_empty())
    }

    /// What the lander offers at TradeOpen, or None to pass.
    fn give(self, table: &Table, lander: usize) -> Option<usize> {
        if self == TradePolicy::Never {
            return None;
        }
        let mine = unbuilt(table, lander);
        if let Some(partner) = self.trading_partner(table, lander) {
            return priciest(mine.iter().copied().filter(|&space| completes(table, partner, space)))
                .or_else(|| cheapest(mine.iter().copied().filter(|&space| loose(table, lander, space))));
        }
        let wanted = wanted(table, lander);
        cheapest(mine.into_iter().filter(|&space| {
            !in_full_group(table, lander, space) && !wanted.iter().any(|&want| BOARD[want].group == BOARD[space].group)
        }))
    }

    /// What `seat` offers back for the lander's `give`, or None.
    fn offer(self, table: &Table, seat: usize, lander: usize, give: usize) -> Option<usize> {
        let theirs = unbuilt(table, seat);
        if self.partner(seat) == Some(lander) {
            return priciest(theirs.iter().copied().filter(|&space| completes(table, lander, space)))
                .or_else(|| cheapest(theirs.iter().copied().filter(|&space| loose(table, seat, space))));
        }
        if self.partner(seat).is_some() && matches!(self, TradePolicy::Collude { exclusive: true, .. }) {
            return None;
        }
        let wanted = wanted(table, lander);
        priciest(theirs.iter().copied().filter(|space| wanted.contains(space))).or_else(|| {
            if !completes(table, seat, give) {
                return None;
            }
            cheapest(theirs.into_iter().filter(|&space| !in_full_group(table, seat, space) && BOARD[space].group != BOARD[give].group))
        })
    }

    /// The offer (seat, space) the lander accepts from `offers` (in turn order), or None.
    fn choose(self, table: &Table, lander: usize, offers: &[(usize, usize)]) -> Option<(usize, usize)> {
        let wanted = wanted(table, lander);
        let best = offers.iter().rev().copied().max_by_key(|&(_, space)| (wanted.contains(&space), BOARD[space].price));
        match self.trading_partner(table, lander) {
            Some(_) if matches!(self, TradePolicy::Collude { exclusive: false, .. })
                && best.is_some_and(|(_, space)| wanted.contains(&space)) => best,
            Some(partner) => offers.iter().copied().find(|&(seat, _)| seat == partner),
            None => best,
        }
    }
}

/// One game of bots with no timeouts. Returns the final round, the payouts and the trade count.
fn bot_game(table: &mut Table, rng: &mut Rng, players: usize, target: u64, now: &mut i64, policy: TradePolicy) -> (u32, [u64; MAX_SEATS], u32) {
    seat_players(table, rng, players, players as u8, target, 1_000_000, *now);
    let host = table.host;
    table.start(host, *now).unwrap();
    let mut trades = 0;
    for step in 0.. {
        assert!(step < MAX_STEPS, "bot game did not end");
        *now += 1;
        let lander = table.current_seat();
        let wallet = table.seats[lander].wallet;
        match (table.phase, table.stage) {
            (TablePhase::Playing, Stage::Ordering | Stage::Rolling) => {
                table.consume_randomness(rng.bytes(), table.vrf_nonce, *now).unwrap();
            }
            (TablePhase::Playing, Stage::PreRoll) => {
                if !bot_preroll(table, *now) {
                    continue;
                }
                if table.seats[lander].jail_turns > 0 && table.seats[lander].cash >= 500 {
                    table.pay_bail(wallet, *now).unwrap();
                } else {
                    table.roll(wallet, *now).unwrap();
                }
            }
            (TablePhase::Playing, Stage::BuyDecision) => {
                let price = BOARD[table.seats[lander].position as usize].price;
                if table.seats[lander].cash - price >= 100 {
                    table.buy(wallet, *now).unwrap();
                } else {
                    table.pass(wallet, *now).unwrap();
                }
            }
            (TablePhase::Playing, Stage::TradeOpen) => match policy.give(table, lander) {
                Some(space) => table.open_trade(wallet, space as u8, *now).unwrap(),
                None => table.pass(wallet, *now).unwrap(),
            },
            (TablePhase::Playing, Stage::TradeOffers) => {
                let give = table.trade.space as usize;
                let mut offers = Vec::new();
                for seat in table.order[..players].to_vec() {
                    let seat = seat as usize;
                    if seat == lander || !table.is_active(seat) {
                        continue;
                    }
                    if let Some(space) = policy.offer(table, seat, lander, give) {
                        table.offer_trade(table.seats[seat].wallet, space as u8, *now).unwrap();
                        offers.push((seat, space));
                    }
                }
                match policy.choose(table, lander, &offers) {
                    Some((seat, space)) => {
                        let before = table.clone();
                        table.accept_trade(wallet, seat as u8, space as u8, *now).unwrap();
                        assert_trade_swapped(&before, table, lander, seat, give, space, "bot game");
                        trades += 1;
                    }
                    None => table.pass(wallet, *now).unwrap(),
                }
            }
            (TablePhase::Finished, _) => break,
            other => panic!("bot game stuck in {other:?}"),
        }
        assert_consistent(table, "bot game");
    }
    let round = table.round;
    let payouts = table.payouts().unwrap();
    close_out(table, rng, now, false, "bot game");
    (round, payouts, trades)
}

/// A completed trade swaps exactly the two properties and pays exactly the two bonuses. A side the
/// swap left bankrupt is eliminated: its cash is discarded and its properties are unowned.
fn assert_trade_swapped(before: &Table, after: &Table, lander: usize, seat: usize, give: usize, take: usize, context: &str) {
    let bankrupt = |side: usize| before.is_active(side) && !after.is_active(side);
    for space in 0..SPACES {
        let expected = match space {
            _ if space == give => seat as u8,
            _ if space == take => lander as u8,
            _ => before.board[space].owner,
        };
        let expected = if expected != NO_OWNER && bankrupt(expected as usize) { NO_OWNER } else { expected };
        assert_eq!(after.board[space].owner, expected, "{context}: trade moved space {space}");
        if expected != NO_OWNER {
            assert_eq!(after.board[space].buildings, before.board[space].buildings, "{context}");
        }
    }
    for other in 0..MAX_SEATS {
        let bonus = if other == lander || other == seat { TRADE_BONUS } else { 0 };
        let expected = if bankrupt(other) { 0 } else { before.seats[other].cash + bonus };
        assert_eq!(after.seats[other].cash, expected, "{context}: trade cash of seat {other}");
    }
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
        // Trade calls usually name one of the caller's own properties so trades actually complete.
        let own_space = |table: &Table, wallet: Pubkey, rng: &mut Rng| {
            let owned: Vec<usize> = table.seat_of(&wallet).map(|seat| unbuilt(table, seat)).unwrap_or_default();
            if owned.is_empty() || rng.chance(20) { space } else { owned[rng.below(owned.len() as u64) as usize] as u8 }
        };
        let before = table.clone();
        let pending = table.vrf_nonce;
        // Trade stages favour trade calls, or the offer window would rarely see an offer.
        let action = match table.stage {
            Stage::TradeOpen if rng.chance(50) => 100 + rng.below(6),
            Stage::TradeOffers if rng.chance(60) => 106 + rng.below(14),
            _ => rng.below(120),
        };
        let result = match action {
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
            99 => table.refund(rng.below(MAX_SEATS as u64) as usize).map(|_| ()),
            100..=105 => {
                let give = own_space(table, actor, rng);
                table.open_trade(actor, give, *now)
            }
            106..=113 => {
                let offerer = if rng.chance(80) { wallets[rng.below(players as u64) as usize] } else { caller };
                let offer = own_space(table, offerer, rng);
                table.offer_trade(offerer, offer, *now)
            }
            _ => {
                let seat = rng.below(MAX_SEATS as u64 + 1) as u8;
                let take = match table.trade.offers.get(seat as usize) {
                    Some(&offer) if rng.chance(80) => offer,
                    _ => space,
                };
                table.accept_trade(actor, seat, take, *now)
            }
        };
        match result {
            Err(_) => {
                assert_eq!(*table, before, "{context}: a rejected instruction mutated the table");
                stats.rejected += 1;
            }
            Ok(()) => {
                stats.accepted += 1;
                match action {
                    100..=105 => stats.trades_opened += 1,
                    106..=113 => stats.offers += 1,
                    114.. => {
                        stats.trades_completed += 1;
                        let lander = before.current_seat();
                        let take = table.board.iter().zip(before.board.iter()).position(|(now, was)| now.owner as usize == lander && was.owner as usize != lander).unwrap();
                        let seat = before.board[take].owner as usize;
                        assert_trade_swapped(&before, table, lander, seat, before.trade.space as usize, take, &context);
                    }
                    _ => {}
                }
                assert_player_cash_flow(&before, table, action, space, &context, stats);
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

/// The bank side of every accepted instruction that eliminates nobody: buy, build, sell and bail
/// move exactly their price, a trade adds exactly the two bonuses, a roll callback adds salary for
/// each pass of Start plus the drawn card's bank amount (rent and pay/collect cards only move cash
/// between seats), and everything else (rolls, passes, offers, timeouts) moves no cash.
fn assert_player_cash_flow(before: &Table, after: &Table, action: u64, space: u8, context: &str, stats: &mut ChaosStats) {
    let eliminated = |table: &Table| table.seats.iter().filter(|seat| seat.eliminated_at != 0).count();
    // The turn-order callback deals the starting cash instead of moving it.
    if eliminated(after) != eliminated(before) || before.vrf_purpose == VrfPurpose::Order {
        return;
    }
    let total = |table: &Table| table.seats.iter().map(|seat| seat.cash).sum::<i64>();
    let seat = before.current_seat();
    let spec = BOARD.get(space as usize);
    let expected = match action {
        30..=49 => {
            let landed = before.seats[seat].position as usize + after.last_roll as usize;
            let salary = if landed >= SPACES { SALARY } else { 0 };
            let card = match after.last_card {
                0 => 0,
                drawn => {
                    let card = LUCKY_DECK[drawn as usize - 1];
                    let buildings: i64 = before
                        .board
                        .iter()
                        .filter(|lot| lot.owner as usize == seat)
                        .map(|lot| lot.buildings as i64)
                        .sum();
                    match card.kind {
                        LuckyKind::Bank => card.amount,
                        LuckyKind::ToStart => SALARY,
                        LuckyKind::Move
                            if (landed % SPACES) as i64 + card.amount >= SPACES as i64 =>
                        {
                            SALARY
                        }
                        LuckyKind::Repairs => -card.amount * buildings,
                        LuckyKind::Move
                        | LuckyKind::PayEach
                        | LuckyKind::CollectEach
                        | LuckyKind::ToJail => 0,
                    }
                }
            };
            stats.roll_flows_checked += 1;
            salary + card
        }
        50..=59 => -BOARD[before.seats[seat].position as usize].price,
        65..=74 => -spec.unwrap().building_cost,
        75..=79 => {
            let lot = before.board[space as usize];
            (spec.unwrap().price + lot.buildings as i64 * spec.unwrap().building_cost) * SALE_BPS / 10_000
        }
        80..=84 => -BAIL,
        114.. => 2 * TRADE_BONUS,
        _ => 0,
    };
    assert_eq!(total(after) - total(before), expected, "{context}: cash flow of action {action}");
    stats.cash_flows_checked += 1;
}

fn percentile(sorted: &[u32], q: usize) -> u32 {
    let rank = (q * sorted.len()).div_ceil(100).max(1);
    sorted[rank.min(sorted.len()) - 1]
}

#[test]
#[ignore = "G5: 91,000 games; run with --release -- --ignored"]
fn fuzz_ninety_one_thousand_games_on_one_reused_table() {
    let mut table = Table { index: 9, bump: 251, board: [Lot::default(); SPACES], ..Table::default() };
    let mut rng = Rng(20_261_103);
    let mut now = 1_000_000i64;
    let mut outside_band = Vec::new();
    println!("mode players target | engine p50 p95 p99 max | sim p50 p95 p99 | p50/p95/p99 diff | trades/game engine sim");
    for (mode, policy, bands) in [("trades", TradePolicy::Sim, SIM_TRADES), ("no-trades", TradePolicy::Never, SIM_NO_TRADES)] {
        for (combo, (players, target, sim_p50, sim_p95, sim_p99)) in bands.into_iter().enumerate() {
            let mut trades = 0;
            let mut rounds: Vec<u32> = (0..PARITY_GAMES)
                .map(|_| {
                    let (round, _, game_trades) = bot_game(&mut table, &mut rng, players, target, &mut now, policy);
                    trades += game_trades;
                    round
                })
                .collect();
            rounds.sort_unstable();
            let (p50, p95, p99) = (percentile(&rounds, 50), percentile(&rounds, 95), percentile(&rounds, 99));
            let diff = |engine: f64, sim: f64| (engine - sim) / sim;
            let per_game = trades as f64 / PARITY_GAMES as f64;
            let sim_per_game = if policy == TradePolicy::Sim { SIM_TRADES_PER_GAME[combo] } else { 0.0 };
            println!(
                "{mode} {players} {target} | {p50} {p95} {p99} {} | {sim_p50} {sim_p95} {sim_p99} | {:+.1}% {:+.1}% {:+.1}% | {per_game:.2} {sim_per_game:.2}",
                rounds[rounds.len() - 1],
                100.0 * diff(p50.into(), sim_p50.into()),
                100.0 * diff(p95.into(), sim_p95.into()),
                100.0 * diff(p99.into(), sim_p99.into())
            );
            let lengths = [(p50, sim_p50), (p95, sim_p95), (p99, sim_p99)];
            let trade_rate_off = if policy == TradePolicy::Sim { diff(per_game, sim_per_game).abs() > BAND } else { trades != 0 };
            if trade_rate_off || lengths.iter().any(|&(engine, sim)| diff(engine.into(), sim.into()).abs() > BAND) {
                outside_band.push((mode, players, target));
            }
        }
    }
    let mut stats = ChaosStats::default();
    for game in 0..CHAOS_GAMES {
        chaos_game(&mut table, &mut rng, game, &mut now, &mut stats);
    }
    println!("chaos: {stats:?}");
    let games = 18 * PARITY_GAMES + CHAOS_GAMES;
    println!("{games} games on one Table; final game_nonce {}", table.game_nonce);
    assert_eq!(table.game_nonce as usize, games);
    assert!(stats.trades_completed > 0 && stats.offers > 0, "chaos never completed a trade");
    assert!(outside_band.is_empty(), "game length outside ±10% of sim.py: {outside_band:?}");
}

/// Two colluding bots (seats 0 and 1 by join order; turn order is still drawn by VRF) farm the
/// trade bonus with each other and never offer to the other two, against two `sim.py` bots.
/// Prints the pair's win share and pot share against the same seats in all-`sim.py` games.
#[test]
#[ignore = "collusion measurement; run with --release -- --ignored"]
fn fuzz_collusion_two_colluding_bots_in_four_player_games() {
    const GAMES: usize = 4_000;
    let mut table = Table { index: 9, bump: 251, board: [Lot::default(); SPACES], ..Table::default() };
    let mut rng = Rng(20_261_104);
    let mut now = 1_000_000i64;
    println!("target pair | pair win% honest -> colluding (shift pp) | pair pot% honest -> colluding (shift pp) | trades/game honest -> colluding");
    for target in TARGETS {
        let mut measure = |policy: TradePolicy| {
            let (mut wins, mut share, mut trades) = (0.0f64, 0.0f64, 0u32);
            for _ in 0..GAMES {
                let (_, payouts, game_trades) = bot_game(&mut table, &mut rng, 4, target, &mut now, policy);
                let top = *payouts.iter().max().unwrap();
                let winners = payouts.iter().filter(|&&payout| payout == top).count() as f64;
                wins += payouts[..2].iter().filter(|&&payout| payout == top).count() as f64 / winners;
                share += (payouts[0] + payouts[1]) as f64 / 4_000_000.0;
                trades += game_trades;
            }
            (100.0 * wins / GAMES as f64, 100.0 * share / GAMES as f64, trades as f64 / GAMES as f64)
        };
        let (honest_wins, honest_share, honest_trades) = measure(TradePolicy::Sim);
        for exclusive in [true, false] {
            let (wins, share, trades) = measure(TradePolicy::Collude { a: 0, b: 1, exclusive });
            println!(
                "{target} {} | {honest_wins:.1} -> {wins:.1} ({:+.1}) | {honest_share:.1} -> {share:.1} ({:+.1}) | {honest_trades:.2} -> {trades:.2}",
                if exclusive { "exclusive" } else { "farming  " },
                wins - honest_wins,
                share - honest_share
            );
        }
    }
}
