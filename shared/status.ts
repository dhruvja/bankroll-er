import { board } from './board';
import { PHASES, type Phase, type TableView } from './chain';

const EMERGENCY_SECONDS = 1800;

export interface TableHealth {
  index: number; address: string; phase: Phase; gameNonce: number; players: number;
  /** Atoms the table's custody holds and the atoms it owes players (entries, or unpaid shares). */
  custody: bigint; liability: bigint;
  /** What an operator or any client should do next, or undefined when the table needs nothing. */
  attention?: string;
}

export interface PoolStatus {
  ok: boolean; erNow: number; tables: TableHealth[];
  occupancy: Record<Phase, number>;
  custodyTotal: bigint; liabilityTotal: bigint;
  /** Tables whose custody is below what they owe: money is missing (an ER or program fault). */
  shortfall: number[];
  /** Tables holding more than they owe: a finished game's fee awaiting its sweep, or stray deposits. */
  surplus: number[];
  treasury: bigint;
  vrfPayer: string;
}

/** What a table's custody must cover. A finished game owes the ranked share of every seat that
 * hasn't been paid; an unfinished one owes every unrefunded entry. */
export function liability(table: TableView): bigint {
  const pot = BigInt(table.entry) * BigInt(table.playerCount);
  switch (table.phase) {
    case 'free': return 0n;
    case 'lobby': case 'playing': case 'finished': return pot;
    case 'refunding': return table.seats.reduce((sum, seat) => seat.refunded ? sum : sum + BigInt(table.endedAt ? seat.payout : table.entry), 0n);
  }
}

/** Pool health from one ER snapshot: `custody[i]` is table i's custody balance; `now` is ER time. */
export function poolStatus(tables: TableView[], custody: bigint[], treasury: bigint, now: number): PoolStatus {
  const idle = board.rules.deadlinesSec.idle;
  const health = tables.map((table, at): TableHealth => {
    const idleAt = table.lastActionAt + idle;
    let attention: string | undefined;
    if (table.phase === 'lobby' && now >= table.lobbyDeadline) attention = 'lobby expired: any client may expire it, then refund';
    else if (table.phase === 'playing' && now >= idleAt) attention = 'past the idle deadline: any call ends it by ranking (idle-settle)';
    else if (table.phase === 'finished') {
      attention = now >= Math.max(idleAt, table.endedAt) + EMERGENCY_SECONDS ? 'settle failing: emergency refund is due (force_timeout)' : 'awaiting settle';
    } else if (table.phase === 'refunding') {
      const pending = table.seats.filter(seat => !seat.refunded).length;
      attention = `${pending} refund(s) pending; closed accounts go to the treasury after ${new Date(table.stageDeadline * 1000).toISOString()}`;
    }
    return { index: table.index, address: table.address, phase: table.phase, gameNonce: table.gameNonce, players: table.playerCount,
      custody: custody[at], liability: liability(table), attention };
  });
  const occupancy = Object.fromEntries(PHASES.map(phase => [phase, health.filter(table => table.phase === phase).length])) as Record<Phase, number>;
  const shortfall = health.filter(table => table.custody < table.liability).map(table => table.index);
  const surplus = health.filter(table => table.custody > table.liability).map(table => table.index);
  return {
    ok: shortfall.length === 0, erNow: now, tables: health, occupancy,
    custodyTotal: health.reduce((sum, table) => sum + table.custody, 0n),
    liabilityTotal: health.reduce((sum, table) => sum + table.liability, 0n),
    shortfall, surplus, treasury,
    vrfPayer: 'not used: players pay their own VRF requests (phase 01 fact F1)',
  };
}
