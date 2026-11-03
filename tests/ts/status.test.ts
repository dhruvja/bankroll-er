import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { board } from '../../shared/board';
import { PHASES, tableAddress, type SeatView, type TableView } from '../../shared/chain';
import { liability, poolStatus } from '../../shared/status';

const ENTRY = 1_000_000, NOW = 100_000, idle = board.rules.deadlinesSec.idle;
const seat = (payout = 0, refunded = false): SeatView => ({ wallet: Keypair.generate().publicKey.toBase58(), name: 'P', refunded, cash: 2000,
  position: 0, jailTurns: 0, strikes: 0, eliminatedAt: 0, payout });
function table(index: number, overrides: Partial<TableView> = {}): TableView {
  return {
    address: tableAddress(index).toBase58(), index, phase: 'free', gameNonce: 1, vrfNonce: 0, host: seat().wallet, entry: ENTRY, maxPlayers: 3,
    target: 5000, playerCount: 3, lobbyDeadline: NOW + 600, lastActionAt: NOW - 10, stage: 'idle', stageDeadline: 0, turn: 0, order: [0, 1, 2, 3],
    round: 0, rollsThisTurn: 0, extraRoll: false, vrfPending: false, vrfRequestedAt: 0, lastRoll: 0, lastCard: 0, eliminationSeq: 0, endedAt: 0,
    seats: [seat(), seat(), seat()], board: [], trade: { space: 0, offers: [], deadline: 0 }, ...overrides,
  };
}

test('liability is what custody must still pay out in each phase', () => {
  assert.equal(liability(table(0)), 0n);
  for (const phase of ['lobby', 'playing', 'finished'] as const) assert.equal(liability(table(0, { phase })), 3n * BigInt(ENTRY));
  const refundingLobby = table(0, { phase: 'refunding', seats: [seat(0, true), seat(), seat()] });
  assert.equal(liability(refundingLobby), 2n * BigInt(ENTRY), 'an unfinished game owes each unrefunded entry');
  const refundingRanked = table(0, { phase: 'refunding', endedAt: NOW - 100, seats: [seat(2_010_000, true), seat(900_000), seat(0, true)] });
  assert.equal(liability(refundingRanked), 900_000n, 'a finished game owes only the unpaid ranked shares');
});

test('status totals, occupancy and flags agree with the per-table rows', () => {
  const tables = [
    table(0),
    table(1, { phase: 'lobby', lobbyDeadline: NOW - 1 }),
    table(2, { phase: 'playing', stage: 'preroll', lastActionAt: NOW - idle }),
    table(3, { phase: 'playing', stage: 'rolling' }),
    table(4, { phase: 'finished', endedAt: NOW - 5 }),
    table(5, { phase: 'finished', endedAt: NOW - idle - 1800, lastActionAt: NOW - idle - 1800 }),
    table(6, { phase: 'refunding', endedAt: NOW - 100, stageDeadline: NOW + 60, seats: [seat(2_010_000, true), seat(900_000), seat(0, true)] }),
  ];
  const custody = [0n, 3_000_000n, 3_000_000n, 2_999_999n, 3_000_000n, 3_000_000n, 990_000n];
  const status = poolStatus(tables, custody, 123n, NOW);
  assert.equal(status.tables.length, tables.length);
  assert.equal(Object.values(status.occupancy).reduce((sum, count) => sum + count, 0), tables.length);
  assert.deepEqual(PHASES.map(phase => status.occupancy[phase]), PHASES.map(phase => tables.filter(item => item.phase === phase).length));
  assert.equal(status.custodyTotal, custody.reduce((sum, value) => sum + value, 0n));
  assert.equal(status.liabilityTotal, status.tables.reduce((sum, row) => sum + row.liability, 0n));
  assert.equal(status.liabilityTotal, 5n * 3_000_000n + 900_000n);
  assert.deepEqual(status.shortfall, [3], 'a table holding less than it owes is a fault');
  assert.deepEqual(status.surplus, [6], 'a deferred table still holds its fee until the sweep');
  assert.equal(status.ok, false);
  assert.equal(status.treasury, 123n);
  const attention = status.tables.map(row => row.attention ?? '');
  assert.equal(attention[0], '');
  assert.match(attention[1], /lobby expired/);
  assert.match(attention[2], /idle deadline/);
  assert.equal(attention[3], '', 'a live game needs nothing');
  assert.match(attention[4], /awaiting settle/);
  assert.match(attention[5], /emergency refund/);
  assert.match(attention[6], /1 refund\(s\) pending/);
  assert.match(status.vrfPayer, /players pay their own VRF/);
  assert.ok(poolStatus(tables.slice(0, 3), custody.slice(0, 3), 0n, NOW).ok, 'no shortfall, healthy');
});
