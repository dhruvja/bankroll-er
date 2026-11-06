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

    /// Whether `seat` owns every city in `group`.
    pub fn owns_group(&self, seat: usize, group: u8) -> bool {
        self.board
            .iter()
            .zip(BOARD.iter())
            .filter(|(_, space)| space.kind == SpaceKind::City && space.group == group)
            .all(|(lot, _)| lot.owner as usize == seat)
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
    #[allow(clippy::too_many_arguments)] // Mirrors the open_table instruction args one to one.
    pub fn open(
        &mut self,
        host: Pubkey,
        name: [u8; NAME_LEN],
        entry: u64,
        max_players: u8,
        target: u64,
        theme: u8,
        now: i64,
    ) -> Result<()> {
        require!(self.phase == TablePhase::Free, GameError::InvalidPhase);
        require!(ENTRIES.contains(&entry), GameError::InvalidEntry);
        require!(
            (2..=MAX_SEATS as u8).contains(&max_players)
                && TARGETS.contains(&target)
                && theme < BOARD_THEMES,
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
            theme,
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
        self.begin_refunds(now);
        Ok(())
    }

    /// Refunding starts: a seat whose token accounts are gone can no longer hold the table once
    /// `stage_deadline` passes, because its share may then go to the treasury instead.
    fn begin_refunds(&mut self, now: i64) {
        self.phase = TablePhase::Refunding;
        self.stage = Stage::Idle;
        self.stage_deadline = now + REFUND_GRACE_SECONDS;
    }

    /// No player action is accepted once the idle deadline has passed: the game then ends only by
    /// ranking through `force_timeout`, so the first player back cannot revive it and strike out
    /// the absent seats.
    fn require_live(&self, now: i64) -> Result<()> {
        require!(
            now < self.last_action_at + IDLE_SECONDS,
            GameError::IdleDeadlinePassed
        );
        Ok(())
    }

    /// Marks one seat refunded and returns its wallet and amount; the last refund frees the table
    /// (and `refund_player` then sweeps what custody still holds, the fee of a finished game, to
    /// the treasury). A game that never finished returns the full entry. A finished game returns
    /// the ranked payout recorded by `settle` or the emergency, so blocking settle gains nothing.
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
                self.last_action_at = now;
            }
            (TablePhase::Playing, Stage::Ordering) => {
                require!(self.seat_of(&caller).is_some(), GameError::Unauthorized);
                self.require_live(now)?;
                require!(
                    now >= self.vrf_requested_at + VRF_RETRY_SECONDS,
                    GameError::TooEarly
                );
            }
            _ => return err!(GameError::InvalidPhase),
        }
        self.request_vrf(VrfPurpose::Order, now)?;
        self.phase = TablePhase::Playing;
        self.stage = Stage::Ordering;
        Ok(())
    }

    /// The current seat rolls, or re-requests a roll whose callback never came. Other active seats
    /// may retry only after a longer wait, so they cannot void a slow but valid roll in flight.
    /// A jailed seat's roll serves one jail turn without moving. Returns whether a VRF request is
    /// needed; the jailed roll needs none.
    pub fn roll(&mut self, caller: Pubkey, now: i64) -> Result<bool> {
        require!(self.phase == TablePhase::Playing, GameError::InvalidPhase);
        let seat = self.seat_of(&caller).ok_or(GameError::Unauthorized)?;
        self.require_live(now)?;
        match self.stage {
            Stage::PreRoll => {
                require!(seat == self.current_seat(), GameError::Unauthorized);
                if self.seats[seat].jail_turns > 0 {
                    self.seats[seat].jail_turns -= 1;
                    self.last_action_at = now;
                    self.advance_turn(now);
                    return Ok(false);
                }
                self.last_action_at = now;
            }
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
        self.request_vrf(VrfPurpose::Roll, now)?;
        self.stage = Stage::Rolling;
        Ok(true)
    }

    fn request_vrf(&mut self, purpose: VrfPurpose, now: i64) -> Result<()> {
        self.vrf_nonce = self.vrf_nonce.checked_add(1).ok_or(GameError::Overflow)?;
        self.vrf_purpose = purpose;
        self.vrf_requested_at = now;
        Ok(())
    }

    /// The VRF callback. The 32-byte output is consumed here and never stored: it yields the die
    /// and, on a Lucky space, the one card this roll may draw.
    pub fn consume_randomness(&mut self, randomness: [u8; 32], nonce: u64, now: i64) -> Result<()> {
        let expected_stage = match self.vrf_purpose {
            VrfPurpose::Order => Stage::Ordering,
            VrfPurpose::Roll => Stage::Rolling,
            VrfPurpose::None => return err!(GameError::UnexpectedRandomness),
        };
        require!(
            self.phase == TablePhase::Playing
                && self.stage == expected_stage
                && nonce == self.vrf_nonce,
            GameError::UnexpectedRandomness
        );
        let n = self.count();
        if self.vrf_purpose == VrfPurpose::Order {
            let step_index = TARGETS
                .iter()
                .position(|target| *target == self.target)
                .ok_or(GameError::InvalidConfig)?;
            let mut order = [0u8, 1, 2, 3];
            for i in (1..n).rev() {
                let hash = solana_sha256_hasher::hashv(&[b"order", &randomness, &[i as u8]]);
                let j = (word(&hash.to_bytes()) % (i as u64 + 1)) as usize;
                order.swap(i, j);
            }
            for (place, &seat) in order[..n].iter().enumerate() {
                self.seats[seat as usize].cash =
                    START_CASH + SEAT_BONUS_STEPS[step_index] * place as i64;
            }
            self.vrf_purpose = VrfPurpose::None;
            self.order = order;
            self.turn = 0;
            self.round = 1;
            self.begin_turn(now);
            return Ok(());
        }

        self.vrf_purpose = VrfPurpose::None;
        let seat = self.current_seat();
        let die = (word(&randomness) % 6) as u8 + 1;
        self.last_roll = die;
        self.last_card = 0;
        self.rolls_this_turn += 1;
        self.extra_roll = die == 6 && self.rolls_this_turn < MAX_ROLLS_PER_TURN;
        let to = self.seats[seat].position as usize + die as usize;
        if to >= SPACES {
            self.seats[seat].cash += SALARY;
        }
        let buying = self.land(seat, to % SPACES, Some(&randomness));
        if self.seats[seat].jail_turns > 0 {
            // Landing on Jail, by roll or card, ends the turn and cancels any extra roll.
            self.extra_roll = false;
        }
        if buying && self.is_active(seat) {
            self.stage = Stage::BuyDecision;
            self.stage_deadline = now + BUY_SECONDS;
        } else if self.may_open_trade(seat) {
            self.stage = Stage::TradeOpen;
            self.stage_deadline = now + TRADE_OPEN_SECONDS;
        } else {
            self.finish_roll(now);
        }
        self.check_end(now);
        Ok(())
    }

    /// Puts `seat` on `position` and resolves the space: jail, a Lucky card (only when
    /// `randomness` is given, so a card move never draws again), rent or a buy offer. Returns
    /// whether the seat may buy the unowned property it landed on.
    fn land(&mut self, seat: usize, position: usize, randomness: Option<&[u8; 32]>) -> bool {
        self.seats[seat].position = position as u8;
        let space = BOARD[position];
        match space.kind {
            SpaceKind::Jail => {
                self.seats[seat].jail_turns = JAIL_TURNS;
                false
            }
            SpaceKind::Lucky => match randomness {
                Some(randomness) => self.draw(seat, randomness),
                None => false,
            },
            SpaceKind::City | SpaceKind::Public => {
                let owner = self.board[position].owner;
                if owner == NO_OWNER {
                    return self.seats[seat].cash >= space.price;
                }
                if owner as usize != seat {
                    // Rent is paid in full even when it pushes the payer below zero.
                    let rent = self.rent(position);
                    self.seats[seat].cash -= rent;
                    self.seats[owner as usize].cash += rent;
                    self.eliminate_if_bankrupt(seat);
                }
                false
            }
            SpaceKind::Start | SpaceKind::Auction => false,
        }
    }

    /// Draws `sha256(r, "card") % 12` and applies it. Returns whether a move card left the seat
    /// on a property it may buy.
    fn draw(&mut self, seat: usize, randomness: &[u8; 32]) -> bool {
        let hash = solana_sha256_hasher::hashv(&[randomness, b"card"]);
        let index = (word(&hash.to_bytes()) % LUCKY_DECK.len() as u64) as usize;
        self.last_card = index as u8 + 1;
        let card = LUCKY_DECK[index];
        let n = self.count();
        match card.kind {
            LuckyKind::Bank => {
                self.seats[seat].cash += card.amount;
                self.eliminate_if_bankrupt(seat);
            }
            LuckyKind::PayEach => {
                for other in (0..n).filter(|&other| other != seat) {
                    if self.is_active(other) {
                        self.seats[other].cash += card.amount;
                        self.seats[seat].cash -= card.amount;
                    }
                }
                self.eliminate_if_bankrupt(seat);
            }
            LuckyKind::CollectEach => {
                // Each payer settles in full; several can go bankrupt in this one callback.
                for other in (0..n).filter(|&other| other != seat) {
                    if self.is_active(other) {
                        self.seats[other].cash -= card.amount;
                        self.seats[seat].cash += card.amount;
                        self.eliminate_if_bankrupt(other);
                    }
                }
            }
            LuckyKind::ToStart => {
                self.seats[seat].cash += SALARY;
                return self.land(seat, 0, None);
            }
            LuckyKind::ToJail => return self.land(seat, JAIL_SPACE, None),
            LuckyKind::Move => {
                let from = self.seats[seat].position as i64;
                let to = from + card.amount;
                if to >= SPACES as i64 {
                    self.seats[seat].cash += SALARY;
                }
                return self.land(seat, to.rem_euclid(SPACES as i64) as usize, None);
            }
            LuckyKind::Repairs => {
                let buildings: i64 = self
                    .board
                    .iter()
                    .filter(|lot| lot.owner as usize == seat)
                    .map(|lot| lot.buildings as i64)
                    .sum();
                self.seats[seat].cash -= card.amount * buildings;
                self.eliminate_if_bankrupt(seat);
            }
        }
        false
    }

    pub fn buy(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        let seat = self.acting_seat(caller, &[Stage::BuyDecision], now)?;
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

    /// Declines a buy, or skips or cancels an Auction trade.
    pub fn pass(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        self.acting_seat(
            caller,
            &[Stage::BuyDecision, Stage::TradeOpen, Stage::TradeOffers],
            now,
        )?;
        self.trade = Trade::default();
        self.last_action_at = now;
        self.finish_roll(now);
        self.check_end(now);
        Ok(())
    }

    /// Adds one building to a city of a full group the current seat owns, in its PreRoll.
    pub fn build(&mut self, caller: Pubkey, space: u8, now: i64) -> Result<()> {
        let seat = self.acting_seat(caller, &[Stage::PreRoll], now)?;
        let space = space as usize;
        require!(space < SPACES, GameError::NotYourProperty);
        let spec = BOARD[space];
        require!(
            self.board[space].owner as usize == seat,
            GameError::NotYourProperty
        );
        require!(
            spec.kind == SpaceKind::City
                && self.owns_group(seat, spec.group)
                && self.board[space].buildings < MAX_BUILDINGS,
            GameError::CannotBuild
        );
        require!(
            self.seats[seat].cash >= spec.building_cost,
            GameError::InsufficientCash
        );
        self.seats[seat].cash -= spec.building_cost;
        self.board[space].buildings += 1;
        self.last_action_at = now;
        self.check_end(now);
        Ok(())
    }

    /// Sells a property with its buildings for 80% of their price, in the current seat's PreRoll
    /// or BuyDecision. A sale that bankrupts the seller ends its turn.
    pub fn sell(&mut self, caller: Pubkey, space: u8, now: i64) -> Result<()> {
        let seat = self.acting_seat(caller, &[Stage::PreRoll, Stage::BuyDecision], now)?;
        let space = space as usize;
        require!(
            space < SPACES && self.board[space].owner as usize == seat,
            GameError::NotYourProperty
        );
        let spec = BOARD[space];
        let value = spec.price + self.board[space].buildings as i64 * spec.building_cost;
        self.seats[seat].cash += value * SALE_BPS / 10_000;
        self.board[space] = Lot::default();
        self.eliminate_if_bankrupt(seat);
        self.last_action_at = now;
        if !self.is_active(seat) {
            self.advance_turn(now);
        }
        self.check_end(now);
        Ok(())
    }

    /// A jailed seat pays $150 in its PreRoll and is released; the turn ends without moving.
    pub fn pay_bail(&mut self, caller: Pubkey, now: i64) -> Result<()> {
        let seat = self.acting_seat(caller, &[Stage::PreRoll], now)?;
        require!(self.seats[seat].jail_turns > 0, GameError::NotJailed);
        require!(self.seats[seat].cash >= BAIL, GameError::InsufficientCash);
        self.seats[seat].cash -= BAIL;
        self.seats[seat].jail_turns = 0;
        self.eliminate_if_bankrupt(seat);
        self.last_action_at = now;
        self.advance_turn(now);
        self.check_end(now);
        Ok(())
    }

    /// Whether `seat` owns `space` and it has no buildings: the only properties a trade can move.
    fn tradeable(&self, seat: usize, space: usize) -> bool {
        space < SPACES && self.board[space].owner as usize == seat && self.board[space].buildings == 0
    }

    /// TradeOpen follows a landing on Auction only when the lander and at least one other active
    /// seat each own an unbuilt property; otherwise no trade could complete, so the stage is skipped.
    fn may_open_trade(&self, seat: usize) -> bool {
        let has_unbuilt = |owner: usize| (0..SPACES).any(|space| self.tradeable(owner, space));
        self.is_active(seat)
            && BOARD[self.seats[seat].position as usize].kind == SpaceKind::Auction
            && has_unbuilt(seat)
            && (0..self.count()).any(|other| other != seat && self.is_active(other) && has_unbuilt(other))
    }

    /// The lander offers one unbuilt property; the offer window opens for the other seats.
    pub fn open_trade(&mut self, caller: Pubkey, space: u8, now: i64) -> Result<()> {
        let seat = self.acting_seat(caller, &[Stage::TradeOpen], now)?;
        require!(self.tradeable(seat, space as usize), GameError::CannotTrade);
        let deadline = now + TRADE_OFFER_SECONDS;
        self.trade = Trade { space, offers: [NO_OFFER; MAX_SEATS], deadline };
        self.stage = Stage::TradeOffers;
        self.stage_deadline = deadline + TRADE_DECISION_SECONDS;
        self.last_action_at = now;
        Ok(())
    }

    /// Another active seat offers one of its unbuilt properties in return, replacing its earlier
    /// offer. Offers close at `trade.deadline`.
    pub fn offer_trade(&mut self, caller: Pubkey, space: u8, now: i64) -> Result<()> {
        require!(
            self.phase == TablePhase::Playing && self.stage == Stage::TradeOffers,
            GameError::InvalidStage
        );
        require!(now < self.trade.deadline, GameError::OffersClosed);
        let seat = self.seat_of(&caller).ok_or(GameError::Unauthorized)?;
        self.require_live(now)?;
        require!(
            seat != self.current_seat() && self.is_active(seat),
            GameError::Unauthorized
        );
        require!(self.tradeable(seat, space as usize), GameError::CannotTrade);
        self.trade.offers[seat] = space;
        self.last_action_at = now;
        Ok(())
    }

    /// The lander accepts `seat`'s offer, naming the offered `space` so an offer replaced in the
    /// meantime cannot be accepted by mistake. Both sides get the trade bonus, then the
    /// bankruptcy check and the end conditions run.
    pub fn accept_trade(&mut self, caller: Pubkey, seat: u8, space: u8, now: i64) -> Result<()> {
        let lander = self.acting_seat(caller, &[Stage::TradeOffers], now)?;
        let seat = seat as usize;
        require!(
            seat < MAX_SEATS && space != NO_OFFER && self.trade.offers[seat] == space,
            GameError::OfferChanged
        );
        // Nothing can sell or build during TradeOffers; re-checked anyway so a stale offer never swaps.
        let given = self.trade.space as usize;
        require!(
            self.is_active(seat)
                && self.tradeable(seat, space as usize)
                && self.tradeable(lander, given),
            GameError::CannotTrade
        );
        self.board[given].owner = seat as u8;
        self.board[space as usize].owner = lander as u8;
        self.seats[lander].cash += TRADE_BONUS;
        self.seats[seat].cash += TRADE_BONUS;
        // The swap can lower either side's net worth; a seat in debt can end at or below zero.
        self.eliminate_if_bankrupt(lander);
        self.eliminate_if_bankrupt(seat);
        self.trade = Trade::default();
        self.last_action_at = now;
        self.finish_roll(now);
        self.check_end(now);
        Ok(())
    }

    /// The current seat, when `caller` holds it, the turn is in one of `stages` and the game is
    /// not past its idle deadline.
    fn acting_seat(&self, caller: Pubkey, stages: &[Stage], now: i64) -> Result<usize> {
        require!(
            self.phase == TablePhase::Playing && stages.contains(&self.stage),
            GameError::InvalidStage
        );
        let seat = self.current_seat();
        require!(self.seats[seat].wallet == caller, GameError::Unauthorized);
        self.require_live(now)?;
        Ok(seat)
    }

    /// Anyone may call this. The idle deadline is checked before stage deadlines, so the first
    /// player back at an abandoned table ends it by ranking instead of forfeiting everyone.
    pub fn force_timeout(&mut self, now: i64) -> Result<()> {
        let idle_at = self.last_action_at + IDLE_SECONDS;
        match self.phase {
            // Settle keeps failing: each seat pulls its ranked payout through refund_player instead.
            TablePhase::Finished if now >= idle_at.max(self.ended_at) + EMERGENCY_SECONDS => {
                // A seat with nothing to receive is done already.
                let payouts = self.payouts()?;
                for (seat, payout) in self.seats.iter_mut().zip(payouts) {
                    seat.payout = payout;
                    seat.refunded = payout == 0;
                }
                self.begin_refunds(now);
            }
            TablePhase::Playing if now >= idle_at => {
                if self.stage == Stage::Ordering {
                    // No turn order means no cash and no ranking: return every entry instead.
                    self.begin_refunds(now);
                    self.vrf_purpose = VrfPurpose::None;
                } else {
                    self.finish(now);
                }
            }
            // An offer window that closes empty cancels the trade with no strike: the lander did
            // nothing wrong, so its turn continues as after a pass.
            TablePhase::Playing
                if self.stage == Stage::TradeOffers
                    && self.trade.offers.iter().all(|&offer| offer == NO_OFFER)
                    && now >= self.trade.deadline =>
            {
                self.trade = Trade::default();
                self.finish_roll(now);
                self.check_end(now);
            }
            TablePhase::Playing
                if matches!(
                    self.stage,
                    Stage::PreRoll | Stage::BuyDecision | Stage::TradeOpen | Stage::TradeOffers
                ) && now >= self.stage_deadline =>
            {
                // A timed-out PreRoll skips the turn (a jailed seat serves that turn). A timed-out
                // BuyDecision or trade stage passes, strikes the current seat (offerers never are)
                // and ends the turn, including any extra roll from a 6.
                let seat = self.current_seat();
                self.trade = Trade::default();
                if self.stage == Stage::PreRoll && self.seats[seat].jail_turns > 0 {
                    self.seats[seat].jail_turns -= 1;
                }
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

    /// Records what `settle` paid. A seat in `unpaid` had a share but no live token accounts, so
    /// its share stayed in custody: the table then waits in Refunding until that seat pulls it
    /// with `refund_player`, or the grace period passes and it goes to the treasury.
    pub fn record_settlement(
        &mut self,
        payouts: [u64; MAX_SEATS],
        unpaid: [bool; MAX_SEATS],
        now: i64,
    ) {
        for ((seat, payout), unpaid) in self.seats.iter_mut().zip(payouts).zip(unpaid) {
            seat.payout = payout;
            seat.refunded = !unpaid;
        }
        if unpaid.contains(&true) {
            self.begin_refunds(now);
        } else {
            self.phase = TablePhase::Free;
        }
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

    /// The bankruptcy check run after every cash decrease: net worth at or below 0, or cash below
    /// -$500, eliminates the seat.
    fn eliminate_if_bankrupt(&mut self, seat: usize) {
        if self.is_active(seat)
            && (self.net_worth(seat) <= 0 || self.seats[seat].cash < BANKRUPT_CASH_BELOW)
        {
            self.eliminate(seat);
        }
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
        self.trade = Trade::default();
        self.stage_deadline = 0;
        self.vrf_purpose = VrfPurpose::None;
        self.ended_at = now;
    }
}
