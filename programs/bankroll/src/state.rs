use anchor_lang::prelude::*;

use crate::board::SPACES;

pub const MAX_SEATS: usize = 4;
pub const NAME_LEN: usize = 16;
/// Board name sets the client can draw (0 Classic, 1 Bangalore, 2 Mumbai). Rules and prices are
/// identical across themes; only the names differ.
pub const BOARD_THEMES: u8 = 3;
pub const NO_OWNER: u8 = u8::MAX;
/// Space 0 (Start) is never a property, so it marks an empty trade offer and zeroed bytes read as none.
pub const NO_OFFER: u8 = 0;
pub const LOBBY_SECONDS: i64 = 600;
pub const FEE_BPS: u64 = 300;
/// How long a Refunding seat whose token accounts are gone keeps its share before anyone may send
/// it to the treasury instead, so one closed account cannot keep a table out of the pool.
pub const REFUND_GRACE_SECONDS: i64 = 1800;
/// How long a seat that isn't rolling waits before it may re-request a missing roll.
pub const OTHER_SEAT_RETRY_SECONDS: i64 = 3 * crate::board::VRF_RETRY_SECONDS;
/// Ranked shares in bps of the pot, indexed by `player_count - 2`. The 2-player row (9700 to the
/// winner) was confirmed by the user on 2026-11-03. Every row plus the fee sums to 10,000.
pub const SHARES_BPS: [[u64; 3]; 3] = [[9700, 0, 0], [6700, 3000, 0], [6000, 2700, 1000]];
/// 0.001 USDC is the free-play entry: one sponsored 0.50 deposit then covers about 500 games.
pub const ENTRIES: [u64; 3] = [1_000, 1_000_000, 5_000_000];
/// Zero bytes allocated after the serialized Table. Later phases append fields here without
/// changing the account size; old accounts read the new fields as zero.
/// 1023 since `theme` took one byte and 1015 since `start_cash` took eight, so TABLE_SPACE (and
/// every live account) stays the same size.
pub const TABLE_RESERVED: usize = 1015;
pub const TABLE_SPACE: usize = 8 + Table::INIT_SPACE + TABLE_RESERVED;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SpaceKind {
    Start,
    City,
    Lucky,
    Public,
    Jail,
    Auction,
}

#[derive(Clone, Copy, Debug)]
pub struct SpaceSpec {
    pub kind: SpaceKind,
    pub group: u8,
    pub price: i64,
    pub rent: i64,
    pub building_cost: i64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LuckyKind {
    /// Collect (positive) or pay (negative) `amount` from the bank.
    Bank,
    PayEach,
    CollectEach,
    ToStart,
    ToJail,
    /// Move `amount` spaces; negative moves back and never pays salary.
    Move,
    /// Pay `amount` per building owned.
    Repairs,
}

#[derive(Clone, Copy, Debug)]
pub struct LuckyCard {
    pub kind: LuckyKind,
    pub amount: i64,
}

#[account]
#[derive(InitSpace, Default, Debug, PartialEq)]
pub struct Table {
    pub index: u16,
    pub bump: u8,
    /// Offset 11 (after the 8-byte discriminator); the free-table finder filters on it.
    pub phase: TablePhase,
    /// Increments on every `open_table`; invites and `join_table` bind to it.
    pub game_nonce: u64,
    /// Monotonic across games so a late callback can never match a later request.
    pub vrf_nonce: u64,
    pub host: Pubkey,
    pub entry: u64,
    pub max_players: u8,
    pub target: u64,
    pub player_count: u8,
    pub lobby_deadline: i64,
    /// Last successful player action; `force_timeout` and VRF callbacks never move it.
    pub last_action_at: i64,
    pub stage: Stage,
    /// The current stage's deadline while Playing; in Refunding, when the refund grace ends.
    pub stage_deadline: i64,
    /// Index into `order` of the seat whose turn it is.
    pub turn: u8,
    pub order: [u8; MAX_SEATS],
    pub round: u32,
    pub rolls_this_turn: u8,
    pub extra_roll: bool,
    pub vrf_purpose: VrfPurpose,
    pub vrf_requested_at: i64,
    pub last_roll: u8,
    /// Lucky card drawn by the latest roll, 1-12 as in `economy.md`; 0 when none was drawn.
    pub last_card: u8,
    /// Highest `eliminated_at` used so far; seats eliminated by one instruction share a value.
    pub elimination_seq: u8,
    pub ended_at: i64,
    pub seats: [Seat; MAX_SEATS],
    pub board: [Lot; SPACES],
    pub trade: Trade,
    /// The host's board theme for this game, below `BOARD_THEMES`. Display only.
    pub theme: u8,
    /// The host's pick from `START_CASH_OPTIONS`: every seat's cash before the turn-order bonus.
    /// `target` is a `TARGETS` value moved by the same amount. Zero on a lobby opened before this
    /// field existed, which plays as `START_CASH`.
    pub start_cash: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, InitSpace)]
pub struct Seat {
    pub wallet: Pubkey,
    pub name: [u8; NAME_LEN],
    /// In Refunding, whether this seat's money has left custody (or it had none to receive).
    pub refunded: bool,
    pub cash: i64,
    pub position: u8,
    pub jail_turns: u8,
    pub strikes: u8,
    /// 0 while active.
    pub eliminated_at: u8,
    /// Set by `settle` for the results screen.
    pub payout: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, InitSpace)]
pub struct Lot {
    pub owner: u8,
    pub buildings: u8,
}

impl Default for Lot {
    fn default() -> Self {
        Self { owner: NO_OWNER, buildings: 0 }
    }
}

/// The Auction-space trade, live only in `TradeOffers` and all zero otherwise.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, InitSpace)]
pub struct Trade {
    /// The lander's offered property.
    pub space: u8,
    /// Each seat's counter-offer, or `NO_OFFER`.
    pub offers: [u8; MAX_SEATS],
    /// Offers close here; the lander may still decide until `stage_deadline`.
    pub deadline: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub enum TablePhase {
    #[default]
    Free,
    Lobby,
    Playing,
    Finished,
    Refunding,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub enum Stage {
    #[default]
    Idle,
    /// Waiting for the turn-order VRF callback.
    Ordering,
    PreRoll,
    Rolling,
    BuyDecision,
    TradeOpen,
    TradeOffers,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug, InitSpace)]
pub enum VrfPurpose {
    #[default]
    None,
    Order,
    Roll,
}

#[error_code]
pub enum GameError {
    #[msg("Entry must be 0.001, 1, or 5 devnet USDC")]
    InvalidEntry,
    #[msg("Players must be 2-4, start cash 1000, 1500 or 2000, the target 2500, 5000 or 7000 moved by start cash - 1500, and the theme 0-2")]
    InvalidConfig,
    #[msg("Name must contain 1 to 16 UTF-8 bytes")]
    InvalidName,
    #[msg("Operation is not allowed in this phase")]
    InvalidPhase,
    #[msg("Operation is not allowed in this turn stage")]
    InvalidStage,
    #[msg("Lobby is closed or expired")]
    LobbyClosed,
    #[msg("This invite is for an earlier game at this table")]
    StaleNonce,
    #[msg("Table is full")]
    TableFull,
    #[msg("Wallet already joined")]
    AlreadyJoined,
    #[msg("At least two players are required")]
    NotEnoughPlayers,
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Invalid account owner or address")]
    InvalidAccount,
    #[msg("Deadline has not passed")]
    TooEarly,
    #[msg("Deposit was already refunded")]
    AlreadyRefunded,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid or repeated VRF callback")]
    UnexpectedRandomness,
    #[msg("Not enough cash")]
    InsufficientCash,
    #[msg("Table custody does not hold the pot")]
    CustodyShort,
    #[msg("Table custody must be empty after settlement")]
    CustodyNotEmpty,
    #[msg("You do not own this property")]
    NotYourProperty,
    #[msg("Build needs a city in a full group without a hotel yet")]
    CannotBuild,
    #[msg("Only a jailed player can pay bail")]
    NotJailed,
    #[msg("Trades need a property you own without buildings")]
    CannotTrade,
    #[msg("The offer window has closed")]
    OffersClosed,
    #[msg("That seat has no such offer; it may have changed")]
    OfferChanged,
    #[msg("The idle deadline has passed; the game can only end by ranking")]
    IdleDeadlinePassed,
    #[msg("Amount must be positive and at most the treasury balance")]
    InvalidAmount,
    #[msg(
        "The seat's token accounts are gone; its share goes to the treasury after the refund grace"
    )]
    RecipientMissing,
}
