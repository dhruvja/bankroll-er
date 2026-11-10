import { board } from './board';
import { CLOSE_GRACE_SECONDS, PHASES, TABLE_RENT, type HouseView, type Phase, type TableView } from './chain';

const EMERGENCY_SECONDS = 1800;

export interface TableHealth {
  address: string; host: string; phase: Phase; gameNonce: number; players: number;
  /** Atoms of the vault the table holds, and the atoms it owes players (entries, or unpaid shares). */
  held: bigint; owes: bigint;
  /** What an operator or any client should do next, or undefined when the table needs nothing. */
  attention?: string;
}

export interface HouseStatus {
  ok: boolean; erNow: number;
  house: { lamports: number; rentExempt: number; liability: bigint; tablesCreated: bigint;
    /** New tables the house can still sponsor: `(lamports - rentExempt) / TABLE_RENT`. */
    capacity: number };
  /** The vault's USDC; it must cover `liability`. Anything above it is stray deposits. */
  vault: bigint; strays: bigint;
  tables: TableHealth[]; occupancy: Record<Phase, number>; heldTotal: bigint;
  /** Money is missing: the vault is below the liability (an ER or program fault). */
  shortfall: boolean;
  /** The house liability disagrees with the sum of the listed tables' `held`. */
  liabilityMismatch: boolean;
  /** Tables holding less than they owe. */
  shortTables: string[];
  /** Tables waiting for a client crank (expire, settle, refund, close). */
  awaitingCrank: number;
  treasury: bigint;
}

/** What a table must still pay out. A finished game owes the ranked share of every seat that
 * hasn't been paid; an unfinished one owes every unrefunded entry. `held` also carries the fee. */
export function owed(table: TableView): bigint {
  const pot = BigInt(table.entry) * BigInt(table.playerCount);
  switch (table.phase) {
    case 'free': return 0n;
    case 'lobby': case 'playing': case 'finished': return pot;
    case 'refunding': return table.seats.reduce((sum, seat) => seat.refunded ? sum : sum + BigInt(table.endedAt ? seat.payout : table.entry), 0n);
  }
}

/** House health from one ER snapshot; `now` is ER time. */
export function houseStatus(input: { tables: TableView[]; house: HouseView & { lamports: number }; rentExempt: number; vault: bigint; treasury: bigint; now: number }): HouseStatus {
  const { tables, house, rentExempt, vault, treasury, now } = input, idle = board.rules.deadlinesSec.idle;
  const health = tables.map((table): TableHealth => {
    const idleAt = table.lastActionAt + idle;
    let attention: string | undefined;
    if (table.phase === 'lobby' && now >= table.lobbyDeadline) attention = 'lobby expired: any client may expire it, then refund';
    else if (table.phase === 'playing' && now >= idleAt) attention = 'past the idle deadline: any call ends it by ranking (idle-settle)';
    else if (table.phase === 'finished') {
      attention = now >= Math.max(idleAt, table.endedAt) + EMERGENCY_SECONDS ? 'settle failing: emergency refund is due (force_timeout)' : 'awaiting settle';
    } else if (table.phase === 'refunding') {
      const pending = table.seats.filter(seat => !seat.refunded).length;
      attention = `${pending} refund(s) pending; closed accounts go to the treasury after ${new Date(table.stageDeadline * 1000).toISOString()}`;
    } else if (table.phase === 'free' && table.held === 0 && now >= table.freedAt + CLOSE_GRACE_SECONDS) attention = 'closable: anyone may close it';
    return { address: table.address, host: table.host, phase: table.phase, gameNonce: table.gameNonce, players: table.playerCount,
      held: BigInt(table.held), owes: owed(table), attention };
  });
  const occupancy = Object.fromEntries(PHASES.map(phase => [phase, health.filter(table => table.phase === phase).length])) as Record<Phase, number>;
  const heldTotal = health.reduce((sum, table) => sum + table.held, 0n);
  const shortfall = vault < house.liability, liabilityMismatch = heldTotal !== house.liability;
  const shortTables = health.filter(table => table.held < table.owes).map(table => table.address);
  return {
    ok: !shortfall && !liabilityMismatch && shortTables.length === 0, erNow: now,
    house: { lamports: house.lamports, rentExempt, liability: house.liability, tablesCreated: house.tablesCreated,
      capacity: Math.max(0, Math.floor((house.lamports - rentExempt) / TABLE_RENT)) },
    vault, strays: vault > house.liability ? vault - house.liability : 0n,
    tables: health, occupancy, heldTotal, shortfall, liabilityMismatch, shortTables,
    awaitingCrank: health.filter(table => table.attention).length, treasury,
  };
}
