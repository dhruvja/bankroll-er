//! Pure Bankroll rules on the Table account. No accounts, CPIs or clock reads: every input,
//! including VRF output and `now`, is a parameter so unit tests can inject them.
use anchor_lang::prelude::*;

use crate::board::*;
use crate::state::*;

pub fn encode_name(name: &str) -> Result<[u8; NAME_LEN]> {
    let name = name.trim();
    require!(
        !name.is_empty() && name.len() <= NAME_LEN,
        GameError::InvalidName
    );
    let mut bytes = [0u8; NAME_LEN];
    bytes[..name.len()].copy_from_slice(name.as_bytes());
    Ok(bytes)
}

fn word(bytes: &[u8]) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[..8]);
    u64::from_le_bytes(word)
}

impl Table {
    pub fn count(&self) -> usize {
        self.player_count as usize
    }

    pub fn pot(&self) -> Result<u64> {
        self.entry
            .checked_mul(self.player_count as u64)
            .ok_or(error!(GameError::Overflow))
    }

    pub fn seat_of(&self, wallet: &Pubkey) -> Option<usize> {
        self.seats[..self.count()]
            .iter()
            .position(|seat| seat.wallet == *wallet)
    }

    pub fn current_seat(&self) -> usize {
        self.order[self.turn as usize] as usize
    }

    pub fn is_active(&self, seat: usize) -> bool {
        seat < self.count() && self.seats[seat].eliminated_at == 0
    }

    /// Cash plus the price of every owned property and its buildings.
    pub fn net_worth(&self, seat: usize) -> i64 {
        let holdings: i64 = self
            .board
            .iter()
            .zip(BOARD.iter())
            .filter(|(lot, _)| lot.owner as usize == seat)
            .map(|(lot, space)| space.price + lot.buildings as i64 * space.building_cost)
            .sum();
        self.seats[seat].cash + holdings
    }

    pub fn rent(&self, space: usize) -> i64 {
        let owner = self.board[space].owner;
        let spec = BOARD[space];
        let owned_in_group = self
            .board
            .iter()
            .zip(BOARD.iter())
            .filter(|(lot, other)| lot.owner == owner && other.group == spec.group)
            .count() as i64;
        match spec.kind {
            SpaceKind::Public => spec.rent * owned_in_group,
            SpaceKind::City if owned_in_group == GROUP_SIZES[spec.group as usize] as i64 => {
                match self.board[space].buildings {
                    0 => spec.rent * GROUP_RENT_MULTIPLIER,
                    built => spec.rent * BUILDING_RENT_MULTIPLIERS[built as usize - 1],
                }
            }
            SpaceKind::City => spec.rent,
            _ => 0,
        }
    }

    /// A Free table becomes this host's lobby. Everything from the previous game is cleared;
    /// only the table identity and the two monotonic nonces survive.
    pub fn open(
        &mut self,
        host: Pubkey,
        name: [u8; NAME_LEN],
        entry: u64,
        max_players: u8,
        target: u64,
        now: i64,
    ) -> Result<()> {
        require!(self.phase == TablePhase::Free, GameError::InvalidPhase);
        require!(ENTRIES.contains(&entry), GameError::InvalidEntry);
        require!(
            (2..=MAX_SEATS as u8).contains(&max_players) && TARGETS.contains(&target),
            GameError::InvalidConfig
        );
        *self = Table {
            index: self.index,
            bump: self.bump,
            game_nonce: self
                .game_nonce
                .checked_add(1)
                .ok_or(GameError::Overflow)?,
            vrf_nonce: self.vrf_nonce,
            phase: TablePhase::Lobby,
            host,
            entry,
            max_players,
            target,
            player_count: 1,
            lobby_deadline: now.checked_add(LOBBY_SECONDS).ok_or(GameError::Overflow)?,
            last_action_at: now,
            ..Table::default()
        };
        self.seats[0].wallet = host;
        self.seats[0].name = name;
        Ok(())
    }

    pub fn join(
        &mut self,
        wallet: Pubkey,
        name: [u8; NAME_LEN],
        expected_nonce: u64,
        now: i64,
    ) -> Result<()> {
        require!(
            self.phase == TablePhase::Lobby && now < self.lobby_deadline,
            GameError::LobbyClosed
        );
        require!(expected_nonce == self.game_nonce, GameError::StaleNonce);
        require!(
            self.player_count < self.max_players,
            GameError::TableFull
        );
        require!(self.seat_of(&wallet).is_none(), GameError::AlreadyJoined);
        let seat = &mut self.seats[self.count()];
        seat.wallet = wallet;
        seat.name = name;
        self.player_count += 1;
        self.last_action_at = now;
        Ok(())
    }

    pub fn cancel_or_expire(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        require!(self.phase == TablePhase::Lobby, GameError::InvalidPhase);
        require!(
            caller == self.host || now >= self.lobby_deadline,
            GameError::Unauthorized
        );
        self.phase = TablePhase::Refunding;
        Ok(())
    }

    /// Marks one seat refunded and returns its wallet and amount; the last refund frees the table.
    /// A game that never finished returns the full entry. A finished game whose settle kept
    /// failing returns the ranked payout recorded at the emergency, so blocking settle gains
    /// nothing; its fee stays in custody and the table's next settle sweeps it to the treasury.
    pub fn refund(&mut self, index: usize) -> Result<(Pubkey, u64)> {
        require!(self.phase == TablePhase::Refunding, GameError::InvalidPhase);
        require!(index < self.count(), GameError::InvalidAccount);
        let finished = self.ended_at != 0;
        let entry = self.entry;
        let seat = &mut self.seats[index];
        require!(!seat.refunded, GameError::AlreadyRefunded);
        seat.refunded = true;
        let refund = (seat.wallet, if finished { seat.payout } else { entry });
        if self.seats[..self.count()].iter().all(|seat| seat.refunded) {
            self.phase = TablePhase::Free;
        }
        Ok(refund)
    }

    /// Host starts the game, or any seated wallet re-requests a turn order that never arrived.
    pub fn start(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        match (self.phase, self.stage) {
            (TablePhase::Lobby, _) => {
                require!(caller == self.host, GameError::Unauthorized);
                require!(now < self.lobby_deadline, GameError::LobbyClosed);
                require!(self.player_count >= 2, GameError::NotEnoughPlayers);
                self.phase = TablePhase::Playing;
                self.stage = Stage::Ordering;
            }
            (TablePhase::Playing, Stage::Ordering) => {
                require!(self.seat_of(&caller).is_some(), GameError::Unauthorized);
                require!(
                    now >= self.vrf_requested_at + VRF_RETRY_SECONDS,
                    GameError::TooEarly
                );
            }
            _ => return err!(GameError::InvalidPhase),
        }
        self.request_vrf(VrfPurpose::Order, now)?;
        self.last_action_at = now;
        Ok(())
    }

    /// The current seat rolls, or re-requests a roll whose callback never came. Other active seats
    /// may retry only after a longer wait, so they cannot void a slow but valid roll in flight.
    pub fn roll(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        require!(self.phase == TablePhase::Playing, GameError::InvalidPhase);
        let seat = self.seat_of(&caller).ok_or(GameError::Unauthorized)?;
        match self.stage {
            Stage::PreRoll => require!(seat == self.current_seat(), GameError::Unauthorized),
            Stage::Rolling => {
                require!(self.is_active(seat), GameError::Unauthorized);
                let wait = if seat == self.current_seat() {
                    VRF_RETRY_SECONDS
                } else {
                    OTHER_SEAT_RETRY_SECONDS
                };
                require!(now >= self.vrf_requested_at + wait, GameError::TooEarly);
            }
            _ => return err!(GameError::InvalidStage),
        }
        self.stage = Stage::Rolling;
        self.request_vrf(VrfPurpose::Roll, now)?;
        self.last_action_at = now;
        Ok(())
    }

    fn request_vrf(&mut self, purpose: VrfPurpose, now: i64) -> Result<()> {
        self.vrf_nonce = self.vrf_nonce.checked_add(1).ok_or(GameError::Overflow)?;
        self.vrf_purpose = purpose;
        self.vrf_requested_at = now;
        Ok(())
    }

    /// The VRF callback. The 32-byte output is consumed here and never stored.
    pub fn consume_randomness(&mut self, randomness: [u8; 32], nonce: u64, now: i64) -> Result<()> {
        require!(
            self.phase == TablePhase::Playing
                && self.vrf_purpose != VrfPurpose::None
                && nonce == self.vrf_nonce,
            GameError::UnexpectedRandomness
        );
        let purpose = self.vrf_purpose;
        self.vrf_purpose = VrfPurpose::None;
        let n = self.count();
        match purpose {
            VrfPurpose::Order => {
                require!(self.stage == Stage::Ordering, GameError::UnexpectedRandomness);
                let mut order = [0u8, 1, 2, 3];
                for i in (1..n).rev() {
                    let hash = solana_sha256_hasher::hashv(&[b"order", &randomness, &[i as u8]]);
                    let j = (word(&hash.to_bytes()) % (i as u64 + 1)) as usize;
                    order.swap(i, j);
                }
                let step_index = TARGETS
                    .iter()
                    .position(|target| *target == self.target)
                    .ok_or(GameError::InvalidConfig)?;
                for (place, &seat) in order[..n].iter().enumerate() {
                    self.seats[seat as usize].cash =
                        START_CASH + SEAT_BONUS_STEPS[step_index] * place as i64;
                }
                self.order = order;
                self.turn = 0;
                self.round = 1;
                self.begin_turn(now);
            }
            VrfPurpose::Roll => {
                require!(self.stage == Stage::Rolling, GameError::UnexpectedRandomness);
                let seat = self.current_seat();
                let die = (word(&randomness) % 6) as u8 + 1;
                self.last_roll = die;
                self.rolls_this_turn += 1;
                self.extra_roll = die == 6 && self.rolls_this_turn < MAX_ROLLS_PER_TURN;
                let to = self.seats[seat].position as usize + die as usize;
                if to >= SPACES {
                    self.seats[seat].cash += SALARY;
                }
                let position = to % SPACES;
                self.seats[seat].position = position as u8;
                let space = BOARD[position];
                let owner = self.board[position].owner;
                let mut buying = false;
                if matches!(space.kind, SpaceKind::City | SpaceKind::Public) {
                    if owner == NO_OWNER {
                        buying = self.seats[seat].cash >= space.price;
                    } else if owner as usize != seat {
                        // Rent is paid in full even when it pushes the payer below zero.
                        let rent = self.rent(position);
                        self.seats[seat].cash -= rent;
                        self.seats[owner as usize].cash += rent;
                        if self.net_worth(seat) <= 0 || self.seats[seat].cash < BANKRUPT_CASH_BELOW
                        {
                            self.eliminate(seat);
                        }
                    }
                }
                if buying {
                    self.stage = Stage::BuyDecision;
                    self.stage_deadline = now + BUY_SECONDS;
                } else {
                    self.finish_roll(now);
                }
            }
            VrfPurpose::None => return err!(GameError::UnexpectedRandomness),
        }
        self.check_end(now);
        Ok(())
    }

    pub fn buy(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        let seat = self.decision_seat(caller)?;
        let position = self.seats[seat].position as usize;
        let price = BOARD[position].price;
        require!(
            self.board[position].owner == NO_OWNER
                && matches!(BOARD[position].kind, SpaceKind::City | SpaceKind::Public),
            GameError::InvalidStage
        );
        require!(self.seats[seat].cash >= price, GameError::InsufficientCash);
        self.seats[seat].cash -= price;
        self.board[position].owner = seat as u8;
        self.last_action_at = now;
        self.finish_roll(now);
        self.check_end(now);
        Ok(())
    }

    pub fn pass(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        self.decision_seat(caller)?;
        self.last_action_at = now;
        self.finish_roll(now);
        self.check_end(now);
        Ok(())
    }

    fn decision_seat(&self, caller: Pubkey) -> Result<usize> {
        require!(
            self.phase == TablePhase::Playing && self.stage == Stage::BuyDecision,
            GameError::InvalidStage
        );
        let seat = self.current_seat();
        require!(self.seats[seat].wallet == caller, GameError::Unauthorized);
        Ok(seat)
    }

    /// Anyone may call this. The idle deadline is checked before stage deadlines, so the first
    /// player back at an abandoned table ends it by ranking instead of forfeiting everyone.
    pub fn force_timeout(&mut self, now: i64) -> Result<()> {
        let idle_at = self.last_action_at + IDLE_SECONDS;
        match self.phase {
            // Settle keeps failing: each seat pulls its ranked payout through refund_player instead.
            TablePhase::Finished if now >= idle_at.max(self.ended_at) + EMERGENCY_SECONDS => {
                let payouts = self.payouts()?;
                for (seat, payout) in self.seats.iter_mut().zip(payouts) {
                    seat.payout = payout;
                }
                self.phase = TablePhase::Refunding;
            }
            TablePhase::Playing if now >= idle_at => {
                if self.stage == Stage::Ordering {
                    // No turn order means no cash and no ranking: return every entry instead.
                    self.phase = TablePhase::Refunding;
                    self.stage = Stage::Idle;
                    self.vrf_purpose = VrfPurpose::None;
                } else {
                    self.finish(now);
                }
            }
            TablePhase::Playing
                if matches!(self.stage, Stage::PreRoll | Stage::BuyDecision)
                    && now >= self.stage_deadline =>
            {
                // A timed-out PreRoll skips the turn; a timed-out BuyDecision passes and the turn
                // ends, including any extra roll from a 6.
                let seat = self.current_seat();
                self.seats[seat].strikes += 1;
                if self.seats[seat].strikes >= STRIKES_TO_FORFEIT {
                    self.eliminate(seat);
                }
                self.advance_turn(now);
                self.check_end(now);
            }
            TablePhase::Playing | TablePhase::Finished => return err!(GameError::TooEarly),
            _ => return err!(GameError::InvalidPhase),
        }
        Ok(())
    }

    /// Ranked payout per seat, in token atoms. Active seats rank by net worth, eliminated seats
    /// below them by `eliminated_at` descending. Tied seats split the combined shares of the
    /// positions they occupy; the fee and all rounding dust stay for the treasury.
    pub fn payouts(&self) -> Result<[u64; MAX_SEATS]> {
        require!(self.phase == TablePhase::Finished, GameError::InvalidPhase);
        let n = self.count();
        require!((2..=MAX_SEATS).contains(&n), GameError::InvalidPhase);
        let pot = self.pot()?;
        let row = SHARES_BPS[n - 2];
        let key = |seat: usize| {
            if self.is_active(seat) {
                (true, self.net_worth(seat))
            } else {
                (false, self.seats[seat].eliminated_at as i64)
            }
        };
        let mut payouts = [0u64; MAX_SEATS];
        for (seat, payout) in payouts.iter_mut().enumerate().take(n) {
            let mine = key(seat);
            let better = (0..n)
                .filter(|&other| {
                    let theirs = key(other);
                    (theirs.0 && !mine.0) || (theirs.0 == mine.0 && theirs.1 > mine.1)
                })
                .count();
            let tied = (0..n).filter(|&other| key(other) == mine).count();
            let bps: u64 = (better..better + tied)
                .map(|place| row.get(place).copied().unwrap_or(0))
                .sum();
            *payout = pot.checked_mul(bps).ok_or(GameError::Overflow)? / 10_000 / tied as u64;
        }
        Ok(payouts)
    }

    pub fn record_settlement(&mut self, payouts: [u64; MAX_SEATS]) {
        for (seat, payout) in self.seats.iter_mut().zip(payouts) {
            seat.payout = payout;
        }
        self.phase = TablePhase::Free;
    }

    fn begin_turn(&mut self, now: i64) {
        self.stage = Stage::PreRoll;
        self.stage_deadline = now + PREROLL_SECONDS;
        self.rolls_this_turn = 0;
        self.extra_roll = false;
    }

    /// After a roll resolves: a 6 keeps the turn (up to three rolls), otherwise it passes on.
    fn finish_roll(&mut self, now: i64) {
        if self.extra_roll && self.is_active(self.current_seat()) {
            self.stage = Stage::PreRoll;
            self.stage_deadline = now + PREROLL_SECONDS;
        } else {
            self.advance_turn(now);
        }
    }

    fn advance_turn(&mut self, now: i64) {
        let n = self.count();
        let mut turn = self.turn as usize;
        for _ in 0..n {
            turn += 1;
            if turn == n {
                turn = 0;
                self.round += 1;
            }
            if self.is_active(self.order[turn] as usize) {
                break;
            }
        }
        self.turn = turn as u8;
        self.begin_turn(now);
    }

    /// Eliminated seats share `elimination_seq + 1` until `check_end` closes the instruction.
    fn eliminate(&mut self, seat: usize) {
        self.seats[seat].eliminated_at = self.elimination_seq + 1;
        self.seats[seat].cash = 0;
        for lot in self.board.iter_mut().filter(|lot| lot.owner as usize == seat) {
            *lot = Lot::default();
        }
    }

    /// End conditions, run once at the end of every state-changing instruction.
    fn check_end(&mut self, now: i64) {
        let mark = self.elimination_seq + 1;
        if self.seats.iter().any(|seat| seat.eliminated_at == mark) {
            self.elimination_seq = mark;
        }
        if self.phase != TablePhase::Playing {
            return;
        }
        let n = self.count();
        let active = (0..n).filter(|&seat| self.is_active(seat)).count();
        let target_reached = (0..n)
            .any(|seat| self.is_active(seat) && self.net_worth(seat) >= self.target as i64);
        if active <= 1 || target_reached {
            self.finish(now);
        }
    }

    fn finish(&mut self, now: i64) {
        self.phase = TablePhase::Finished;
        self.stage = Stage::Idle;
        self.stage_deadline = 0;
        self.vrf_purpose = VrfPurpose::None;
        self.ended_at = now;
    }
}
