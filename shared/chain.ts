import { BorshAccountsCoder, BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import BN from 'bn.js';
import { PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID, deriveEphemeralAta, delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount, delegationRecordPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import idlJson from './idl/bankroll.json';
import { board } from './board';
import { DEVNET_USDC, EPHEMERAL_QUEUE, PUBLIC_VALIDATOR, ROUTER_RPC, SHARES_BPS, VRF_PROGRAM, invariant } from './config';

export const idl = idlJson as Idl;
export const PROGRAM_ID = new PublicKey(idl.address);
export const mintKey = new PublicKey(DEVNET_USDC);
export const NO_OWNER = 255;
/** `Trade.offers` entry for "no offer" (space 0, Start, is never a property). */
export const NO_OFFER = 0;
/** Byte offset of `Table.phase` (8-byte discriminator, u16 index, u8 bump). */
export const PHASE_OFFSET = 11;
export const PHASES = ['free', 'lobby', 'playing', 'finished', 'refunding'] as const;
export const STAGES = ['idle', 'ordering', 'preroll', 'rolling', 'buydecision', 'tradeopen', 'tradeoffers'] as const;
export type Phase = typeof PHASES[number];
export type StageName = typeof STAGES[number];

export const tableAddress = (index: number, program = PROGRAM_ID) => {
  invariant(Number.isInteger(index) && index >= 0 && index <= 0xffff, 'Invalid table index.');
  const seed = Buffer.alloc(2); seed.writeUInt16LE(index);
  return PublicKey.findProgramAddressSync([Buffer.from('table_v1'), seed], program)[0];
};
export const treasuryAddress = (program = PROGRAM_ID) => PublicKey.findProgramAddressSync([Buffer.from('treasury')], program)[0];
export const tokenAddress = (owner: PublicKey) => getAssociatedTokenAddressSync(mintKey, owner, true);
export const custodyAddress = (owner: PublicKey) => deriveEphemeralAta(owner, mintKey)[0];
/** The delegation record of `owner`'s eATA: while it delegates to the public validator, the ER
 * projects (and writes) the owner's canonical ATA. The program's `payable` reads it. */
export const custodyRecordAddress = (owner: PublicKey) => delegationRecordPdaFromDelegatedAccount(custodyAddress(owner));

const DELEGATION_RECORD_DISCRIMINATOR = 100n;
/** Mirrors the program's `delegated_to_public_er` for an eATA's delegation record. */
export function isLiveCustodyRecord(record: { owner: PublicKey; data: Buffer } | null): boolean {
  return !!record && record.owner.equals(DELEGATION_PROGRAM_ID) && record.data.length >= 72
    && record.data.readBigUInt64LE(0) === DELEGATION_RECORD_DISCRIMINATOR
    && new PublicKey(record.data.subarray(8, 40)).toBase58() === PUBLIC_VALIDATOR
    && new PublicKey(record.data.subarray(40, 72)).equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID);
}

/** Raw Anchor decode of the Table account (IDL field names, BN for 64-bit values). */
interface RawSeat {
  wallet: PublicKey; name: number[]; refunded: boolean; cash: BN; position: number;
  jail_turns: number; strikes: number; eliminated_at: number; payout: BN;
}
interface RawTable {
  index: number; bump: number; phase: Record<string, unknown>; game_nonce: BN; vrf_nonce: BN; host: PublicKey;
  entry: BN; max_players: number; target: BN; player_count: number; lobby_deadline: BN; last_action_at: BN;
  stage: Record<string, unknown>; stage_deadline: BN; turn: number; order: number[]; round: number;
  rolls_this_turn: number; extra_roll: boolean; vrf_purpose: Record<string, unknown>; vrf_requested_at: BN;
  last_roll: number; last_card: number; elimination_seq: number; ended_at: BN;
  seats: RawSeat[]; board: { owner: number; buildings: number }[];
  trade: { space: number; offers: number[]; deadline: BN };
  theme: number;
}

export interface SeatView {
  wallet: string; name: string; refunded: boolean; cash: number; position: number;
  jailTurns: number; strikes: number; eliminatedAt: number; payout: number;
}
/** Normalized Table snapshot. Times are unix seconds; token amounts are atoms. */
export interface TableView {
  address: string; index: number; phase: Phase; gameNonce: number; vrfNonce: number; host: string;
  entry: number; maxPlayers: number; target: number; playerCount: number; lobbyDeadline: number;
  lastActionAt: number; stage: StageName; stageDeadline: number; turn: number; order: number[]; round: number;
  rollsThisTurn: number; extraRoll: boolean; vrfPending: boolean; vrfRequestedAt: number; lastRoll: number;
  /** Lucky card (1–12) drawn by the latest roll, 0 when none. */
  lastCard: number;
  eliminationSeq: number; endedAt: number; seats: SeatView[]; board: { owner: number; buildings: number }[];
  /** Live only in `tradeoffers`: the lander's offered space, each seat's counter-offer (`NO_OFFER`
   * for none) and when offers close. The lander may decide until `stageDeadline`. */
  trade: { space: number; offers: number[]; deadline: number };
  /** Board theme the host picked: an index into `THEMES` (names only, rules are shared). */
  theme: number;
}

const variant = (value: Record<string, unknown>) => Object.keys(value)[0].replaceAll('_', '').toLowerCase();

export function decodeTable(address: PublicKey, data: Buffer): TableView {
  const raw = new BorshAccountsCoder(idl).decode('Table', data) as RawTable;
  invariant(tableAddress(raw.index).equals(address), 'Account is not the canonical table for its index.');
  const count = raw.player_count;
  return {
    address: address.toBase58(), index: raw.index, phase: variant(raw.phase) as Phase,
    gameNonce: raw.game_nonce.toNumber(), vrfNonce: raw.vrf_nonce.toNumber(), host: raw.host.toBase58(),
    entry: raw.entry.toNumber(), maxPlayers: raw.max_players, target: raw.target.toNumber(), playerCount: count,
    lobbyDeadline: raw.lobby_deadline.toNumber(), lastActionAt: raw.last_action_at.toNumber(),
    stage: variant(raw.stage) as StageName, stageDeadline: raw.stage_deadline.toNumber(), turn: raw.turn,
    order: raw.order.slice(0, count), round: raw.round, rollsThisTurn: raw.rolls_this_turn, extraRoll: raw.extra_roll,
    vrfPending: variant(raw.vrf_purpose) !== 'none', vrfRequestedAt: raw.vrf_requested_at.toNumber(),
    lastRoll: raw.last_roll, lastCard: raw.last_card, eliminationSeq: raw.elimination_seq, endedAt: raw.ended_at.toNumber(),
    seats: raw.seats.slice(0, count).map(seat => ({
      wallet: seat.wallet.toBase58(), name: Buffer.from(seat.name).toString('utf8').replace(/\0+$/, ''),
      refunded: seat.refunded, cash: seat.cash.toNumber(), position: seat.position, jailTurns: seat.jail_turns, strikes: seat.strikes,
      eliminatedAt: seat.eliminated_at, payout: seat.payout.toNumber(),
    })),
    board: raw.board.map(lot => ({ owner: lot.owner, buildings: lot.buildings })),
    trade: { space: raw.trade.space, offers: raw.trade.offers.slice(0, count), deadline: raw.trade.deadline.toNumber() },
    theme: raw.theme,
  };
}

export const currentSeat = (table: TableView) => table.order[table.turn] ?? 0;
export const isActive = (table: TableView, seat: number) => seat < table.playerCount && table.seats[seat].eliminatedAt === 0;

export function netWorth(table: TableView, seat: number): number {
  return table.board.reduce((sum, lot, index) => {
    if (lot.owner !== seat) return sum;
    const space = board.spaces[index];
    return sum + (space.price ?? 0) + lot.buildings * (space.buildingCost ?? 0);
  }, table.seats[seat].cash);
}

const ownsGroup = (table: TableView, seat: number, group: string) => board.groups[group].every(space => table.board[space].owner === seat);

/** Mirrors `Table::rent`: base, doubled for a full group, ×4/×7/×11/×16 with 1-4 houses and ×22 with a hotel; publics scale with count. */
export function rent(table: TableView, index: number): number {
  const space = board.spaces[index], owner = table.board[index].owner, rules = board.rules;
  if (owner === NO_OWNER || !space.rent || !space.group) return 0;
  if (space.kind === 'public') return space.rent * board.publics.filter(item => table.board[item].owner === owner).length;
  if (!ownsGroup(table, owner, space.group)) return space.rent;
  const buildings = table.board[index].buildings;
  return space.rent * (buildings ? rules.buildingRentMultipliers[buildings - 1] : rules.groupRentMultiplier);
}

/** Mirrors `Table::sell`: 80% of price plus buildings, rounded down. */
export function saleValue(table: TableView, index: number): number {
  const space = board.spaces[index], value = (space.price ?? 0) + table.board[index].buildings * (space.buildingCost ?? 0);
  return Math.floor(value * board.rules.saleBps / 10_000);
}

/** Mirrors `Table::build`'s checks for the current seat in PreRoll. */
export function canBuild(table: TableView, seat: number, index: number): boolean {
  const space = board.spaces[index], lot = table.board[index];
  return space.kind === 'city' && lot.owner === seat && lot.buildings < board.rules.maxBuildingsPerCity
    && Boolean(space.group && ownsGroup(table, seat, space.group)) && table.seats[seat].cash >= (space.buildingCost ?? 0);
}

/** Mirrors `Table::tradeable`: a property `seat` owns with no buildings. */
export const tradeable = (table: TableView, seat: number, index: number) =>
  table.board[index]?.owner === seat && table.board[index].buildings === 0;

/** The offers on the table in turn order after the lander, as (seat, space). */
export function tradeOffers(table: TableView): { seat: number; space: number }[] {
  const lander = currentSeat(table), n = table.order.length;
  return Array.from({ length: n - 1 }, (_, step) => table.order[(table.turn + 1 + step) % n])
    .filter(seat => seat !== lander && (table.trade.offers[seat] ?? NO_OFFER) !== NO_OFFER)
    .map(seat => ({ seat, space: table.trade.offers[seat] }));
}

/** Mirrors `Table::payouts` so clients and the smoke can check settle independently. */
export function expectedPayouts(table: TableView): { payouts: number[]; treasury: number } {
  const n = table.playerCount, pot = table.entry * n, row = SHARES_BPS[n];
  invariant(row, 'Payouts need 2–4 seats.');
  const key = (seat: number): [boolean, number] => isActive(table, seat) ? [true, netWorth(table, seat)] : [false, table.seats[seat].eliminatedAt];
  const payouts = table.seats.map((_, seat) => {
    const [active, value] = key(seat);
    let better = 0, tied = 0;
    for (let other = 0; other < n; other++) {
      const [otherActive, otherValue] = key(other);
      if ((otherActive && !active) || (otherActive === active && otherValue > value)) better++;
      if (otherActive === active && otherValue === value) tied++;
    }
    let bps = 0;
    for (let place = better; place < better + tied; place++) bps += row[place] ?? 0;
    return Math.floor(Math.floor(pot * bps / 10_000) / tied);
  });
  return { payouts, treasury: pot - payouts.reduce((sum, value) => sum + value, 0) };
}

export type InstructionName = 'create_table' | 'delegate_table' | 'open_table' | 'join_table' | 'cancel_or_expire' | 'refund_player'
  | 'start_game' | 'roll' | 'buy' | 'pass' | 'build' | 'sell' | 'pay_bail' | 'open_trade' | 'offer_trade' | 'accept_trade'
  | 'force_timeout' | 'settle' | 'withdraw_fees';

/** Every account name the IDL uses, resolved for one table and one acting wallet. */
export function accountsFor(table: PublicKey, actor: PublicKey, recipient = actor): Record<string, PublicKey> {
  const treasury = treasuryAddress();
  return {
    admin: actor, player: actor, signer: actor, payer: actor, table, treasury,
    admin_token: tokenAddress(actor), admin_eata: custodyAddress(actor),
    delegation_record: delegationRecordPdaFromDelegatedAccount(table),
    player_token: tokenAddress(recipient), table_token: tokenAddress(table), treasury_token: tokenAddress(treasury),
    table_eata: custodyAddress(table), player_eata: custodyAddress(recipient),
    player_custody_record: custodyRecordAddress(recipient), treasury_eata: custodyAddress(treasury),
    token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
    oracle_queue: new PublicKey(EPHEMERAL_QUEUE), vrf_program: new PublicKey(VRF_PROGRAM), slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY,
    program_identity: PublicKey.findProgramAddressSync([Buffer.from('identity')], PROGRAM_ID)[0],
    buffer_table: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(table, PROGRAM_ID),
    delegation_record_table: delegationRecordPdaFromDelegatedAccount(table),
    delegation_metadata_table: delegationMetadataPdaFromDelegatedAccount(table),
    owner_program: PROGRAM_ID, delegation_program: DELEGATION_PROGRAM_ID,
  };
}

/** IDL-driven builder: account order, signer and writable flags come from the IDL. */
export function buildInstruction(name: InstructionName, accounts: Record<string, PublicKey>, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []) {
  const definition = idl.instructions.find(item => item.name === name);
  invariant(definition, `Missing program instruction: ${name}`);
  const keys = definition.accounts.map(account => {
    invariant(!('accounts' in account), 'Nested accounts are unsupported.');
    const pubkey = accounts[account.name] ?? (account.address ? new PublicKey(account.address) : undefined);
    invariant(pubkey, `Missing account ${account.name} for ${name}.`);
    return { pubkey, isSigner: Boolean(account.signer), isWritable: Boolean(account.writable) };
  });
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [...keys, ...remaining], data: new BorshInstructionCoder(idl).encode(name, args) });
}

/** Settle's (canonical ATA, eATA) pair per seat, in seat order. A seat's ATA is writable only when
 * it receives money and is live (`writable[seat]`); the ER rejects writable accounts it doesn't hold. */
export const settleRemaining = (table: TableView, writable: boolean[] = table.seats.map(() => true)): AccountMeta[] => table.seats.flatMap((seat, index) => {
  const wallet = new PublicKey(seat.wallet);
  return [{ pubkey: tokenAddress(wallet), isSigner: false, isWritable: writable[index] ?? false }, { pubkey: custodyRecordAddress(wallet), isSigner: false, isWritable: false }];
});

export interface DelegationStatus { isDelegated: boolean; fqdn?: string; delegationRecord?: { authority?: string } }
export async function delegationStatus(account: PublicKey): Promise<DelegationStatus> {
  const response = await fetch(ROUTER_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { error?: unknown; result?: DelegationStatus };
  invariant(!body.error && body.result, 'Unable to locate the table’s public rollup.');
  if (body.result.fqdn) {
    const url = new URL(body.result.fqdn);
    invariant(url.protocol === 'https:' && url.hostname.endsWith('.magicblock.app') && !url.hostname.includes('tee'), 'Unexpected public rollup route.');
  }
  return body.result;
}

export const u64 = (value: number | bigint) => new BN(value.toString());
