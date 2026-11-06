import boardJson from './board.json';

export type SpaceKindName = 'start' | 'city' | 'lucky' | 'public' | 'jail' | 'auction';
export interface BoardSpace { index: number; name: string; kind: SpaceKindName; group?: string; price?: number; rent?: number; buildingCost?: number }
export type LuckyKind = 'bank' | 'pay_each' | 'collect_each' | 'to_start' | 'to_jail' | 'move' | 'repairs';
export interface LuckyCard { id: number; kind: LuckyKind; amount: number; text: string }
export interface Board {
  version: number; status: string;
  spaces: BoardSpace[];
  groups: Record<string, number[]>;
  publics: number[];
  rules: {
    startCash: number; salary: number; bankruptCashBelow: number; maxRollsPerTurn: number;
    jailSpace: number; jailTurns: number; bail: number; saleBps: number; maxBuildingsPerCity: number; tradeBonus: number;
    groupRentMultiplier: number; buildingRentMultipliers: number[]; targets: number[];
    seatBonusStepByTarget: Record<string, number>; defaultTargetByPlayers: Record<string, number>;
    deadlinesSec: { preRoll: number; buyDecision: number; tradeOpen: number; tradeOffers: number; tradeOwnerDecision: number; vrfRetry: number; idle: number; emergencyRefundAfterIdle: number };
    strikesToForfeit: number;
  };
  luckyDeck: LuckyCard[];
}

/** Frozen economy, now with four houses and a hotel (sha256 261910d6…, checked by tests/ts/board.test.ts). */
export const board = boardJson as Board;
export const BOARD_SHA256 = '261910d690e5d4eba1712bd2673237e27728b6e7b7bb9cc35ae2d4a1c7c17370';
export const isProperty = (space: BoardSpace) => space.kind === 'city' || space.kind === 'public';
/** Client default only; the program accepts any of the three targets. */
export const defaultTarget = (players: number) => board.rules.defaultTargetByPlayers[String(players)] ?? board.rules.targets[0];
