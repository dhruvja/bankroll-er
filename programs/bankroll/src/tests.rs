use super::board::*;
use super::engine::encode_name;
use super::*;

const T0: i64 = 1_000;
const USDC: u64 = 1_000_000;

fn die(value: u8) -> [u8; 32] {
    let mut randomness = [0u8; 32];
    randomness[..8].copy_from_slice(&((value - 1) as u64).to_le_bytes());
    randomness
}

fn name(text: &str) -> [u8; NAME_LEN] {
    encode_name(text).unwrap()
}

fn wallets() -> [Pubkey; MAX_SEATS] {
    [0u8, 1, 2, 3].map(|i| Pubkey::new_from_array([i + 1; 32]))
}

fn lobby(players: usize, target: u64) -> Table {
    let w = wallets();
    let mut table = Table { index: 3, bump: 250, ..Table::default() };
    table.open(w[0], name("host"), USDC, MAX_SEATS as u8, target, T0).unwrap();
    for (i, wallet) in w.iter().enumerate().take(players).skip(1) {
        table.join(*wallet, name(&format!("p{i}")), table.game_nonce, T0).unwrap();
    }
    table
}

/// A started game with turn order forced to seat order and seat 0 to act.
fn playing(players: usize, target: u64) -> Table {
    let mut table = lobby(players, target);
    table.start(wallets()[0], T0).unwrap();
    table.consume_randomness([9; 32], table.vrf_nonce, T0).unwrap();
    table.order = [0, 1, 2, 3];
    table.turn = 0;
    table
}

fn roll(table: &mut Table, value: u8, now: i64) {
    let seat = table.current_seat();
    table.roll(table.seats[seat].wallet, now).unwrap();
    table.consume_randomness(die(value), table.vrf_nonce, now).unwrap();
}

#[test]
fn lobby_validates_config_nonce_capacity_and_refunds_free_the_table() {
    let w = wallets();
    let mut free = Table::default();
    assert!(free.open(w[0], name("h"), 2 * USDC, 3, 3000, T0).is_err());
    assert!(free.open(w[0], name("h"), USDC, 5, 3000, T0).is_err());
    assert!(free.open(w[0], name("h"), USDC, 1, 3000, T0).is_err());
    assert!(free.open(w[0], name("h"), USDC, 3, 4000, T0).is_err());
    assert!(encode_name("  ").is_err());
    assert!(encode_name("seventeen bytes!!").is_err());
    free.open(w[0], name("h"), USDC, 2, 3000, T0).unwrap();
    assert!(free.open(w[1], name("x"), USDC, 2, 3000, T0).is_err());
    assert!(free.join(w[0], name("dup"), 1, T0).is_err());
    assert!(free.join(w[1], name("stale"), 0, T0).is_err());
    assert!(free.start(w[0], T0).is_err(), "one player cannot start");
    free.join(w[1], name("g"), 1, T0 + 1).unwrap();
    assert!(free.join(w[2], name("full"), 1, T0).is_err());
    assert!(free.cancel_or_expire(w[1], T0 + LOBBY_SECONDS - 1).is_err());
    free.cancel_or_expire(w[1], T0 + LOBBY_SECONDS).unwrap();
    assert_eq!(free.phase, TablePhase::Refunding);
    assert_eq!(free.refund(1).unwrap(), (w[1], free.entry), "an unfinished game refunds the entry");
    assert!(free.refund(1).is_err());
    assert!(free.refund(2).is_err());
    assert_eq!(free.phase, TablePhase::Refunding);
    assert_eq!(free.refund(0).unwrap(), (w[0], free.entry));
    assert_eq!(free.phase, TablePhase::Free);

    let mut expired = lobby(2, 3000);
    assert!(expired.join(w[2], name("late"), 1, T0 + LOBBY_SECONDS).is_err());
    assert!(expired.start(w[0], T0 + LOBBY_SECONDS).is_err());
    expired.cancel_or_expire(w[0], T0 + 1).unwrap();
}

#[test]
fn turn_order_is_a_permutation_with_the_seat_bonus_for_each_target() {
    for (target, step) in [(3000, 75), (5000, 125), (7000, 175)] {
        for seed in 0..8u8 {
            let mut table = lobby(4, target);
            assert!(table.start(wallets()[1], T0).is_err(), "only the host starts");
            table.start(wallets()[0], T0).unwrap();
            assert_eq!((table.phase, table.stage, table.vrf_purpose), (TablePhase::Playing, Stage::Ordering, VrfPurpose::Order));
            table.consume_randomness([seed; 32], table.vrf_nonce, T0 + 1).unwrap();
            let mut sorted = table.order;
            sorted.sort();
            assert_eq!(sorted, [0, 1, 2, 3]);
            for (place, seat) in table.order.iter().enumerate() {
                assert_eq!(table.seats[*seat as usize].cash, 2000 + step * place as i64);
            }
            assert_eq!((table.stage, table.turn, table.round), (Stage::PreRoll, 0, 1));
            assert_eq!(table.stage_deadline, T0 + 1 + PREROLL_SECONDS);
            assert_eq!(table.vrf_purpose, VrfPurpose::None);
        }
    }
}

#[test]
fn movement_salary_buy_and_pass() {
    let mut table = playing(3, 7000);
    table.seats[0].position = 20;
    let cash = table.seats[0].cash;
    roll(&mut table, 4, T0 + 2);
    assert_eq!(table.seats[0].position, 0);
    assert_eq!(table.seats[0].cash, cash + SALARY, "landing on Start pays salary");
    assert_eq!((table.turn, table.stage), (1, Stage::PreRoll));
    assert!(table.roll(wallets()[0], T0 + 3).is_err(), "not seat 0's turn");

    table.seats[1].position = 23;
    let cash = table.seats[1].cash;
    roll(&mut table, 2, T0 + 3);
    assert_eq!((table.seats[1].position, table.seats[1].cash), (1, cash + SALARY));
    assert_eq!(table.stage, Stage::BuyDecision);
    assert_eq!(table.stage_deadline, T0 + 3 + BUY_SECONDS);
    assert!(table.buy(wallets()[0], T0 + 4).is_err());
    table.buy(wallets()[1], T0 + 4).unwrap();
    assert_eq!(table.board[1].owner, 1);
    assert_eq!(table.seats[1].cash, cash + SALARY - 60);
    assert_eq!(table.net_worth(1), cash + SALARY);
    assert_eq!((table.turn, table.stage, table.last_action_at), (2, Stage::PreRoll, T0 + 4));

    roll(&mut table, 4, T0 + 5);
    assert_eq!(table.stage, Stage::BuyDecision, "Railway");
    table.pass(wallets()[2], T0 + 6).unwrap();
    assert_eq!(table.board[4].owner, NO_OWNER);
    assert_eq!((table.turn, table.round), (0, 2), "wrapping to the first seat starts round 2");

    table.seats[0].cash = 50;
    roll(&mut table, 2, T0 + 7);
    assert_eq!(table.stage, Stage::PreRoll, "cannot afford Athens, so no buy decision");
    assert_eq!(table.turn, 1);
}

#[test]
fn rent_is_base_doubled_for_a_full_group_and_scaled_for_publics() {
    let mut table = playing(2, 7000);
    table.board[1].owner = 1;
    assert_eq!(table.rent(1), 6);
    table.board[2].owner = 1;
    assert_eq!(table.rent(1), 12);
    assert_eq!(table.rent(2), 16);
    table.board[1].buildings = 3;
    assert_eq!(table.rent(1), 66, "building multipliers apply with the full group");
    table.board[2].owner = NO_OWNER;
    assert_eq!(table.rent(1), 6, "a broken group falls back to base rent");
    table.board[1].buildings = 0;
    for (count, space) in [4usize, 10, 16, 22].iter().enumerate() {
        table.board[*space].owner = 1;
        assert_eq!(table.rent(4), 25 * (count as i64 + 1));
    }

    table.board[2].owner = 1;
    let (payer, owner) = (table.seats[0].cash, table.seats[1].cash);
    roll(&mut table, 2, T0 + 1);
    assert_eq!(table.seats[0].cash, payer - 16);
    assert_eq!(table.seats[1].cash, owner + 16);
    table.board[5].owner = 0;
    roll(&mut table, 4, T0 + 2);
    assert_eq!(table.seats[1].position, 4);
    assert_eq!(table.stage, Stage::PreRoll, "own public: no rent, no buy");
    let (payer, owner) = (table.seats[0].cash, table.seats[1].cash);
    roll(&mut table, 2, T0 + 3);
    assert_eq!(table.seats[0].position, 4);
    assert_eq!(table.seats[0].cash, payer - 100, "four publics: 4 x 25");
    assert_eq!(table.seats[1].cash, owner + 100);
}

#[test]
fn a_six_grants_another_roll_up_to_three_per_turn() {
    let mut table = playing(2, 7000);
    roll(&mut table, 6, T0 + 1);
    assert_eq!((table.seats[0].position, table.turn, table.stage), (6, 0, Stage::PreRoll));
    assert_eq!(table.stage_deadline, T0 + 1 + PREROLL_SECONDS);
    roll(&mut table, 6, T0 + 2);
    assert_eq!((table.seats[0].position, table.turn, table.rolls_this_turn), (12, 0, 2));
    roll(&mut table, 6, T0 + 3);
    assert_eq!(table.seats[0].position, 18);
    assert_eq!((table.turn, table.rolls_this_turn), (1, 0), "a third 6 gives no further roll");

    table.seats[1].position = 1;
    roll(&mut table, 6, T0 + 4);
    assert_eq!(table.stage, Stage::BuyDecision, "Mumbai");
    table.pass(wallets()[1], T0 + 5).unwrap();
    assert_eq!((table.turn, table.stage), (1, Stage::PreRoll), "the extra roll survives a decision");
}

#[test]
fn stage_timeouts_strike_skip_and_forfeit_on_the_third_strike() {
    let mut table = playing(3, 7000);
    let deadline = table.stage_deadline;
    assert!(table.force_timeout(deadline - 1).is_err());
    table.force_timeout(deadline).unwrap();
    assert_eq!((table.seats[0].strikes, table.turn, table.stage), (1, 1, Stage::PreRoll));
    assert_eq!(table.last_action_at, T0, "force_timeout is not a player action");

    // A timed-out buy decision passes, strikes and ends the turn, even after a 6.
    table.seats[1].position = 1;
    roll(&mut table, 6, deadline + 1);
    assert_eq!(table.stage, Stage::BuyDecision);
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!((table.seats[1].strikes, table.board[7].owner, table.turn), (1, NO_OWNER, 2));

    // Seat 2 keeps playing onto a no-op space while seats 0 and 1 stay away.
    for _ in 0..2 {
        table.seats[2].position = 0;
        let now = table.stage_deadline;
        roll(&mut table, 3, now);
        table.force_timeout(table.stage_deadline).unwrap();
        table.force_timeout(table.stage_deadline).unwrap();
    }
    assert_eq!((table.seats[0].strikes, table.seats[0].eliminated_at), (3, 1), "third strike forfeits");
    assert_eq!((table.seats[1].strikes, table.seats[1].eliminated_at), (3, 2));
    assert_eq!(table.phase, TablePhase::Finished, "last player standing wins");
    assert_eq!(table.payouts().unwrap(), [0, 900_000, 2_010_000, 0], "later forfeit ranks higher");
}

#[test]
fn forfeit_releases_properties_and_strikes_never_reset() {
    let mut table = playing(3, 7000);
    table.board[1].owner = 0;
    table.seats[0].strikes = 2;
    roll(&mut table, 1, T0 + 1);
    assert_eq!(table.seats[0].strikes, 2, "acting does not clear strikes");
    table.force_timeout(table.stage_deadline).unwrap();
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!(table.turn, 0);
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!(table.seats[0].eliminated_at, 1);
    assert_eq!(table.seats[0].cash, 0);
    assert_eq!(table.board[1].owner, NO_OWNER);
    assert_eq!(table.turn, 1);
    assert_eq!(table.phase, TablePhase::Playing);
}

#[test]
fn reaching_the_target_ends_the_game() {
    let mut table = playing(3, 3000);
    table.seats[0].cash = 2_850;
    table.seats[0].position = 22;
    roll(&mut table, 1, T0 + 1);
    assert_eq!(table.phase, TablePhase::Playing, "net worth 2850 + Power Plant would need a buy");
    table.buy(wallets()[0], T0 + 2).unwrap();
    assert_eq!(table.phase, TablePhase::Playing, "buying keeps net worth");
    table.seats[1].position = 23;
    table.seats[1].cash = 2_800;
    roll(&mut table, 1, T0 + 3);
    assert_eq!(table.phase, TablePhase::Finished, "salary lifts seat 1 to 3000");
    assert_eq!((table.stage, table.ended_at, table.vrf_purpose), (Stage::Idle, T0 + 3, VrfPurpose::None));
    assert!(table.roll(wallets()[2], T0 + 4).is_err());
    assert!(table.force_timeout(T0 + 5).is_err());
}

#[test]
fn rent_that_bankrupts_eliminates_the_payer() {
    let mut table = playing(2, 7000);
    table.board[23].owner = 1;
    table.board[21].owner = 1;
    table.board[23].buildings = 3;
    table.board[21].buildings = 3;
    table.seats[0].cash = -50;
    table.seats[0].position = 22;
    let owner = table.seats[1].cash;
    roll(&mut table, 1, T0 + 1);
    assert_eq!(table.seats[0].eliminated_at, 1, "-50 - 440 leaves net worth below zero");
    assert_eq!(table.seats[1].cash, owner + 440, "New York, full Gold, 3 buildings: 40 x 11");
    assert_eq!(table.phase, TablePhase::Finished);
    assert_eq!(table.payouts().unwrap(), [0, 1_940_000, 0, 0]);
}

#[test]
fn idle_deadline_ends_by_ranking_before_stage_timeouts_then_emergency_refund() {
    let mut table = playing(3, 7000);
    table.seats[2].cash += 500;
    let idle = table.last_action_at + IDLE_SECONDS;
    table.force_timeout(idle).unwrap();
    assert_eq!(table.phase, TablePhase::Finished);
    assert!(table.seats.iter().all(|seat| seat.strikes == 0), "nobody is struck at the idle deadline");
    assert!(table.payouts().unwrap()[2] == 2_010_000);
    assert!(table.force_timeout(idle + EMERGENCY_SECONDS - 1).is_err());
    let ranked = table.payouts().unwrap();
    table.force_timeout(idle + EMERGENCY_SECONDS).unwrap();
    assert_eq!(table.phase, TablePhase::Refunding);
    for seat in 0..3 {
        let (wallet, amount) = table.refund(seat).unwrap();
        assert_eq!((wallet, amount), (wallets()[seat], ranked[seat]), "a finished game refunds its ranked payout");
    }
    assert_eq!(table.phase, TablePhase::Free);

    // A table nobody touched until long after the idle deadline still ends by ranking.
    let mut stuck = playing(2, 3000);
    stuck.roll(wallets()[0], T0 + 11).unwrap();
    assert_eq!(stuck.stage, Stage::Rolling);
    let late = T0 + 11 + IDLE_SECONDS + EMERGENCY_SECONDS;
    stuck.force_timeout(late).unwrap();
    assert_eq!((stuck.phase, stuck.vrf_purpose, stuck.ended_at), (TablePhase::Finished, VrfPurpose::None, late));
    assert!(stuck.consume_randomness(die(1), stuck.vrf_nonce, T0).is_err(), "late callback after the end");
    assert!(stuck.force_timeout(late + EMERGENCY_SECONDS - 1).is_err(), "settle always gets a full window after the end");
    stuck.force_timeout(late + EMERGENCY_SECONDS).unwrap();
    assert_eq!(stuck.phase, TablePhase::Refunding);

    let mut unordered = lobby(2, 3000);
    unordered.start(wallets()[0], T0).unwrap();
    unordered.force_timeout(T0 + IDLE_SECONDS).unwrap();
    assert_eq!(unordered.phase, TablePhase::Refunding, "no turn order: refund instead of ranking");
}

#[test]
fn vrf_callbacks_need_the_pending_nonce_and_retries_bump_it() {
    let mut table = lobby(2, 3000);
    assert!(table.consume_randomness([1; 32], table.vrf_nonce, T0).is_err(), "nothing pending");
    table.start(wallets()[0], T0).unwrap();
    let first = table.vrf_nonce;
    assert!(table.start(wallets()[1], T0 + VRF_RETRY_SECONDS - 1).is_err());
    assert!(table.start(Pubkey::new_unique(), T0 + VRF_RETRY_SECONDS).is_err(), "strangers cannot retry");
    table.start(wallets()[1], T0 + VRF_RETRY_SECONDS).unwrap();
    assert_eq!(table.vrf_nonce, first + 1);
    let before = table.clone();
    assert!(table.consume_randomness([1; 32], first, T0 + 20).is_err(), "stale callback");
    assert_eq!(table, before);
    table.consume_randomness([1; 32], first + 1, T0 + 20).unwrap();
    assert!(table.consume_randomness([1; 32], first + 1, T0 + 20).is_err(), "replayed callback");

    table.order = [0, 1, 2, 3];
    table.turn = 0;
    table.roll(wallets()[0], T0 + 30).unwrap();
    assert!(table.roll(wallets()[0], T0 + 31).is_err(), "retry waits for the VRF timeout");
    let stale = table.vrf_nonce;
    assert!(table.roll(wallets()[1], T0 + 30 + OTHER_SEAT_RETRY_SECONDS - 1).is_err(), "others wait longer");
    table.roll(wallets()[0], T0 + 30 + VRF_RETRY_SECONDS).unwrap();
    assert!(table.consume_randomness(die(3), stale, T0 + 50).is_err());
    let stale = table.vrf_nonce;
    table.roll(wallets()[1], T0 + 30 + VRF_RETRY_SECONDS + OTHER_SEAT_RETRY_SECONDS).unwrap();
    assert!(table.consume_randomness(die(3), stale, T0 + 120).is_err());
    table.consume_randomness(die(3), stale + 1, T0 + 120).unwrap();
    assert_eq!(table.seats[0].position, 3, "the retry still moves the current seat");
}

#[test]
fn open_resets_every_game_field_but_keeps_identity_and_nonces() {
    let mut table = playing(4, 5000);
    roll(&mut table, 1, T0 + 1);
    table.buy(wallets()[0], T0 + 2).unwrap();
    table.seats[3].strikes = 2;
    table.force_timeout(table.last_action_at + IDLE_SECONDS).unwrap();
    let payouts = table.payouts().unwrap();
    table.record_settlement(payouts);
    assert_eq!(table.phase, TablePhase::Free);
    let (game_nonce, vrf_nonce) = (table.game_nonce, table.vrf_nonce);
    let host = Pubkey::new_unique();
    table.open(host, name("next"), 5 * USDC, 2, 3000, T0 + 9_000).unwrap();
    let mut fresh = Table {
        index: 3,
        bump: 250,
        game_nonce: game_nonce + 1,
        vrf_nonce,
        phase: TablePhase::Lobby,
        host,
        entry: 5 * USDC,
        max_players: 2,
        target: 3000,
        player_count: 1,
        lobby_deadline: T0 + 9_000 + LOBBY_SECONDS,
        last_action_at: T0 + 9_000,
        ..Table::default()
    };
    fresh.seats[0].wallet = host;
    fresh.seats[0].name = name("next");
    assert_eq!(table, fresh);
}

fn finished(nets: &[i64], eliminated: &[u8]) -> Table {
    let mut table = playing(nets.len(), 7000);
    for (seat, (&net, &out)) in nets.iter().zip(eliminated).enumerate() {
        table.seats[seat].cash = net;
        table.seats[seat].eliminated_at = out;
    }
    table.phase = TablePhase::Finished;
    table
}

#[test]
fn ranked_payouts_cover_every_order_and_tie_for_two_three_and_four_seats() {
    let cases: &[(&[i64], &[u8], [u64; 4])] = &[
        // Two seats: pot 2.00, the winner takes 97%.
        (&[3000, 2000], &[0, 0], [1_940_000, 0, 0, 0]),
        (&[2000, 3000], &[0, 0], [0, 1_940_000, 0, 0]),
        (&[2500, 2500], &[0, 0], [970_000, 970_000, 0, 0]),
        (&[0, 100], &[1, 0], [0, 1_940_000, 0, 0]),
        // Three seats: pot 3.00, 67/30.
        (&[3000, 2000, 1000], &[0, 0, 0], [2_010_000, 900_000, 0, 0]),
        (&[1000, 3000, 2000], &[0, 0, 0], [0, 2_010_000, 900_000, 0]),
        (&[3000, 3000, 1000], &[0, 0, 0], [1_455_000, 1_455_000, 0, 0]),
        (&[3000, 2000, 2000], &[0, 0, 0], [2_010_000, 450_000, 450_000, 0]),
        (&[2000, 2000, 2000], &[0, 0, 0], [970_000, 970_000, 970_000, 0]),
        (&[3000, 0, 0], &[0, 1, 2], [2_010_000, 0, 900_000, 0]),
        (&[3000, 0, 0], &[0, 1, 1], [2_010_000, 450_000, 450_000, 0]),
        (&[0, 9000, 0], &[2, 0, 1], [900_000, 2_010_000, 0, 0]),
        // Four seats: pot 4.00, 60/27/10.
        (&[4000, 3000, 2000, 1000], &[0, 0, 0, 0], [2_400_000, 1_080_000, 400_000, 0]),
        (&[4000, 4000, 2000, 1000], &[0, 0, 0, 0], [1_740_000, 1_740_000, 400_000, 0]),
        (&[4000, 3000, 3000, 1000], &[0, 0, 0, 0], [2_400_000, 740_000, 740_000, 0]),
        (&[4000, 3000, 1000, 1000], &[0, 0, 0, 0], [2_400_000, 1_080_000, 200_000, 200_000]),
        (&[4000, 4000, 4000, 1000], &[0, 0, 0, 0], [1_293_333, 1_293_333, 1_293_333, 0]),
        (&[4000, 4000, 4000, 4000], &[0, 0, 0, 0], [970_000, 970_000, 970_000, 970_000]),
        (&[1000, 1000, 1000, 1000], &[0, 0, 0, 0], [970_000, 970_000, 970_000, 970_000]),
        (&[4000, 0, 0, 0], &[0, 3, 2, 1], [2_400_000, 1_080_000, 400_000, 0]),
        (&[4000, 0, 0, 0], &[0, 1, 1, 1], [2_400_000, 493_333, 493_333, 493_333]),
        (&[100, 0, 0, 5000], &[0, 2, 1, 0], [1_080_000, 400_000, 0, 2_400_000]),
        (&[0, 0, 0, 0], &[1, 2, 2, 3], [0, 740_000, 740_000, 2_400_000]),
    ];
    for (nets, eliminated, expected) in cases {
        let table = finished(nets, eliminated);
        let payouts = table.payouts().unwrap();
        assert_eq!(&payouts, expected, "nets {nets:?} eliminated {eliminated:?}");
        let pot = table.pot().unwrap();
        let paid: u64 = payouts.iter().sum();
        assert!(paid <= pot - pot * FEE_BPS / 10_000, "fee always reaches the treasury");
    }
    assert!(playing(2, 3000).payouts().is_err(), "only a finished game pays out");
}

#[test]
fn board_constants_match_the_frozen_economy() {
    assert_eq!(BOARD.len(), 24);
    assert_eq!(BOARD[23].price, 400);
    assert_eq!(SHARES_BPS.iter().map(|row| row.iter().sum::<u64>() + FEE_BPS).collect::<Vec<_>>(), [10_000; 3]);
    assert!(TABLE_SPACE < 10_240);
}
