import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BorshAccountsCoder } from '@anchor-lang/core';
import BN from 'bn.js';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { PUBLIC_VALIDATOR } from '../../shared/config';
import { BOARD_SHA256, board, defaultTarget } from '../../shared/board';
import {
  NO_OFFER, NO_OWNER, PROGRAM_ID, accountsFor, buildInstruction, canBuild, currentSeat, custodyAddress, decodeTable, expectedPayouts, idl, netWorth,
  custodyRecordAddress, isLiveCustodyRecord, rent, saleValue, settleRemaining, tableAddress, tokenAddress, tradeOffers, tradeable, type TableView,
} from '../../shared/chain';
import { nextCrank } from '../../shared/client';
import { BOARD_RS, renderBoardRs } from '../../scripts/gen-board';

const root = resolve(import.meta.dirname, '../..');

test('the shared board is the frozen phase 01 economy and board.rs is generated from it', () => {
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'shared/board.json'))).digest('hex'), BOARD_SHA256);
  assert.equal(readFileSync(BOARD_RS, 'utf8'), renderBoardRs(board));
  assert.deepEqual([2, 3, 4].map(defaultTarget), [2500, 5000, 7000]);
});

function encodedTable(overrides: Record<string, unknown> = {}) {
  const wallets = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
  const seat = (index: number) => ({ wallet: wallets[index], name: [...Buffer.from(`P${index}`), ...Array(14).fill(0)], refunded: false,
    cash: new BN(2000), position: 0, jail_turns: 0, strikes: 0, eliminated_at: 0, payout: new BN(0) });
  const zero = new BN(0);
  const raw = {
    index: 5, bump: 254, phase: { Finished: {} }, game_nonce: new BN(3), vrf_nonce: new BN(11), host: wallets[0], entry: new BN(1_000_000),
    max_players: 3, target: new BN(3000), player_count: 3, lobby_deadline: zero, last_action_at: new BN(1000), stage: { Idle: {} },
    stage_deadline: zero, turn: 0, order: [2, 0, 1, 3], round: 4, rolls_this_turn: 0, extra_roll: false, vrf_purpose: { None: {} },
    vrf_requested_at: zero, last_roll: 6, last_card: 0, elimination_seq: 0, ended_at: new BN(1200),
    seats: [0, 1, 2, 3].map(seat), board: Array.from({ length: 28 }, () => ({ owner: NO_OWNER, buildings: 0 })),
    trade: { space: 0, offers: [0, 0, 0, 0], deadline: zero }, ...overrides,
  };
  return { raw, wallets };
}
async function decoded(overrides: Record<string, unknown> = {}): Promise<TableView> {
  const { raw } = encodedTable(overrides);
  const data = await new BorshAccountsCoder(idl).encode('Table', raw);
  return decodeTable(tableAddress(5), data);
}

test('a Table account decodes with its phase at byte 11 and rejects a non-canonical address', async () => {
  const { raw } = encodedTable();
  const data = await new BorshAccountsCoder(idl).encode('Table', raw);
  assert.equal(data[11], 3, 'Finished is variant 3');
  const view = decodeTable(tableAddress(5), data);
  assert.equal(view.phase, 'finished');
  assert.deepEqual(view.order, [2, 0, 1]);
  assert.equal(view.seats.length, 3);
  assert.equal(view.seats[1].name, 'P1');
  assert.throws(() => decodeTable(tableAddress(6), data), /canonical/);
});

test('expectedPayouts mirrors the program for ranks, ties, eliminations and dust', async () => {
  const cases: [number[], number[], number[]][] = [
    [[3000, 2000, 1000], [0, 0, 0], [2_010_000, 900_000, 0]],
    [[3000, 3000, 1000], [0, 0, 0], [1_455_000, 1_455_000, 0]],
    [[2000, 2000, 2000], [0, 0, 0], [970_000, 970_000, 970_000]],
    [[3000, 0, 0], [0, 1, 1], [2_010_000, 450_000, 450_000]],
    [[0, 9000, 0], [2, 0, 1], [900_000, 2_010_000, 0]],
  ];
  for (const [cash, eliminated, expected] of cases) {
    const { raw } = encodedTable();
    raw.seats.forEach((seat, index) => { seat.cash = new BN(cash[index] ?? 0); seat.eliminated_at = eliminated[index] ?? 0; });
    const view = decodeTable(tableAddress(5), await new BorshAccountsCoder(idl).encode('Table', raw));
    const result = expectedPayouts(view);
    assert.deepEqual(result.payouts, expected, `${cash} ${eliminated}`);
    assert.equal(result.treasury, 3_000_000 - expected.reduce((a, b) => a + b, 0));
  }
  const four = await decoded({ player_count: 4, max_players: 4 });
  four.seats.forEach((seat, index) => { seat.cash = [4000, 4000, 4000, 1000][index]; });
  assert.deepEqual(expectedPayouts(four).payouts, [1_293_333, 1_293_333, 1_293_333, 0]);
  const owned = await decoded();
  owned.board[27] = { owner: 1, buildings: 2 };
  assert.equal(netWorth(owned, 1), 2000 + 400 + 2 * 200);
});

test('the IDL builder orders accounts and flags signers, and settle appends each seat pair', async () => {
  const actor = Keypair.generate().publicKey, table = tableAddress(2);
  const open = buildInstruction('open_table', accountsFor(table, actor), { name: 'Host', entry: new BN(1_000_000), max_players: 3, target: new BN(3000), theme: 0 });
  assert.ok(open.programId.equals(PROGRAM_ID));
  assert.deepEqual(open.keys.map(key => key.pubkey.toBase58()), [actor, table, open.keys[2].pubkey, tokenAddress(actor), tokenAddress(table),
    custodyAddress(table), custodyAddress(actor), open.keys[7].pubkey].map(key => key.toBase58()));
  assert.deepEqual(open.keys.map(key => key.isSigner), [true, false, false, false, false, false, false, false]);
  const view = await decoded();
  const settle = buildInstruction('settle', accountsFor(table, actor), {}, settleRemaining(view));
  assert.equal(settle.keys.length, 7 + 2 * view.playerCount);
  assert.ok(settle.keys[7].pubkey.equals(tokenAddress(new PublicKey(view.seats[0].wallet))) && settle.keys[7].isWritable);
  assert.ok(settle.keys[8].pubkey.equals(custodyRecordAddress(new PublicKey(view.seats[0].wallet))) && !settle.keys[8].isWritable);
  const gone = settleRemaining(view, [true, false, true]);
  assert.deepEqual(gone.map(key => key.isWritable), [true, false, false, false, true, false], 'only a live, paid ATA is writable');
  assert.throws(() => buildInstruction('refund_player', {}, { seat: 0 }), /Missing account/);
  const withdraw = buildInstruction('withdraw_fees', accountsFor(table, actor), { amount: new BN(5) });
  assert.ok(withdraw.keys[0].isSigner && withdraw.keys[4].pubkey.equals(tokenAddress(actor)) && withdraw.keys[4].isWritable);
});

test('a custody record is live only when it delegates an ESPL account to the public validator', () => {
  const record = (authority: string, owner: PublicKey, discriminator = 100n) => {
    const data = Buffer.alloc(96);
    data.writeBigUInt64LE(discriminator, 0);
    new PublicKey(authority).toBuffer().copy(data, 8);
    owner.toBuffer().copy(data, 40);
    return data;
  };
  const live = { owner: DELEGATION_PROGRAM_ID, data: record(PUBLIC_VALIDATOR, EPHEMERAL_SPL_TOKEN_PROGRAM_ID) };
  assert.ok(isLiveCustodyRecord(live));
  assert.ok(!isLiveCustodyRecord(null), 'undelegated: the record is gone');
  assert.ok(!isLiveCustodyRecord({ ...live, owner: SystemProgram.programId }));
  assert.ok(!isLiveCustodyRecord({ ...live, data: record(Keypair.generate().publicKey.toBase58(), EPHEMERAL_SPL_TOKEN_PROGRAM_ID) }), 'another validator');
  assert.ok(!isLiveCustodyRecord({ ...live, data: record(PUBLIC_VALIDATOR, PROGRAM_ID) }), 'not an eATA');
  assert.ok(!isLiveCustodyRecord({ ...live, data: record(PUBLIC_VALIDATOR, EPHEMERAL_SPL_TOKEN_PROGRAM_ID, 101n) }));
});

test('the crank picks the liveness action each participant may send and when', async () => {
  const view = await decoded({ phase: { Playing: {} }, stage: { PreRoll: {} }, stage_deadline: new BN(1030) });
  const me = view.seats[1].wallet, rules = board.rules.deadlinesSec;
  assert.equal(nextCrank(view, Keypair.generate().publicKey.toBase58(), 1000), undefined, 'outsiders do not crank');
  assert.deepEqual(nextCrank(view, me, 1000), { action: 'timeout', at: 1030 });
  assert.notEqual(currentSeat(view), 1);
  assert.deepEqual(nextCrank({ ...view, stage: 'rolling', vrfRequestedAt: 1010 }, me, 1000), { action: 'retry-roll', at: 1010 + 3 * rules.vrfRetry });
  assert.deepEqual(nextCrank({ ...view, stage: 'rolling', vrfRequestedAt: 1010, order: [1, 0, 2, 3] }, me, 1000), { action: 'retry-roll', at: 1010 + rules.vrfRetry });
  for (const stage of ['preroll', 'rolling', 'buydecision', 'tradeoffers'] as const) {
    assert.deepEqual(nextCrank({ ...view, stage }, me, 1000 + rules.idle), { action: 'idle-settle', at: 1000 + rules.idle }, `past idle in ${stage}: end and settle at once`);
  }
  assert.deepEqual(nextCrank({ ...view, stage: 'ordering' }, me, 1000 + rules.idle)?.action, 'timeout', 'no turn order: the timeout refunds');
  assert.deepEqual(nextCrank({ ...view, stage: 'ordering', vrfRequestedAt: 1000 }, me, 1001), { action: 'retry-start', at: 1000 + rules.vrfRetry });
  // A due action must carry a fixed past time: `startCrank` fires once now >= at + jitter, so `at: now` would never fire.
  assert.deepEqual(nextCrank({ ...view, phase: 'finished', endedAt: 900 }, me, 1000), { action: 'settle', at: 900 }, 'settle is due from the end');
  const failing = { ...view, phase: 'finished' as const, endedAt: 900, lastActionAt: 800 }, emergency = 800 + rules.idle + rules.emergencyRefundAfterIdle;
  assert.deepEqual(nextCrank(failing, me, emergency - 1), { action: 'settle', at: 900 }, 'settle until the emergency deadline');
  assert.deepEqual(nextCrank(failing, me, emergency), { action: 'timeout', at: emergency }, 'then the emergency refund');
  assert.deepEqual(nextCrank({ ...view, phase: 'lobby', lobbyDeadline: 1600 }, me, 5), { action: 'expire', at: 1600 });
  const refunding = { ...view, phase: 'refunding' as const, seats: view.seats.map((seat, index) => ({ ...seat, refunded: index === 0 })) };
  assert.deepEqual(nextCrank({ ...refunding, endedAt: 0 }, me, 7), { action: 'refund', at: 0 }, 'a lobby refund is due at once');
  assert.deepEqual(nextCrank({ ...refunding, endedAt: 900 }, me, 1000), { action: 'refund', at: 900 }, 'a finished game refunds from its end');
  assert.equal(nextCrank({ ...refunding, seats: refunding.seats.map(seat => ({ ...seat, refunded: true })) }, me, 7), undefined);
  assert.equal(nextCrank({ ...view, phase: 'free' }, me, 7), undefined);
  const offers = { ...view, stage: 'tradeoffers' as const, stageDeadline: 1035, trade: { space: 1, offers: [0, 0, 0], deadline: 1020 } };
  assert.deepEqual(nextCrank(offers, me, 1000), { action: 'timeout', at: 1020 }, 'an empty offer window cancels when it closes');
  assert.deepEqual(nextCrank({ ...offers, trade: { ...offers.trade, offers: [0, 2, 0] } }, me, 1000), { action: 'timeout', at: 1035 }, 'with offers, the lander decides until the stage deadline');
  assert.deepEqual(nextCrank({ ...view, stage: 'tradeopen', stageDeadline: 1020 }, me, 1000), { action: 'timeout', at: 1020 });
});

test('the trade decodes, and offers list in turn order after the lander', async () => {
  const { raw } = encodedTable({ phase: { Playing: {} }, stage: { TradeOffers: {} }, trade: { space: 14, offers: [1, 17, 0, 0], deadline: new BN(1020) } });
  const view = decodeTable(tableAddress(5), await new BorshAccountsCoder(idl).encode('Table', raw));
  assert.deepEqual(view.trade, { space: 14, offers: [1, 17, 0], deadline: 1020 }, 'offers are trimmed to the seated players');
  assert.equal(NO_OFFER, 0);
  // Turn order [2, 0, 1]: seat 2 landed, so seat 0 then seat 1 are listed.
  assert.deepEqual(tradeOffers(view), [{ seat: 0, space: 1 }, { seat: 1, space: 17 }]);
  // Seat 0 landed: the list starts after it, at seat 1, and skips seat 2's missing offer.
  assert.deepEqual(tradeOffers({ ...view, turn: 1, trade: { ...view.trade, offers: [0, 1, 0] } }), [{ seat: 1, space: 1 }]);
  const lander = currentSeat(view);
  view.board[14] = { owner: lander, buildings: 0 };
  assert.equal(tradeable(view, lander, 14), true);
  view.board[14].buildings = 1;
  assert.equal(tradeable(view, lander, 14), false, 'a built property cannot be traded');
});

test('jail turns and the Lucky card decode, and the deck matches the frozen economy', async () => {
  const { raw } = encodedTable({ last_card: 10 });
  raw.seats[2].jail_turns = 2;
  const view = decodeTable(tableAddress(5), await new BorshAccountsCoder(idl).encode('Table', raw));
  assert.equal(view.lastCard, 10);
  assert.equal(view.seats[2].jailTurns, 2);
  assert.equal(board.luckyDeck.length, 12);
  assert.equal(board.luckyDeck[view.lastCard - 1].text, 'Move forward 3 (resolve the space you land on).');
  assert.deepEqual([board.rules.jailSpace, board.rules.jailTurns, board.rules.bail, board.rules.saleBps], [7, 3, 150, 8000]);
});

test('rent, sale value and build checks mirror the program', async () => {
  const view = await decoded({ phase: { Playing: {} }, stage: { PreRoll: {} } });
  view.board[1] = { owner: 1, buildings: 0 };
  assert.equal(rent(view, 1), 6, 'base rent without the group');
  assert.equal(canBuild(view, 1, 1), false, 'no building without the full group');
  view.board[2] = { owner: 1, buildings: 0 };
  assert.equal(rent(view, 1), 12, "full group doubles");
  assert.equal(canBuild(view, 1, 1), true);
  for (const [buildings, expected] of [[1, 24], [2, 72], [3, 180], [4, 240], [5, 300]]) {
    view.board[1].buildings = buildings;
    assert.equal(rent(view, 1), expected);
  }
  assert.equal(canBuild(view, 1, 1), false, 'four houses and a hotel at most');
  assert.equal(saleValue(view, 1), Math.floor((60 + 5 * 50) * 0.8));
  view.board[27] = { owner: 0, buildings: 3 };
  view.board[25] = { owner: 0, buildings: 0 };
  view.board[26] = { owner: 0, buildings: 0 };
  assert.equal(rent(view, 27), 1200);
  view.board[25].owner = NO_OWNER;
  assert.equal(rent(view, 27), 40, 'a broken group pays base rent');
  for (const [count, space] of [3, 10, 17, 24].entries()) {
    view.board[space] = { owner: 2, buildings: 0 };
    assert.equal(rent(view, 3), 25 * (count + 1));
  }
  view.seats[1].cash = 49;
  view.board[1].buildings = 0;
  assert.equal(canBuild(view, 1, 1), false, 'needs cash for the building');
});
