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

/// A lobby whose entries were paid into the vault, as `open_table` and `join_table` record them.
fn lobby(players: usize, target: u64) -> EphemeralTable {
    let w = wallets();
    let mut house = House::default();
    let mut table = EphemeralTable::new(w[0], 250, 0);
    table.open(w[0], name("host"), USDC, MAX_SEATS as u8, target, 0, 1500, T0).unwrap();
    table.credit(&mut house, USDC).unwrap();
    for (i, wallet) in w.iter().enumerate().take(players).skip(1) {
        table.join(*wallet, name(&format!("p{i}")), table.game_nonce, T0).unwrap();
        table.credit(&mut house, USDC).unwrap();
    }
    table
}

/// The house as it stands when `table` is the only live table.
fn house_of(table: &EphemeralTable) -> House {
    House { liability: table.held, ..House::default() }
}

/// What `settle` does to the bookkeeping: each paid share and then the fee are debited, unpaid
/// shares stay held, then the settlement is recorded.
fn settle(table: &mut EphemeralTable, house: &mut House, unpaid: [bool; MAX_SEATS], now: i64) -> Result<[u64; MAX_SEATS]> {
    let payouts = table.payouts()?;
    require!(table.held == table.pot()?, GameError::CustodyShort);
    let mut owed = 0;
    for seat in 0..MAX_SEATS {
        if unpaid[seat] {
            owed += payouts[seat];
        } else if payouts[seat] > 0 {
            table.debit(house, payouts[seat])?;
        }
    }
    let fee = table.held - owed;
    table.debit(house, fee)?;
    table.record_settlement(payouts, unpaid, now)?;
    Ok(payouts)
}

/// A started game with turn order forced to seat order and seat 0 to act.
fn playing(players: usize, target: u64) -> EphemeralTable {
    let mut table = lobby(players, target);
    table.start(wallets()[0], T0).unwrap();
    table.consume_randomness([9; 32], table.vrf_nonce, T0).unwrap();
    table.order = [0, 1, 2, 3];
    table.turn = 0;
    table
}

fn roll(table: &mut EphemeralTable, value: u8, now: i64) {
    let seat = table.current_seat();
    table.roll(table.seats[seat].wallet, now).unwrap();
    table.consume_randomness(die(value), table.vrf_nonce, now).unwrap();
}

#[test]
fn lobby_validates_config_nonce_capacity_and_refunds_free_the_table() {
    let w = wallets();
    let mut free = EphemeralTable::default();
    assert!(free.open(w[0], name("h"), 2 * USDC, 3, 2500, 0, 1500, T0).is_err());
    assert!(free.open(w[0], name("h"), USDC, 5, 2500, 0, 1500, T0).is_err());
    assert!(free.open(w[0], name("h"), USDC, 1, 2500, 0, 1500, T0).is_err());
    assert!(free.open(w[0], name("h"), USDC, 3, 4000, 0, 1500, T0).is_err());
    assert!(free.open(w[0], name("h"), USDC, 3, 2500, BOARD_THEMES, 1500, T0).is_err(), "unknown board theme");
    // Start cash is one of the three options, and the target is a standard one moved by the same amount.
    assert!(free.open(w[0], name("h"), USDC, 3, 2500, 0, 1200, T0).is_err(), "start cash off the list");
    assert!(free.open(w[0], name("h"), USDC, 3, 2500, 0, 0, T0).is_err(), "zero start cash");
    assert!(free.open(w[0], name("h"), USDC, 3, 2500, 0, 2000, T0).is_err(), "$2,000 start keeps the $1,500 target");
    assert!(free.open(w[0], name("h"), USDC, 3, 3000, 0, 1500, T0).is_err(), "moved target without the start cash");
    assert!(free.open(w[0], name("h"), USDC, 3, 400, 0, 2000, T0).is_err(), "target below the start difference");
    assert!(free.open(w[0], name("h"), USDC, 3, u64::MAX, 0, 1000, T0).is_err(), "target overflow");
    assert!(encode_name("  ").is_err());
    assert!(encode_name("seventeen bytes!!").is_err());
    free.open(w[0], name("h"), USDC, 2, 2500, 0, 1500, T0).unwrap();
    assert!(free.open(w[1], name("x"), USDC, 2, 2500, 0, 1500, T0).is_err());
    assert!(free.join(w[0], name("dup"), 1, T0).is_err());
    assert!(free.join(w[1], name("stale"), 0, T0).is_err());
    assert!(free.start(w[0], T0).is_err(), "one player cannot start");
    free.join(w[1], name("g"), 1, T0 + 1).unwrap();
    assert!(free.join(w[2], name("full"), 1, T0).is_err());
    assert!(free.cancel_or_expire(w[1], T0 + LOBBY_SECONDS - 1).is_err());
    free.cancel_or_expire(w[1], T0 + LOBBY_SECONDS).unwrap();
    assert_eq!(free.phase, TablePhase::Refunding);
    assert_eq!(free.stage_deadline, T0 + LOBBY_SECONDS + REFUND_GRACE_SECONDS, "the refund grace starts");
    assert_eq!(free.refund(1, T0 + 700).unwrap(), (w[1], free.entry), "an unfinished game refunds the entry");
    assert!(free.refund(1, T0 + 700).is_err());
    assert!(free.refund(2, T0 + 700).is_err());
    assert_eq!((free.phase, free.freed_at), (TablePhase::Refunding, 0));
    assert_eq!(free.refund(0, T0 + 800).unwrap(), (w[0], free.entry));
    assert_eq!((free.phase, free.freed_at), (TablePhase::Free, T0 + 800), "the last refund frees the table");

    let mut expired = lobby(2, 2500);
    assert!(expired.join(w[2], name("late"), 1, T0 + LOBBY_SECONDS).is_err());
    assert!(expired.start(w[0], T0 + LOBBY_SECONDS).is_err());
    expired.cancel_or_expire(w[0], T0 + 1).unwrap();
}

#[test]
fn turn_order_is_a_permutation_with_the_seat_bonus_for_each_target() {
    for (target, step) in [(2500, 40), (5000, 75), (7000, 100)] {
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
                assert_eq!(table.seats[*seat as usize].cash, 1500 + step * place as i64);
            }
            assert_eq!((table.stage, table.turn, table.round), (Stage::PreRoll, 0, 1));
            assert_eq!(table.stage_deadline, T0 + 1 + PREROLL_SECONDS);
            assert_eq!(table.vrf_purpose, VrfPurpose::None);
        }
    }
}

#[test]
fn start_cash_sets_every_seat_and_moves_the_target() {
    let w = wallets();
    for (start, target, step) in [(1000, 2000, 40), (1000, 6500, 100), (2000, 3000, 40), (2000, 5500, 75), (2000, 7500, 100)] {
        let mut table = EphemeralTable::default();
        table.open(w[0], name("host"), USDC, MAX_SEATS as u8, target, 0, start, T0).unwrap();
        assert_eq!((table.start_cash, table.target), (start, target));
        for (i, wallet) in w.iter().enumerate().skip(1) {
            table.join(*wallet, name(&format!("p{i}")), table.game_nonce, T0).unwrap();
        }
        table.start(w[0], T0).unwrap();
        table.consume_randomness([5; 32], table.vrf_nonce, T0 + 1).unwrap();
        for (place, seat) in table.order.iter().enumerate() {
            assert_eq!(table.seats[*seat as usize].cash, start as i64 + step * place as i64, "${start} start, ${target} target");
        }
    }
}

#[test]
fn a_lobby_opened_before_start_cash_existed_plays_the_standard_start() {
    // The field reads 0 on such a lobby; its target is a standard one.
    let mut table = lobby(4, 5000);
    table.start_cash = 0;
    table.start(wallets()[0], T0).unwrap();
    table.consume_randomness([3; 32], table.vrf_nonce, T0 + 1).unwrap();
    for (place, seat) in table.order.iter().enumerate() {
        assert_eq!(table.seats[*seat as usize].cash, 1500 + 75 * place as i64);
    }
}

#[test]
fn movement_salary_buy_and_pass() {
    let mut table = playing(3, 7000);
    table.seats[0].position = 24;
    let cash = table.seats[0].cash;
    roll(&mut table, 4, T0 + 2);
    assert_eq!(table.seats[0].position, 0);
    assert_eq!(table.seats[0].cash, cash + SALARY, "landing on Start pays salary");
    assert_eq!((table.turn, table.stage), (1, Stage::PreRoll));
    assert!(table.roll(wallets()[0], T0 + 3).is_err(), "not seat 0's turn");

    table.seats[1].position = 27;
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

    roll(&mut table, 3, T0 + 5);
    assert_eq!(table.stage, Stage::BuyDecision, "Railway");
    table.pass(wallets()[2], T0 + 6).unwrap();
    assert_eq!(table.board[3].owner, NO_OWNER);
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
    assert_eq!(table.rent(1), 180, "building multipliers apply with the full group");
    table.board[2].owner = NO_OWNER;
    assert_eq!(table.rent(1), 6, "a broken group falls back to base rent");
    table.board[1].buildings = 0;
    for (count, space) in [3usize, 10, 17, 24].iter().enumerate() {
        table.board[*space].owner = 1;
        assert_eq!(table.rent(3), 25 * (count as i64 + 1));
    }

    table.board[2].owner = 1;
    let (payer, owner) = (table.seats[0].cash, table.seats[1].cash);
    roll(&mut table, 2, T0 + 1);
    assert_eq!(table.seats[0].cash, payer - 16);
    assert_eq!(table.seats[1].cash, owner + 16);
    table.board[4].owner = 0;
    roll(&mut table, 3, T0 + 2);
    assert_eq!(table.seats[1].position, 3);
    assert_eq!(table.stage, Stage::PreRoll, "own public: no rent, no buy");
    let (payer, owner) = (table.seats[0].cash, table.seats[1].cash);
    roll(&mut table, 1, T0 + 3);
    assert_eq!(table.seats[0].position, 3);
    assert_eq!(table.seats[0].cash, payer - 100, "four publics: 4 x 25");
    assert_eq!(table.seats[1].cash, owner + 100);
}

#[test]
fn a_six_grants_another_roll_up_to_three_per_turn() {
    let mut table = playing(2, 7000);
    // Each roll starts on Madrid (8) and lands on Auction (14), a no-op while nobody owns anything.
    table.seats[0].position = 8;
    roll(&mut table, 6, T0 + 1);
    assert_eq!((table.seats[0].position, table.turn, table.stage), (14, 0, Stage::PreRoll));
    assert_eq!(table.stage_deadline, T0 + 1 + PREROLL_SECONDS);
    table.seats[0].position = 8;
    roll(&mut table, 6, T0 + 2);
    assert_eq!((table.seats[0].position, table.turn, table.rolls_this_turn), (14, 0, 2));
    table.seats[0].position = 8;
    roll(&mut table, 6, T0 + 3);
    assert_eq!(table.seats[0].position, 14);
    assert_eq!((table.turn, table.rolls_this_turn), (1, 0), "a third 6 gives no further roll");

    table.seats[1].position = 2;
    roll(&mut table, 6, T0 + 4);
    assert_eq!(table.stage, Stage::BuyDecision, "Madrid");
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
    table.seats[1].position = 2;
    roll(&mut table, 6, deadline + 1);
    assert_eq!(table.stage, Stage::BuyDecision, "Madrid");
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!((table.seats[1].strikes, table.board[8].owner, table.turn), (1, NO_OWNER, 2));

    // Seat 2 keeps playing onto Auction (a no-op with nothing owned) while seats 0 and 1 stay away.
    for _ in 0..2 {
        table.seats[2].position = 11;
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
    let mut table = playing(3, 2500);
    table.seats[0].cash = 2_350;
    table.seats[0].position = 23;
    roll(&mut table, 1, T0 + 1);
    assert_eq!(table.phase, TablePhase::Playing, "net worth 2350 + Power Plant would need a buy");
    table.buy(wallets()[0], T0 + 2).unwrap();
    assert_eq!(table.phase, TablePhase::Playing, "buying keeps net worth");
    table.seats[1].position = 27;
    table.seats[1].cash = 2_300;
    roll(&mut table, 1, T0 + 3);
    assert_eq!(table.phase, TablePhase::Finished, "salary lifts seat 1 to 2500");
    assert_eq!((table.stage, table.ended_at, table.vrf_purpose), (Stage::Idle, T0 + 3, VrfPurpose::None));
    assert!(table.roll(wallets()[2], T0 + 4).is_err());
    assert!(table.force_timeout(T0 + 5).is_err());
}

#[test]
fn rent_that_bankrupts_eliminates_the_payer() {
    let mut table = playing(2, 7000);
    for space in [25, 26, 27] {
        table.board[space] = Lot { owner: 1, buildings: 3 };
    }
    table.seats[0].cash = -50;
    table.seats[0].position = 26;
    let owner = table.seats[1].cash;
    roll(&mut table, 1, T0 + 1);
    assert_eq!(table.seats[0].eliminated_at, 1, "-50 - 1200 leaves net worth below zero");
    assert_eq!(table.seats[1].cash, owner + 1200, "New York, full Dark Blue, 3 buildings: 40 x 30");
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
    assert_eq!(
        table.stage_deadline,
        idle + EMERGENCY_SECONDS + REFUND_GRACE_SECONDS
    );
    let mut house = house_of(&table);
    let now = idle + EMERGENCY_SECONDS + 1;
    for seat in 0..3 {
        if ranked[seat] == 0 {
            assert!(
                table.seats[seat].refunded,
                "a seat with nothing to receive is done at the switch"
            );
            assert!(table.refund(seat, now).is_err());
            continue;
        }
        let (wallet, amount) = table.refund(seat, now).unwrap();
        assert_eq!((wallet, amount), (wallets()[seat], ranked[seat]), "a finished game refunds its ranked payout");
        table.debit(&mut house, amount).unwrap();
    }
    assert_eq!(table.phase, TablePhase::Free);
    // The last refund sends what the table still holds, the fee and dust, to the treasury.
    assert_eq!(table.held, 3 * USDC - 2_010_000 - 900_000);
    let rest = table.held;
    table.debit(&mut house, rest).unwrap();
    assert_eq!((table.held, house.liability), (0, 0));

    // A table nobody touched until long after the idle deadline still ends by ranking.
    let mut stuck = playing(2, 2500);
    stuck.roll(wallets()[0], T0 + 11).unwrap();
    assert_eq!(stuck.stage, Stage::Rolling);
    let late = T0 + 11 + IDLE_SECONDS + EMERGENCY_SECONDS;
    stuck.force_timeout(late).unwrap();
    assert_eq!((stuck.phase, stuck.vrf_purpose, stuck.ended_at), (TablePhase::Finished, VrfPurpose::None, late));
    assert!(stuck.consume_randomness(die(1), stuck.vrf_nonce, T0).is_err(), "late callback after the end");
    assert!(stuck.force_timeout(late + EMERGENCY_SECONDS - 1).is_err(), "settle always gets a full window after the end");
    stuck.force_timeout(late + EMERGENCY_SECONDS).unwrap();
    assert_eq!(stuck.phase, TablePhase::Refunding);

    let mut unordered = lobby(2, 2500);
    unordered.start(wallets()[0], T0).unwrap();
    unordered.force_timeout(T0 + IDLE_SECONDS).unwrap();
    assert_eq!(unordered.phase, TablePhase::Refunding, "no turn order: refund instead of ranking");
}

/// Everyone left; the first player back is the current seat. Its own actions must not revive the
/// game (which would let it strike out the absent seats); one `force_timeout` ends it by ranking.
#[test]
fn after_the_idle_deadline_no_player_action_revives_the_game_and_one_timeout_ranks_it() {
    let w = wallets();
    let mut table = playing(3, 7000);
    for (seat, cash) in [2000, 2900, 2000].into_iter().enumerate() {
        table.seats[seat].cash = cash;
    }
    table.board[1].owner = 2;
    let idle = table.last_action_at + IDLE_SECONDS;
    let before = table.clone();
    assert!(
        table.roll(w[0], idle).is_err(),
        "the returning current seat cannot roll"
    );
    assert!(
        table.pass(w[0], idle).is_err()
            && table.build(w[0], 1, idle).is_err()
            && table.sell(w[0], 1, idle).is_err()
    );
    assert!(
        table.pay_bail(w[0], idle).is_err()
            && table.buy(w[0], idle).is_err()
            && table.open_trade(w[0], 1, idle).is_err()
    );
    assert_eq!(
        table, before,
        "rejected after the idle deadline, nothing changed"
    );

    // Spamming the timeout is idempotent: the first call ranks, the rest fail until the emergency.
    table.force_timeout(idle).unwrap();
    let ended = table.clone();
    for later in [idle, idle + 1, idle + EMERGENCY_SECONDS - 1] {
        assert!(table.force_timeout(later).is_err());
        assert_eq!(table, ended);
    }
    assert_eq!(table.phase, TablePhase::Finished);
    assert!(
        table
            .seats
            .iter()
            .all(|seat| seat.strikes == 0 && seat.eliminated_at == 0),
        "no forfeits"
    );
    // Ranked by net worth: seat 1 has the most cash, seat 2 holds a property.
    assert_eq!(table.payouts().unwrap(), [0, 2_010_000, 900_000, 0]);

    // The same holds in Rolling (a re-request would bump the idle clock) and in Ordering.
    let mut rolling = playing(2, 2500);
    rolling.roll(w[0], T0).unwrap();
    let idle = rolling.last_action_at + IDLE_SECONDS;
    assert!(rolling.roll(w[0], idle).is_err() && rolling.roll(w[1], idle).is_err());
    let mut ordering = lobby(2, 2500);
    ordering.start(w[0], T0).unwrap();
    assert!(ordering.start(w[1], T0 + IDLE_SECONDS).is_err());
    let mut offers = auction(3, 7000, 8, 6, &[(1, 0), (2, 1)]);
    offers.open_trade(w[0], 1, T0).unwrap();
    assert!(offers.offer_trade(w[1], 2, T0 + IDLE_SECONDS).is_err());
}

/// Stage timeouts spammed at one instant strike once; every repeat is rejected without change.
#[test]
fn force_timeout_spam_is_idempotent() {
    let mut table = playing(3, 7000);
    let deadline = table.stage_deadline;
    for _ in 0..20 {
        assert!(table.force_timeout(deadline - 1).is_err());
    }
    table.force_timeout(deadline).unwrap();
    let after = table.clone();
    for _ in 0..20 {
        assert!(table.force_timeout(deadline).is_err());
        assert_eq!(table, after);
    }
    assert_eq!((table.seats[0].strikes, table.current_seat()), (1, 1));
}

#[test]
fn vrf_callbacks_need_the_pending_nonce_and_retries_bump_it() {
    let mut table = lobby(2, 2500);
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

/// A VRF outage cannot keep a game alive forever: re-requests are not player actions, so the idle
/// deadline still runs from the last real action and then ends the game by ranking.
#[test]
fn vrf_re_requests_do_not_move_the_idle_deadline() {
    let mut table = lobby(3, 7000);
    table.start(wallets()[0], T0).unwrap();
    table.start(wallets()[1], T0 + VRF_RETRY_SECONDS).unwrap();
    assert_eq!(table.last_action_at, T0, "an order re-request is not an action");
    table.consume_randomness([9; 32], table.vrf_nonce, T0 + 20).unwrap();
    table.order = [0, 1, 2, 3];
    table.turn = 0;
    table.roll(wallets()[0], T0 + 30).unwrap();
    let mut now = T0 + 30;
    while now + VRF_RETRY_SECONDS < T0 + 30 + IDLE_SECONDS {
        now += VRF_RETRY_SECONDS;
        table.roll(wallets()[0], now).unwrap();
    }
    assert_eq!(table.last_action_at, T0 + 30);
    assert!(table.roll(wallets()[0], T0 + 30 + IDLE_SECONDS).is_err(), "past idle, no retry");
    table.force_timeout(T0 + 30 + IDLE_SECONDS).unwrap();
    assert_eq!(table.phase, TablePhase::Finished);
    assert!(table.seats.iter().all(|seat| seat.strikes == 0), "ended by ranking, nobody struck");
}

/// A paid seat whose token accounts were gone at settle keeps its share in custody: the table
/// waits in Refunding for that seat alone, which then pulls its ranked share.
#[test]
fn settlement_with_an_unpaid_seat_waits_in_refunding_for_that_seat_only() {
    let mut table = playing(3, 7000);
    table
        .force_timeout(table.last_action_at + IDLE_SECONDS)
        .unwrap();
    let payouts = table.payouts().unwrap();
    let second = (0..3).find(|&seat| payouts[seat] == 900_000).unwrap();
    let mut unpaid = [false; MAX_SEATS];
    unpaid[second] = true;
    let mut house = house_of(&table);
    settle(&mut table, &mut house, unpaid, T0 + 50).unwrap();
    assert_eq!(
        (table.phase, table.stage_deadline),
        (TablePhase::Refunding, T0 + 50 + REFUND_GRACE_SECONDS)
    );
    assert_eq!((table.held, house.liability), (900_000, 900_000), "only the unpaid share stays held");
    for seat in (0..3).filter(|&seat| seat != second) {
        assert!(
            table.seats[seat].refunded && table.refund(seat, T0 + 60).is_err(),
            "paid or nothing owed"
        );
    }
    assert_eq!(table.refund(second, T0 + 60).unwrap(), (wallets()[second], 900_000));
    table.debit(&mut house, 900_000).unwrap();
    assert_eq!((table.phase, table.freed_at, table.held, house.liability), (TablePhase::Free, T0 + 60, 0, 0));
}

#[test]
fn open_resets_every_game_field_but_keeps_identity_and_nonces() {
    let mut table = playing(4, 5000);
    roll(&mut table, 1, T0 + 1);
    table.buy(wallets()[0], T0 + 2).unwrap();
    table.seats[3].strikes = 2;
    table.force_timeout(table.last_action_at + IDLE_SECONDS).unwrap();
    let mut house = house_of(&table);
    settle(&mut table, &mut house, [false; MAX_SEATS], T0 + 9_000).unwrap();
    assert_eq!((table.phase, table.freed_at, table.held), (TablePhase::Free, T0 + 9_000, 0));
    let (game_nonce, vrf_nonce) = (table.game_nonce, table.vrf_nonce);
    let host = wallets()[0];
    table.open(host, name("next"), 5 * USDC, 2, 2500, 0, 1500, T0 + 9_000).unwrap();
    let mut fresh = EphemeralTable {
        bump: 250,
        game_nonce: game_nonce + 1,
        vrf_nonce,
        phase: TablePhase::Lobby,
        host,
        entry: 5 * USDC,
        max_players: 2,
        target: 2500,
        start_cash: 1500,
        player_count: 1,
        lobby_deadline: T0 + 9_000 + LOBBY_SECONDS,
        last_action_at: T0 + 9_000,
        ..EphemeralTable::default()
    };
    fresh.seats[0].wallet = host;
    fresh.seats[0].name = name("next");
    assert_eq!(table, fresh);
}

fn finished(nets: &[i64], eliminated: &[u8]) -> EphemeralTable {
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
    assert!(playing(2, 2500).payouts().is_err(), "only a finished game pays out");
}

#[test]
fn a_tenth_of_a_cent_entry_opens_and_pays_out_without_losing_the_fee() {
    let w = wallets();
    let mut free = EphemeralTable::default();
    free.open(w[0], name("h"), ENTRIES[0], 2, 2500, 0, 1500, T0).unwrap();
    assert_eq!(free.entry, 1_000);
    for (nets, eliminated, expected) in [
        (&[3000i64, 2000][..], &[0u8, 0][..], [1_940, 0, 0, 0]),
        (&[4000, 3000, 2000, 1000][..], &[0, 0, 0, 0][..], [2_400, 1_080, 400, 0]),
        (&[4000, 4000, 4000, 1000][..], &[0, 0, 0, 0][..], [1_293, 1_293, 1_293, 0]),
    ] {
        let mut table = finished(nets, eliminated);
        table.entry = ENTRIES[0];
        let payouts = table.payouts().unwrap();
        assert_eq!(payouts, expected, "nets {nets:?}");
        let pot = table.pot().unwrap();
        assert!(payouts.iter().sum::<u64>() <= pot - pot * FEE_BPS / 10_000, "fee always reaches the treasury");
    }
}

/// Size of an ephemeral table (table_v2 base accounts were 1,503 bytes).
const EPHEMERAL_TABLE_SPACE: usize = 566;

#[test]
fn board_constants_match_the_frozen_economy() {
    assert_eq!(BOARD.len(), 28);
    assert_eq!(BOARD[27].price, 400);
    assert_eq!([BOARD[0].kind, BOARD[7].kind, BOARD[14].kind, BOARD[21].kind], [SpaceKind::Start, SpaceKind::Jail, SpaceKind::Auction, SpaceKind::Lucky], "the four corners");
    assert_eq!(SHARES_BPS.iter().map(|row| row.iter().sum::<u64>() + FEE_BPS).collect::<Vec<_>>(), [10_000; 3]);
    // Every table is created at this size; new fields come out of TABLE_RESERVED.
    assert_eq!(TABLE_SPACE, EPHEMERAL_TABLE_SPACE);
    assert_eq!(EphemeralTable::INIT_SPACE + 8 + TABLE_RESERVED, EPHEMERAL_TABLE_SPACE);
    // The house sponsors (size + 60) x 32 lamports per open table and gets it back on close.
    assert_eq!(ephemeral_rollups_sdk::ephemeral_accounts::rent(TABLE_SPACE as u32), 20_032);
    assert_eq!(HOUSE_SPACE, 8 + 17 + HOUSE_RESERVED);
}

// ---- Ephemeral tables: shared vault bookkeeping and lifecycle ----

/// Two tables share one house. Every entry in is credited and every payout debited against the
/// acting table, `liability` always equals the sum of `held`, and both end at zero.
#[test]
fn held_and_liability_track_entries_refunds_and_settlement_across_tables() {
    let w = wallets();
    let mut house = House::default();
    let mut a = EphemeralTable::new(w[0], 1, house.next_table_nonce().unwrap());
    let mut b = EphemeralTable::new(w[2], 2, house.next_table_nonce().unwrap());
    a.open(w[0], name("a"), USDC, 3, 2500, 0, 1500, T0).unwrap();
    a.credit(&mut house, USDC).unwrap();
    b.open(w[2], name("b"), 5 * USDC, 2, 2500, 0, 1500, T0).unwrap();
    b.credit(&mut house, 5 * USDC).unwrap();
    for wallet in [w[1], w[3]] {
        a.join(wallet, name("g"), a.game_nonce, T0).unwrap();
        a.credit(&mut house, USDC).unwrap();
    }
    b.join(w[0], name("g"), b.game_nonce, T0).unwrap();
    b.credit(&mut house, 5 * USDC).unwrap();
    assert_eq!((a.held, b.held, house.liability), (3 * USDC, 10 * USDC, 13 * USDC));

    // A table never pays out more than it holds, even when the house as a whole could.
    let (before_a, before_house) = (a.clone(), house.clone());
    assert_eq!(a.debit(&mut house, 3 * USDC + 1).unwrap_err(), error!(GameError::HeldExceeded));
    assert_eq!((&a, &house), (&before_a, &before_house), "a rejected debit changes nothing");

    // Table A's lobby is cancelled and refunded; table B plays and settles.
    a.cancel_or_expire(w[0], T0 + 1).unwrap();
    for seat in 0..3 {
        let (_, amount) = a.refund(seat, T0 + 2).unwrap();
        a.debit(&mut house, amount).unwrap();
        assert_eq!(house.liability, a.held + b.held);
    }
    assert_eq!((a.phase, a.held), (TablePhase::Free, 0));
    b.start(w[2], T0).unwrap();
    b.consume_randomness([1; 32], b.vrf_nonce, T0).unwrap();
    b.seats[0].cash += 5_000;
    b.force_timeout(b.last_action_at + IDLE_SECONDS).unwrap();
    let payouts = settle(&mut b, &mut house, [false; MAX_SEATS], T0 + 4_000).unwrap();
    assert_eq!(payouts.iter().sum::<u64>(), 9_700_000);
    assert_eq!((b.phase, b.held, house.liability), (TablePhase::Free, 0, 0));
}

/// Settlement must leave exactly the unpaid shares held, and only a table holding its whole pot
/// can settle.
#[test]
fn settlement_requires_the_whole_pot_and_leaves_only_unpaid_shares() {
    let mut table = playing(2, 2500);
    table.force_timeout(table.last_action_at + IDLE_SECONDS).unwrap();
    let payouts = table.payouts().unwrap();
    let before = table.clone();
    assert!(table.record_settlement(payouts, [false; MAX_SEATS], T0).is_err(), "nothing was paid out yet");
    assert_eq!(table, before);
    let mut short = table.clone();
    let mut house = house_of(&short);
    short.debit(&mut house, 1).unwrap();
    assert_eq!(settle(&mut short, &mut house, [false; MAX_SEATS], T0).unwrap_err(), error!(GameError::CustodyShort));
}

/// The host's table re-opens in place only once it is Free and holds nothing.
#[test]
fn open_re_opens_only_a_free_table_that_holds_nothing() {
    let w = wallets();
    let reopen = |table: &mut EphemeralTable| table.open(w[0], name("h"), USDC, 2, 2500, 0, 1500, T0 + 5);
    let mut lobby_table = lobby(2, 2500);
    assert!(reopen(&mut lobby_table).is_err(), "Lobby");
    let mut table = playing(2, 2500);
    assert!(reopen(&mut table).is_err(), "Playing");
    table.force_timeout(table.last_action_at + IDLE_SECONDS).unwrap();
    assert!(reopen(&mut table).is_err(), "Finished");
    table.force_timeout(table.last_action_at + IDLE_SECONDS + EMERGENCY_SECONDS).unwrap();
    assert!(reopen(&mut table).is_err(), "Refunding");
    let mut stray = EphemeralTable { held: 1, ..EphemeralTable::new(w[0], 1, 0) };
    let before = stray.clone();
    assert_eq!(reopen(&mut stray).unwrap_err(), error!(GameError::CustodyNotEmpty), "Free but still holding money");
    assert_eq!(stray, before);
    let mut free = EphemeralTable::new(w[0], 1, 7 << 32);
    reopen(&mut free).unwrap();
    assert_eq!((free.phase, free.game_nonce, free.vrf_nonce), (TablePhase::Lobby, (7 << 32) + 1, 7 << 32));
}

/// Anyone may close a table only once it is Free, holds nothing, and the grace has passed.
#[test]
fn close_needs_a_free_empty_table_after_the_grace() {
    let mut table = lobby(2, 2500);
    assert_eq!(table.require_closable(T0 + 100_000).unwrap_err(), error!(GameError::InvalidPhase));
    let mut house = house_of(&table);
    table.cancel_or_expire(wallets()[0], T0 + 10).unwrap();
    for seat in 0..2 {
        let (_, amount) = table.refund(seat, T0 + 20 + seat as i64).unwrap();
        table.debit(&mut house, amount).unwrap();
    }
    assert_eq!(table.freed_at, T0 + 21, "the grace runs from the last refund");
    assert_eq!(table.require_closable(T0 + 21 + CLOSE_GRACE_SECONDS - 1).unwrap_err(), error!(GameError::TooEarly));
    table.require_closable(T0 + 21 + CLOSE_GRACE_SECONDS).unwrap();
    table.held = 1;
    assert_eq!(table.require_closable(T0 + 21 + CLOSE_GRACE_SECONDS).unwrap_err(), error!(GameError::CustodyNotEmpty));

    // After a settled game the grace runs from the settlement.
    let mut settled = playing(2, 2500);
    settled.force_timeout(settled.last_action_at + IDLE_SECONDS).unwrap();
    let mut house = house_of(&settled);
    settle(&mut settled, &mut house, [false; MAX_SEATS], T0 + 5_000).unwrap();
    assert!(settled.require_closable(T0 + 5_000 + CLOSE_GRACE_SECONDS - 1).is_err());
    settled.require_closable(T0 + 5_000 + CLOSE_GRACE_SECONDS).unwrap();
}

/// Each created table starts both nonces at `tables_created << 32`, so a callback or invite from
/// an earlier incarnation at the same address can never match the new one.
#[test]
fn created_tables_get_disjoint_nonce_ranges_and_stale_callbacks_or_invites_fail() {
    let w = wallets();
    let mut house = House::default();
    assert_eq!([0, 1, 2].map(|_| house.next_table_nonce().unwrap()), [0, 1 << 32, 2 << 32]);
    assert_eq!(house.tables_created, 3);

    // Incarnation 0 of the host's table leaves a roll pending and an invite outstanding.
    let mut old = playing(2, 2500);
    old.roll(w[0], T0 + 1).unwrap();
    let (stale_vrf, stale_invite) = (old.vrf_nonce, old.game_nonce);
    // Incarnation 3 at the same address, after a close and a re-create.
    let mut new = EphemeralTable::new(w[0], old.bump, house.next_table_nonce().unwrap());
    new.open(w[0], name("h"), USDC, 3, 2500, 0, 1500, T0 + 2).unwrap();
    assert_eq!(new.join(w[1], name("g"), stale_invite, T0 + 2).unwrap_err(), error!(GameError::StaleNonce));
    new.join(w[1], name("g"), new.game_nonce, T0 + 2).unwrap();
    new.join(w[2], name("g"), new.game_nonce, T0 + 2).unwrap();
    new.start(w[0], T0 + 3).unwrap();
    assert!(new.vrf_nonce > stale_vrf && new.vrf_nonce >> 32 == 3);
    let before = new.clone();
    assert_eq!(new.consume_randomness([1; 32], stale_vrf, T0 + 4).unwrap_err(), error!(GameError::UnexpectedRandomness));
    assert_eq!(new, before, "a stale callback changes nothing");

    let mut full = House { tables_created: 1 << 32, ..House::default() };
    assert!(full.next_table_nonce().is_err(), "the nonce ranges never wrap");
}

// ---- Phase 03: full rules ----

/// Randomness that rolls `value` and, if the roll lands on a Lucky space, draws card `card` (1-12).
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

/// Seat 0 rolls `value` from `from` with every seat's cash set to `cash`, drawing `card`.
fn draw_from(players: usize, from: u8, value: u8, card: u8, cash: i64) -> EphemeralTable {
    let mut table = playing(players, 7000);
    for seat in &mut table.seats[..players] {
        seat.cash = cash;
    }
    table.seats[0].position = from;
    table.roll(wallets()[0], T0 + 1).unwrap();
    table.consume_randomness(die_and_card(value, card), table.vrf_nonce, T0 + 1).unwrap();
    table
}

#[test]
fn lucky_bank_cards_collect_or_pay() {
    for (card, delta) in [(1u8, 200i64), (2, 100), (3, 50), (4, -100), (5, -50)] {
        let table = draw_from(3, 18, 3, card, 1000);
        assert_eq!(table.last_card, card);
        assert_eq!(table.seats[0].position, 21);
        assert_eq!(table.seats[0].cash, 1000 + delta, "card {card}");
        assert_eq!((table.turn, table.stage), (1, Stage::PreRoll));
    }
    let table = draw_from(2, 18, 3, 4, 90);
    assert_eq!(table.seats[0].eliminated_at, 1, "paying the bank into net worth <= 0 bankrupts");
    assert_eq!(table.phase, TablePhase::Finished);
}

#[test]
fn lucky_card_6_pays_each_other_active_player() {
    let mut table = playing(3, 7000);
    for seat in &mut table.seats[..3] {
        seat.cash = 1000;
    }
    table.seats[2].eliminated_at = 1;
    table.seats[2].cash = 0;
    table.elimination_seq = 1;
    table.seats[0].position = 18;
    table.roll(wallets()[0], T0 + 1).unwrap();
    table.consume_randomness(die_and_card(3, 6), table.vrf_nonce, T0 + 1).unwrap();
    assert_eq!(table.last_card, 6);
    assert_eq!([table.seats[0].cash, table.seats[1].cash, table.seats[2].cash], [950, 1050, 0]);

    let table = draw_from(4, 18, 3, 6, 1000);
    assert_eq!([table.seats[0].cash, table.seats[1].cash, table.seats[3].cash], [850, 1050, 1050]);
}

#[test]
fn lucky_card_7_collects_from_each_and_shares_one_elimination_mark() {
    let table = draw_from(4, 18, 3, 7, 1000);
    assert_eq!(table.seats[..4].iter().map(|seat| seat.cash).collect::<Vec<_>>(), [1030, 990, 990, 990]);

    // Two payers already at -495 with land holdings drop below -500 in the same callback.
    let mut table = playing(3, 7000);
    table.seats[0].cash = 1000;
    for seat in [1usize, 2] {
        table.seats[seat].cash = -495;
    }
    table.board[27].owner = 1;
    table.board[25].owner = 2;
    table.seats[0].position = 18;
    table.roll(wallets()[0], T0 + 1).unwrap();
    table.consume_randomness(die_and_card(3, 7), table.vrf_nonce, T0 + 1).unwrap();
    assert_eq!((table.seats[1].eliminated_at, table.seats[2].eliminated_at), (1, 1));
    assert_eq!(table.elimination_seq, 1);
    assert_eq!(table.seats[0].cash, 1020, "the drawer collects from bankrupt payers too");
    assert_eq!((table.board[27].owner, table.board[25].owner), (NO_OWNER, NO_OWNER));
    assert_eq!(table.phase, TablePhase::Finished, "one active seat left");
    assert_eq!(table.payouts().unwrap(), [2_010_000, 450_000, 450_000, 0], "same mark ties for 2nd");
}

#[test]
fn lucky_card_8_advances_to_start_with_salary() {
    let table = draw_from(2, 18, 3, 8, 1000);
    assert_eq!((table.seats[0].position, table.seats[0].cash), (0, 1200));
}

#[test]
fn lucky_card_9_sends_to_jail_without_salary_and_cancels_the_extra_roll() {
    let table = draw_from(2, 15, 6, 9, 1000);
    assert_eq!((table.seats[0].position, table.seats[0].jail_turns, table.seats[0].cash), (JAIL_SPACE as u8, 3, 1000));
    assert!(!table.extra_roll, "a 6 onto Lucky then Jail gives no extra roll");
    assert_eq!(table.turn, 1);
}

#[test]
fn lucky_move_cards_resolve_the_destination_and_never_draw_again() {
    // Lucky Card (21) is the only Lucky space, so a move card (+/-3) can never draw a second card,
    // reach Jail or Auction, or cross Start: it always resolves a property landing.
    // Card 10 from 21 lands on an unowned Power Plant (24): a buy decision.
    let mut table = draw_from(2, 15, 6, 10, 1000);
    assert_eq!((table.seats[0].position, table.last_card, table.stage), (24, 10, Stage::BuyDecision));
    table.buy(wallets()[0], T0 + 2).unwrap();
    assert_eq!((table.board[24].owner, table.seats[0].cash), (0, 800));
    assert_eq!((table.turn, table.stage), (0, Stage::PreRoll), "the 6 still grants its extra roll");
    // Card 10 from 21 onto an owned Power Plant pays rent.
    let mut table = playing(2, 7000);
    table.board[24].owner = 1;
    table.seats[0].position = 15;
    let (payer, owner) = (table.seats[0].cash, table.seats[1].cash);
    table.roll(wallets()[0], T0 + 1).unwrap();
    table.consume_randomness(die_and_card(6, 10), table.vrf_nonce, T0 + 1).unwrap();
    assert_eq!((table.seats[0].cash, table.seats[1].cash), (payer - 25, owner + 25));

    // Card 11 from 21 lands back on an unowned Paris (18), with no salary and no second card.
    let table = draw_from(2, 18, 3, 11, 1000);
    assert_eq!((table.seats[0].position, table.last_card, table.seats[0].cash, table.stage), (18, 11, 1000, Stage::BuyDecision));
    // Card 11 onto an owned Paris pays rent.
    let mut table = playing(2, 7000);
    table.board[18].owner = 1;
    table.seats[0].position = 18;
    let (payer, owner) = (table.seats[0].cash, table.seats[1].cash);
    table.roll(wallets()[0], T0 + 1).unwrap();
    table.consume_randomness(die_and_card(3, 11), table.vrf_nonce, T0 + 1).unwrap();
    assert_eq!((table.seats[0].cash, table.seats[1].cash), (payer - 26, owner + 26));
}

#[test]
fn lucky_card_12_charges_repairs_per_building() {
    let mut table = playing(2, 7000);
    table.seats[0].cash = 1000;
    for space in [1usize, 2] {
        table.board[space] = Lot { owner: 0, buildings: 2 };
    }
    table.board[27] = Lot { owner: 1, buildings: 3 };
    table.seats[0].position = 18;
    table.roll(wallets()[0], T0 + 1).unwrap();
    table.consume_randomness(die_and_card(3, 12), table.vrf_nonce, T0 + 1).unwrap();
    assert_eq!(table.seats[0].cash, 900, "4 buildings x $25; others' buildings don't count");
}

#[test]
fn jail_by_roll_serves_three_turns_without_randomness() {
    let mut table = playing(2, 7000);
    table.seats[0].position = 1;
    roll(&mut table, 6, T0 + 1);
    assert_eq!((table.seats[0].position, table.seats[0].jail_turns), (7, 3));
    assert_eq!((table.turn, table.extra_roll), (1, false), "Jail cancels the extra roll from a 6");
    for left in [2u8, 1, 0] {
        table.seats[1].position = 13;
        roll(&mut table, 1, T0 + 2);
        let nonce = table.vrf_nonce;
        assert!(!table.roll(wallets()[0], T0 + 3).unwrap(), "a jailed roll requests no VRF");
        assert_eq!(table.vrf_nonce, nonce);
        assert_eq!((table.seats[0].jail_turns, table.seats[0].position), (left, 7));
        assert_eq!((table.turn, table.stage), (1, Stage::PreRoll), "serving ends the turn");
    }
    table.seats[1].position = 13;
    roll(&mut table, 1, T0 + 4);
    assert!(table.roll(wallets()[0], T0 + 5).unwrap(), "released: the next turn rolls normally");
}

#[test]
fn bail_releases_a_jailed_seat_and_ends_the_turn_without_moving() {
    let mut table = playing(2, 7000);
    table.seats[0].jail_turns = 3;
    table.seats[0].position = 7;
    table.seats[0].cash = 149;
    assert!(table.pay_bail(wallets()[0], T0 + 1).is_err(), "needs $150");
    table.seats[0].cash = -10;
    assert!(table.pay_bail(wallets()[0], T0 + 1).is_err(), "negative cash cannot pay bail");
    table.seats[0].cash = 1000;
    assert!(table.pay_bail(wallets()[1], T0 + 1).is_err(), "not seat 1's turn");
    table.pay_bail(wallets()[0], T0 + 1).unwrap();
    assert_eq!((table.seats[0].cash, table.seats[0].jail_turns, table.seats[0].position), (850, 0, 7));
    assert_eq!((table.turn, table.last_action_at), (1, T0 + 1));
    assert!(table.pay_bail(wallets()[1], T0 + 2).is_err(), "seat 1 is not jailed");

    let mut broke = playing(2, 7000);
    broke.seats[0].jail_turns = 2;
    broke.seats[0].cash = 150;
    broke.pay_bail(wallets()[0], T0 + 1).unwrap();
    assert_eq!(broke.seats[0].eliminated_at, 1, "bail that leaves net worth 0 bankrupts");
    assert_eq!(broke.phase, TablePhase::Finished);
}

#[test]
fn a_jailed_timeout_serves_the_turn_and_jailed_seats_still_collect_rent() {
    let mut table = playing(2, 7000);
    table.seats[0].jail_turns = 3;
    table.board[1].owner = 0;
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!((table.seats[0].jail_turns, table.seats[0].strikes, table.turn), (2, 1, 1));
    let (owner, payer) = (table.seats[0].cash, table.seats[1].cash);
    roll(&mut table, 1, T0 + 1);
    assert_eq!((table.seats[0].cash, table.seats[1].cash), (owner + 6, payer - 6));
}

#[test]
fn buildings_need_the_full_group_cap_at_a_hotel_and_scale_rent() {
    let mut table = playing(2, 7000);
    table.seats[0].cash = 1000;
    table.board[1].owner = 0;
    assert!(table.build(wallets()[0], 1, T0 + 1).is_err(), "Athens is not owned yet");
    table.board[2].owner = 0;
    assert!(table.build(wallets()[0], 3, T0 + 1).is_err(), "not owned");
    table.board[3].owner = 0;
    assert!(table.build(wallets()[0], 3, T0 + 1).is_err(), "publics take no buildings");
    assert!(table.build(wallets()[0], 30, T0 + 1).is_err(), "no such space");
    assert!(table.build(wallets()[1], 1, T0 + 1).is_err(), "not seat 1's turn");
    let worth = table.net_worth(0);
    for (built, rent) in [(1u8, 24i64), (2, 72), (3, 180), (4, 240), (5, 300)] {
        table.build(wallets()[0], 1, T0 + 1).unwrap();
        assert_eq!((table.board[1].buildings, table.rent(1)), (built, rent));
    }
    assert_eq!(table.seats[0].cash, 750);
    assert_eq!(table.net_worth(0), worth, "building converts cash into holdings");
    assert_eq!(table.rent(2), 16, "an unbuilt city of a full group pays double");
    assert!(table.build(wallets()[0], 1, T0 + 1).is_err(), "four houses and a hotel at most");
    table.seats[0].cash = 49;
    assert!(table.build(wallets()[0], 2, T0 + 1).is_err(), "needs cash >= cost");
    table.seats[0].cash = 1000;
    table.board[27] = Lot { owner: 1, buildings: 3 };
    table.board[25].owner = 1;
    table.board[26].owner = 1;
    assert_eq!(table.rent(27), 1200, "New York, full Dark Blue, 3 buildings: 40 x 30");
    table.board[25].owner = NO_OWNER;
    assert_eq!(table.rent(27), 40, "a broken group keeps its buildings but pays base rent");
    assert!(table.build(wallets()[0], 5, T0 + 1).is_err());

    table.seats[0].position = 2;
    roll(&mut table, 3, T0 + 2);
    assert_eq!(table.stage, Stage::BuyDecision);
    assert!(table.build(wallets()[0], 2, T0 + 3).is_err(), "build is PreRoll only");
}

#[test]
fn selling_pays_80_percent_in_preroll_or_buy_decision_only() {
    let mut table = playing(2, 7000);
    table.seats[0].cash = 1000;
    table.board[1] = Lot { owner: 0, buildings: 2 };
    table.board[2] = Lot { owner: 0, buildings: 1 };
    table.board[23].owner = 1;
    assert!(table.sell(wallets()[0], 23, T0 + 1).is_err(), "not yours");
    assert!(table.sell(wallets()[1], 23, T0 + 1).is_err(), "not your turn");
    table.sell(wallets()[0], 1, T0 + 1).unwrap();
    assert_eq!(table.seats[0].cash, 1128, "(60 + 2 x 50) x 80%");
    assert_eq!(table.board[1], Lot::default());
    assert_eq!(table.board[2].buildings, 1, "the rest of the group keeps its buildings");
    assert_eq!(table.rent(2), 8, "but rent falls back to base");
    assert_eq!((table.turn, table.stage, table.last_action_at), (0, Stage::PreRoll, T0 + 1));

    table.seats[0].position = 0;
    roll(&mut table, 4, T0 + 2);
    assert_eq!(table.stage, Stage::BuyDecision);
    table.sell(wallets()[0], 2, T0 + 3).unwrap();
    assert_eq!((table.seats[0].cash, table.stage), (1128 + 104, Stage::BuyDecision), "(80 + 50) x 80%");
    table.board[5].owner = 0;
    table.pass(wallets()[0], T0 + 4).unwrap();
    table.roll(wallets()[1], T0 + 5).unwrap();
    assert!(table.sell(wallets()[0], 5, T0 + 5).is_err(), "not while Rolling");
    assert!(table.sell(wallets()[1], 5, T0 + 5).is_err(), "not while Rolling");
}

#[test]
fn a_sale_that_bankrupts_ends_the_turn() {
    let mut table = playing(3, 7000);
    table.seats[0].cash = -50;
    table.board[1].owner = 0;
    assert_eq!(table.net_worth(0), 10);
    table.sell(wallets()[0], 1, T0 + 1).unwrap();
    assert_eq!(table.seats[0].eliminated_at, 1, "-50 + 48 leaves net worth -2");
    assert_eq!((table.turn, table.stage, table.phase), (1, Stage::PreRoll, TablePhase::Playing));
}

#[test]
fn negative_cash_blocks_buying_building_and_bail_but_not_selling_or_rolling() {
    let mut table = playing(2, 7000);
    table.seats[0].cash = -10;
    table.board[1].owner = 0;
    table.board[2].owner = 0;
    table.board[6].owner = 0;
    assert!(table.build(wallets()[0], 1, T0 + 1).is_err());
    table.seats[0].jail_turns = 1;
    assert!(table.pay_bail(wallets()[0], T0 + 1).is_err());
    table.seats[0].jail_turns = 0;
    table.sell(wallets()[0], 6, T0 + 1).unwrap();
    assert_eq!(table.seats[0].cash, 86);
    table.seats[0].cash = -10;
    roll(&mut table, 5, T0 + 2);
    assert_eq!(table.seats[0].position, 5);
    assert_eq!(table.stage, Stage::PreRoll, "no buy decision below the price");
    assert_eq!(table.turn, 1);
}

#[test]
fn both_bankruptcy_triggers_eliminate_and_free_holdings() {
    // Dark Blue full group: Tokyo rent 70 unbuilt, 140 with one building.
    let setup = |cash: i64, tokyo_buildings: u8, holdings: bool| {
        let mut table = playing(3, 7000);
        table.board[25] = Lot { owner: 1, buildings: tokyo_buildings };
        table.board[26].owner = 1;
        table.board[27].owner = 1;
        if holdings {
            for space in [18, 19, 20] {
                table.board[space] = Lot { owner: 0, buildings: 3 };
            }
        }
        table.seats[0].cash = cash;
        table.seats[0].position = 22;
        roll(&mut table, 3, T0 + 1);
        table
    };
    let table = setup(-400, 1, true);
    assert_eq!(table.seats[0].eliminated_at, 1, "cash -540 is below -500 despite net worth 1610");
    assert_eq!(table.seats[0].cash, 0, "an eliminated seat's cash is discarded");
    assert!(table.board.iter().all(|lot| lot.owner != 0), "its properties become unowned");
    assert_eq!([18, 19, 20].map(|space| table.board[space].buildings), [0, 0, 0], "buildings are removed");
    assert_eq!(table.turn, 1);
    let table = setup(-430, 0, true);
    assert_eq!((table.seats[0].eliminated_at, table.seats[0].cash), (0, -500), "exactly -500 survives");
    let table = setup(70, 0, false);
    assert_eq!(table.seats[0].eliminated_at, 1, "net worth exactly 0 is bankrupt");
    let table = setup(71, 0, false);
    assert_eq!(table.seats[0].eliminated_at, 0);
}

#[test]
fn end_conditions_cover_last_standing_a_non_roller_reaching_target_and_ranking_above_it() {
    // The owner, not the roller, crosses the target on collected rent.
    let mut table = playing(3, 7000);
    // Tokyo with 3 buildings in a full Dark Blue group: rent 35 x 30 = 1050; holdings 350 + 600 + 350 + 400.
    table.board[25] = Lot { owner: 1, buildings: 3 };
    table.board[26].owner = 1;
    table.board[27].owner = 1;
    table.seats[1].cash = 7_000 - 1_050 - 1_700 + 1;
    table.seats[0].position = 22;
    roll(&mut table, 3, T0 + 1);
    assert_eq!(table.net_worth(1), 7_001);
    assert_eq!(table.phase, TablePhase::Finished);

    // Two seats above the target rank by net worth.
    let mut table = playing(3, 2500);
    table.seats[0].cash = 3_100;
    table.seats[1].cash = 3_500;
    table.seats[0].position = 8;
    roll(&mut table, 6, T0 + 1);
    assert_eq!(table.phase, TablePhase::Finished);
    assert_eq!(table.payouts().unwrap()[..3], [900_000, 2_010_000, 0]);

    // At most one active seat ends the game even below the target.
    let mut table = playing(2, 7000);
    table.seats[1].strikes = 2;
    roll(&mut table, 1, T0 + 1);
    table.pass(wallets()[0], T0 + 2).unwrap();
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!((table.seats[1].eliminated_at, table.phase), (1, TablePhase::Finished));
}

#[test]
fn rejected_actions_never_mutate_the_table() {
    let mut table = playing(3, 7000);
    table.seats[0].cash = 40;
    table.board[1].owner = 0;
    table.board[2].owner = 0;
    let before = table.clone();
    let w = wallets();
    assert!(table.build(w[0], 1, T0 + 1).is_err());
    assert!(table.build(w[1], 1, T0 + 1).is_err());
    assert!(table.sell(w[0], 23, T0 + 1).is_err());
    assert!(table.pay_bail(w[0], T0 + 1).is_err());
    assert!(table.buy(w[0], T0 + 1).is_err());
    assert!(table.pass(w[0], T0 + 1).is_err());
    assert!(table.roll(w[1], T0 + 1).is_err());
    assert!(table.start(w[0], T0 + 1).is_err());
    assert!(table.force_timeout(T0 + 1).is_err());
    assert!(table.consume_randomness(die(1), table.vrf_nonce, T0 + 1).is_err());
    assert!(table.join(w[3], name("late"), table.game_nonce, T0 + 1).is_err());
    assert_eq!(table, before);
}

// ---- Phase 04: Auction-space trading ----

const AUCTION: u8 = 14;

/// Seat 0 rolls `value` from `from` (12 + 2 or 8 + 6 reach the Auction space) after `holdings`
/// (space, owner) are placed.
fn auction(players: usize, target: u64, from: u8, value: u8, holdings: &[(usize, u8)]) -> EphemeralTable {
    let mut table = playing(players, target);
    for &(space, owner) in holdings {
        table.board[space].owner = owner;
    }
    table.seats[0].position = from;
    roll(&mut table, value, T0 + 1);
    table
}

/// Seat 0 holds Athens (Brown) and Seoul (Orange); seat 1 holds Lisbon (Brown) and Railway;
/// seat 2 holds Berlin (Orange).
const HOLDINGS: [(usize, u8); 5] = [(2, 0), (11, 0), (1, 1), (3, 1), (12, 2)];

#[test]
fn a_trade_opens_takes_replaceable_offers_and_the_accepted_swap_completes_a_group() {
    let w = wallets();
    let mut table = auction(3, 7000, 12, 2, &HOLDINGS);
    assert_eq!(table.seats[0].position, AUCTION);
    assert_eq!((table.stage, table.stage_deadline), (Stage::TradeOpen, T0 + 1 + TRADE_OPEN_SECONDS));
    let before = table.clone();
    assert!(table.open_trade(w[1], 1, T0 + 2).is_err(), "only the lander opens");
    assert!(table.open_trade(w[0], 1, T0 + 2).is_err(), "not the lander's property");
    assert!(table.offer_trade(w[1], 1, T0 + 2).is_err(), "no offers before the trade opens");
    table.board[11].buildings = 1;
    assert!(table.open_trade(w[0], 11, T0 + 2).is_err(), "a built property cannot be traded");
    table.board[11].buildings = 0;
    assert_eq!(table, before);

    table.open_trade(w[0], 11, T0 + 2).unwrap();
    assert_eq!(table.stage, Stage::TradeOffers);
    assert_eq!(table.trade, Trade { space: 11, offers: [NO_OFFER; MAX_SEATS], deadline: T0 + 2 + TRADE_OFFER_SECONDS });
    assert_eq!(table.stage_deadline, T0 + 2 + TRADE_OFFER_SECONDS + TRADE_DECISION_SECONDS);
    let before = table.clone();
    assert!(table.offer_trade(w[0], 2, T0 + 3).is_err(), "the lander cannot offer to itself");
    assert!(table.offer_trade(w[1], 12, T0 + 3).is_err(), "not the offerer's property");
    assert!(table.offer_trade(w[3], 1, T0 + 3).is_err(), "a stranger cannot offer");
    assert!(table.accept_trade(w[0], 1, 1, T0 + 3).is_err(), "nothing offered yet");
    assert_eq!(table, before);

    table.offer_trade(w[1], 3, T0 + 3).unwrap();
    table.offer_trade(w[1], 1, T0 + 4).unwrap();
    table.offer_trade(w[2], 12, T0 + 4).unwrap();
    assert_eq!(table.trade.offers, [NO_OFFER, 1, 12, NO_OFFER], "seat 1 replaced Railway with Lisbon");
    let before = table.clone();
    assert!(table.accept_trade(w[0], 1, 3, T0 + 5).is_err(), "the replaced offer is gone");
    assert!(table.accept_trade(w[1], 1, 1, T0 + 5).is_err(), "only the lander accepts");
    assert!(table.accept_trade(w[0], 0, NO_OFFER, T0 + 5).is_err());
    assert!(table.accept_trade(w[0], 9, 1, T0 + 5).is_err());
    assert_eq!(table, before);

    let cash = [table.seats[0].cash, table.seats[1].cash, table.seats[2].cash];
    table.accept_trade(w[0], 1, 1, T0 + 5).unwrap();
    assert_eq!((table.board[1].owner, table.board[11].owner, table.board[12].owner), (0, 1, 2));
    assert!(table.owns_group(0, 1), "Lisbon completes seat 0's Brown group");
    assert_eq!(
        [table.seats[0].cash, table.seats[1].cash, table.seats[2].cash],
        [cash[0] + TRADE_BONUS, cash[1] + TRADE_BONUS, cash[2]],
        "only the two sides get the bonus"
    );
    assert_eq!(table.trade, Trade::default());
    assert_eq!((table.turn, table.stage, table.last_action_at), (1, Stage::PreRoll, T0 + 5));
}

#[test]
fn pass_skips_or_cancels_a_trade_and_a_six_keeps_its_extra_roll() {
    let w = wallets();
    let mut table = auction(3, 7000, 12, 2, &HOLDINGS);
    table.pass(w[0], T0 + 2).unwrap();
    assert_eq!((table.turn, table.stage, table.trade), (1, Stage::PreRoll, Trade::default()));

    let mut table = auction(3, 7000, 8, 6, &HOLDINGS);
    assert_eq!(table.stage, Stage::TradeOpen);
    table.open_trade(w[0], 11, T0 + 2).unwrap();
    table.offer_trade(w[1], 1, T0 + 3).unwrap();
    assert!(table.pass(w[1], T0 + 4).is_err(), "only the lander cancels");
    table.pass(w[0], T0 + 4).unwrap();
    assert_eq!((table.board[1].owner, table.board[11].owner), (1, 0), "a cancelled trade swaps nothing");
    assert_eq!(table.trade, Trade::default());
    assert_eq!((table.turn, table.stage, table.rolls_this_turn), (0, Stage::PreRoll, 1), "the 6 still rolls again");
}

#[test]
fn trade_open_is_skipped_without_an_unbuilt_property_on_both_sides() {
    // The lander owns nothing.
    let table = auction(3, 7000, 12, 2, &[(1, 1)]);
    assert_eq!((table.seats[0].position, table.turn, table.stage), (AUCTION, 1, Stage::PreRoll));
    // The lander's only property is built.
    let mut table = playing(3, 7000);
    table.board[1] = Lot { owner: 0, buildings: 1 };
    table.board[2] = Lot { owner: 0, buildings: 1 };
    table.board[3].owner = 1;
    table.seats[0].position = 12;
    roll(&mut table, 2, T0 + 1);
    assert_eq!((table.turn, table.stage), (1, Stage::PreRoll));
    // Nobody else could offer: seat 1 is built out and seat 2 owns nothing.
    let mut table = playing(3, 7000);
    table.board[3].owner = 0;
    for space in [18, 19, 20] {
        table.board[space] = Lot { owner: 1, buildings: 2 };
    }
    table.seats[0].position = 12;
    roll(&mut table, 2, T0 + 1);
    assert_eq!((table.turn, table.stage), (1, Stage::PreRoll));
}

#[test]
fn the_trade_bonus_can_reach_the_target_and_end_the_game() {
    let w = wallets();
    let mut table = auction(3, 2500, 12, 2, &[(1, 0), (2, 1)]);
    table.seats[0].cash = 2_820;
    assert_eq!(table.net_worth(0), 2_880);
    table.open_trade(w[0], 1, T0 + 2).unwrap();
    table.offer_trade(w[1], 2, T0 + 3).unwrap();
    table.accept_trade(w[0], 1, 2, T0 + 4).unwrap();
    assert_eq!(table.net_worth(0), 3_000, "Athens for Lisbon (+$20) plus the $100 bonus");
    assert_eq!((table.phase, table.stage, table.ended_at), (TablePhase::Finished, Stage::Idle, T0 + 4));
    assert_eq!(table.trade, Trade::default());
    assert_eq!(table.payouts().unwrap()[0], 2_010_000);
}

/// A swap can lower a seat's net worth: an offerer in debt that gives a dear property for a cheap
/// one is bankrupt the moment its net worth reaches 0, like after any other change.
#[test]
fn a_trade_that_drops_net_worth_to_zero_or_below_bankrupts_that_seat() {
    let w = wallets();
    let mut table = auction(3, 7000, 12, 2, &[(1, 0), (27, 1)]);
    table.seats[1].cash = -300;
    assert_eq!(table.net_worth(1), 100);
    table.open_trade(w[0], 1, T0 + 2).unwrap();
    table.offer_trade(w[1], 27, T0 + 3).unwrap();
    table.accept_trade(w[0], 1, 27, T0 + 4).unwrap();
    assert_ne!(
        table.seats[1].eliminated_at, 0,
        "-300 + 100 cash and Lisbon ($60): net worth -140"
    );
    assert_eq!(
        (
            table.seats[1].cash,
            table.board[1].owner,
            table.board[27].owner
        ),
        (0, NO_OWNER, 0)
    );
    assert_eq!(
        (table.phase, table.current_seat()),
        (TablePhase::Playing, 2)
    );
}

#[test]
fn trade_timeouts_strike_only_the_lander_and_an_empty_offer_window_cancels_without_one() {
    let w = wallets();
    // TradeOpen times out: strike, and the turn ends.
    let mut table = auction(3, 7000, 12, 2, &HOLDINGS);
    assert!(table.force_timeout(table.stage_deadline - 1).is_err());
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!((table.seats[0].strikes, table.turn, table.stage), (1, 1, Stage::PreRoll));

    // No offer arrives: the window closing cancels the trade with no strike, and a 6 still rolls again.
    let mut table = auction(3, 7000, 8, 6, &HOLDINGS);
    table.open_trade(w[0], 11, T0 + 2).unwrap();
    let closes = table.trade.deadline;
    assert!(table.force_timeout(closes - 1).is_err());
    assert!(table.offer_trade(w[1], 1, closes).is_err(), "offers close at the deadline");
    table.force_timeout(closes).unwrap();
    assert_eq!((table.seats[0].strikes, table.turn, table.stage), (0, 0, Stage::PreRoll));
    assert_eq!(table.trade, Trade::default());

    // Offers arrive but the lander never decides: cancel, strike the lander, never the offerers.
    let mut table = auction(3, 7000, 8, 6, &HOLDINGS);
    table.open_trade(w[0], 11, T0 + 2).unwrap();
    table.offer_trade(w[1], 1, T0 + 3).unwrap();
    let before = table.clone();
    assert!(table.force_timeout(table.trade.deadline).is_err(), "the lander still has time to decide");
    assert_eq!(table, before);
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!([table.seats[0].strikes, table.seats[1].strikes, table.seats[2].strikes], [1, 0, 0]);
    assert_eq!((table.board[1].owner, table.board[11].owner), (1, 0));
    assert_eq!((table.turn, table.stage, table.trade), (1, Stage::PreRoll, Trade::default()), "the turn ends despite the 6");

    // A third strike in a trade stage forfeits the lander.
    let mut table = auction(3, 7000, 12, 2, &HOLDINGS);
    table.seats[0].strikes = 2;
    table.force_timeout(table.stage_deadline).unwrap();
    assert_eq!((table.seats[0].eliminated_at, table.board[2].owner, table.board[11].owner), (1, NO_OWNER, NO_OWNER));

    // The idle deadline still ends a stalled trade by ranking.
    let mut table = auction(3, 7000, 12, 2, &HOLDINGS);
    table.open_trade(w[0], 11, T0 + 2).unwrap();
    table.offer_trade(w[1], 1, T0 + 3).unwrap();
    table.force_timeout(T0 + 3 + IDLE_SECONDS).unwrap();
    assert_eq!((table.phase, table.trade), (TablePhase::Finished, Trade::default()));
}

#[test]
fn eliminated_seats_cannot_offer_and_accept_revalidates_both_properties() {
    let w = wallets();
    let mut table = auction(4, 7000, 12, 2, &[(2, 0), (11, 0), (1, 1), (3, 1), (12, 2), (19, 3)]);
    table.open_trade(w[0], 11, T0 + 2).unwrap();
    // Seat 3 is eliminated by fixture after the trade opened (no instruction can do it here).
    table.seats[3].eliminated_at = 1;
    table.seats[3].cash = 0;
    table.elimination_seq = 1;
    let before = table.clone();
    assert!(table.offer_trade(w[3], 19, T0 + 3).is_err(), "an eliminated seat cannot offer");
    assert_eq!(table, before);

    table.offer_trade(w[1], 1, T0 + 3).unwrap();
    table.offer_trade(w[2], 12, T0 + 3).unwrap();
    let offered = table.clone();
    table.board[1].buildings = 1;
    assert!(table.accept_trade(w[0], 1, 1, T0 + 4).is_err(), "the offered property gained a building");
    table = offered.clone();
    table.board[12].owner = 1;
    assert!(table.accept_trade(w[0], 2, 12, T0 + 4).is_err(), "the offered property changed hands");
    table = offered.clone();
    table.board[11].owner = NO_OWNER;
    assert!(table.accept_trade(w[0], 1, 1, T0 + 4).is_err(), "the lander no longer owns its side");
    table = offered.clone();
    table.seats[2].eliminated_at = 1;
    assert!(table.accept_trade(w[0], 2, 12, T0 + 4).is_err(), "the offerer was eliminated");

    let mut table = offered;
    table.accept_trade(w[0], 2, 12, T0 + 4).unwrap();
    assert_eq!((table.board[11].owner, table.board[12].owner, table.board[1].owner), (2, 0, 1));
}

#[test]
fn open_records_the_board_theme() {
    let w = wallets();
    for theme in 0..BOARD_THEMES {
        let mut table = EphemeralTable::default();
        table.open(w[0], name("h"), USDC, 2, 2500, theme, 1500, T0).unwrap();
        assert_eq!(table.theme, theme);
    }
}

#[test]
fn forfeit_frees_the_seats_properties_passes_its_turn_and_can_end_the_game() {
    let w = wallets();
    let mut table = playing(3, 7000);
    table.board[1] = Lot { owner: 0, buildings: 0 };
    table.board[2] = Lot { owner: 0, buildings: 2 };
    table.board[5] = Lot { owner: 1, buildings: 0 };
    let before = table.clone();
    assert!(table.forfeit(w[3], T0 + 1).is_err(), "not seated");
    assert!(table.forfeit(w[0], T0 + IDLE_SECONDS).is_err(), "past the idle deadline");
    table.roll(w[0], T0 + 1).unwrap();
    assert!(table.forfeit(w[0], T0 + 1).is_err(), "not while the roll is being drawn");
    assert!(table.forfeit(w[1], T0 + 1).is_err(), "nobody while a roll is being drawn");
    let mut table = before;

    // Seat 1 quits on seat 0's turn: its property goes back on sale, the turn stays with seat 0.
    table.forfeit(w[1], T0 + 1).unwrap();
    assert!(!table.is_active(1) && table.seats[1].cash == 0);
    assert_eq!(table.board[5], Lot::default());
    assert_eq!((table.current_seat(), table.stage, table.last_action_at), (0, Stage::PreRoll, T0 + 1));
    assert!(table.forfeit(w[1], T0 + 2).is_err(), "already out");

    // Seat 0 quits on its own turn: both lots and the buildings are freed and, with one seat
    // left, the game ends.
    table.forfeit(w[0], T0 + 2).unwrap();
    assert_eq!((table.board[1], table.board[2]), (Lot::default(), Lot::default()));
    assert_eq!(table.phase, TablePhase::Finished);
    assert!(table.forfeit(w[2], T0 + 3).is_err(), "the game is over");
    let payouts = table.payouts().unwrap();
    assert!(payouts[2] > payouts[0] && payouts[0] > payouts[1], "the last seat standing wins; the first to quit ranks last");
}

#[test]
fn forfeit_during_a_trade_withdraws_the_offer_or_cancels_the_lander_trade() {
    let w = wallets();
    let mut table = auction(4, 7000, 12, 2, &HOLDINGS);
    table.open_trade(w[0], 11, T0 + 2).unwrap();
    table.offer_trade(w[1], 1, T0 + 3).unwrap();
    table.offer_trade(w[2], 12, T0 + 3).unwrap();
    table.forfeit(w[1], T0 + 4).unwrap();
    assert_eq!(table.trade.offers, [NO_OFFER, NO_OFFER, 12, NO_OFFER], "the quitter's offer is gone");
    assert_eq!(table.stage, Stage::TradeOffers, "the trade goes on");
    table.forfeit(w[0], T0 + 5).unwrap();
    assert_eq!(table.trade, Trade::default(), "the lander's trade is cancelled");
    assert_eq!((table.phase, table.current_seat(), table.stage), (TablePhase::Playing, 2, Stage::PreRoll), "the turn passes on");
    assert_eq!((table.board[11], table.board[12].owner), (Lot::default(), 2), "the lander's lots are free, the offerer keeps its own");
}
