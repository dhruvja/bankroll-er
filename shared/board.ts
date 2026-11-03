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
    deadlinesSec: { preRoll: number; buyDecision: number; vrfRetry: number; idle: number; emergencyRefundAfterIdle: number };
    strikesToForfeit: number;
  };
  luckyDeck: LuckyCard[];
}

/** Phase 01 frozen economy (sha256 d9fa832e…, checked by tests/ts/board.test.ts). */
export const board = boardJson as Board;
export const BOARD_SHA256 = 'd9fa832e44f743c06b6bacecd8334f1c6025afbdcffd6a07738b40e3237cc4ba';
export const isProperty = (space: BoardSpace) => space.kind === 'city' || space.kind === 'public';
/** Client default only; the program accepts any of the three targets. */
export const defaultTarget = (players: number) => board.rules.defaultTargetByPlayers[String(players)] ?? board.rules.targets[0];
