import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { board } from '../../shared/board';
import { CLOSE_GRACE_SECONDS, PHASES, TABLE_RENT, tableAddress, type SeatView, type TableView } from '../../shared/chain';
import { houseStatus, owed } from '../../shared/status';

const ENTRY = 1_000_000, NOW = 100_000, idle = board.rules.deadlinesSec.idle, POT = 3 * ENTRY;
const seat = (payout = 0, refunded = false): SeatView => ({ wallet: Keypair.generate().publicKey.toBase58(), name: 'P', refunded, cash: 2000,
  position: 0, jailTurns: 0, strikes: 0, eliminatedAt: 0, payout });
function table(overrides: Partial<TableView> = {}): TableView {
  const host = Keypair.generate().publicKey;
  return {
    address: tableAddress(host).toBase58(), phase: 'free', gameNonce: 1, vrfNonce: 0, host: host.toBase58(), held: 0, entry: ENTRY, maxPlayers: 3,
    target: 5000, playerCount: 3, lobbyDeadline: NOW + 600, lastActionAt: NOW - 10, stage: 'idle', stageDeadline: 0, turn: 0, order: [0, 1, 2, 3],
    round: 0, rollsThisTurn: 0, extraRoll: false, vrfPending: false, vrfRequestedAt: 0, lastRoll: 0, lastCard: 0, eliminationSeq: 0, endedAt: 0, freedAt: NOW - 5,
    seats: [seat(), seat(), seat()], board: [], trade: { space: 0, offers: [], deadline: 0 }, theme: 0, startCash: 1500, ...overrides,
  };
}
const house = (liability: bigint, lamports = 100_000_000 + 1_500_000) => ({ liability, tablesCreated: 9n, lamports });

test('owed is what a table must still pay out in each phase', () => {
  assert.equal(owed(table()), 0n);
  for (const phase of ['lobby', 'playing', 'finished'] as const) assert.equal(owed(table({ phase })), BigInt(POT));
  const refundingLobby = table({ phase: 'refunding', seats: [seat(0, true), seat(), seat()] });
  assert.equal(owed(refundingLobby), 2n * BigInt(ENTRY), 'an unfinished game owes each unrefunded entry');
  const refundingRanked = table({ phase: 'refunding', endedAt: NOW - 100, seats: [seat(2_010_000, true), seat(900_000), seat(0, true)] });
  assert.equal(owed(refundingRanked), 900_000n, 'a finished game owes only the unpaid ranked shares');
});

test('house status checks the vault against the liability and the liability against the tables', () => {
  const tables = [
    table(),
    table({ freedAt: NOW - CLOSE_GRACE_SECONDS }),
    table({ phase: 'lobby', lobbyDeadline: NOW - 1, held: POT }),
    table({ phase: 'playing', stage: 'preroll', lastActionAt: NOW - idle, held: POT }),
    table({ phase: 'playing', stage: 'rolling', held: POT }),
    table({ phase: 'finished', endedAt: NOW - 5, held: POT }),
    table({ phase: 'finished', endedAt: NOW - idle - 1800, lastActionAt: NOW - idle - 1800, held: POT }),
    table({ phase: 'refunding', endedAt: NOW - 100, stageDeadline: NOW + 60, held: 990_000, seats: [seat(2_010_000, true), seat(900_000), seat(0, true)] }),
  ];
  const liability = BigInt(5 * POT + 990_000), rentExempt = 1_500_000;
  const status = houseStatus({ tables, house: house(liability), rentExempt, vault: liability + 7n, treasury: 123n, now: NOW });
  assert.equal(status.ok, true);
  assert.equal(status.house.capacity, Math.floor(100_000_000 / TABLE_RENT), '0.1 SOL above the rent floor sponsors about 4,990 tables');
  assert.equal(status.strays, 7n, 'stray deposits sit above the liability');
  assert.equal(status.heldTotal, liability);
  assert.deepEqual(PHASES.map(phase => status.occupancy[phase]), PHASES.map(phase => tables.filter(item => item.phase === phase).length));
  assert.equal(status.treasury, 123n);
  const attention = status.tables.map(row => row.attention ?? '');
  assert.equal(attention[0], '', 'a Free table inside its grace needs nothing');
  assert.match(attention[1], /closable/);
  assert.match(attention[2], /lobby expired/);
  assert.match(attention[3], /idle deadline/);
  assert.equal(attention[4], '', 'a live game needs nothing');
  assert.match(attention[5], /awaiting settle/);
  assert.match(attention[6], /emergency refund/);
  assert.match(attention[7], /1 refund\(s\) pending/);
  assert.equal(status.awaitingCrank, 6);

  const short = houseStatus({ tables, house: house(liability), rentExempt, vault: liability - 1n, treasury: 0n, now: NOW });
  assert.ok(!short.ok && short.shortfall, 'a vault below the liability is a fault');
  const mismatch = houseStatus({ tables, house: house(liability + 1n), rentExempt, vault: liability + 1n, treasury: 0n, now: NOW });
  assert.ok(!mismatch.ok && mismatch.liabilityMismatch, 'the liability must equal the tables\' held');
  const underHeld = [...tables.slice(0, 7), { ...tables[7], held: 899_999 }];
  const underStatus = houseStatus({ tables: underHeld, house: house(liability - 90_001n), rentExempt, vault: liability, treasury: 0n, now: NOW });
  assert.deepEqual(underStatus.shortTables, [tables[7].address], 'a table holding less than it owes');
  assert.equal(underStatus.ok, false);
  assert.equal(houseStatus({ tables: [], house: house(0n, rentExempt + TABLE_RENT - 1), rentExempt, vault: 0n, treasury: 0n, now: NOW }).house.capacity, 0);
});
