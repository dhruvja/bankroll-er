import { board, type BoardSpace } from './board';

/** Board themes rename spaces only. Rules, prices and groups come from `board.json` for every theme,
 * and the table stores the host's pick on-chain (`Table.theme`, below the program's `BOARD_THEMES`). */
export interface Theme { id: number; name: string; tagline: string; names: Record<number, string> }

export const THEMES: Theme[] = [
  { id: 0, name: 'Classic', tagline: 'World cities, Lisbon to New York', names: {} },
  {
    id: 1, name: 'Bangalore', tagline: 'Peenya to Lavelle Road',
    names: {
      1: 'Peenya', 2: 'Yelahanka', 4: 'Namma Metro', 5: 'E-City', 7: 'Bellandur', 8: 'BTM Layout', 10: 'Airport',
      11: 'Jayanagar', 13: 'Malleshwaram', 14: 'HSR Layout', 16: 'BMTC Bus', 17: 'Whitefield', 19: 'Indiranagar',
      20: 'Koramangala', 21: 'MG Road', 22: 'BESCOM', 23: 'Lavelle Road',
    },
  },
  {
    id: 2, name: 'Mumbai', tagline: 'Dharavi to Malabar Hill',
    names: {
      1: 'Dharavi', 2: 'Kurla', 4: 'Local Train', 5: 'Borivali', 7: 'Thane', 8: 'Ghatkopar', 10: 'Airport',
      11: 'Chembur', 13: 'Dadar', 14: 'Andheri', 16: 'Ferry', 17: 'Powai', 19: 'Bandra',
      20: 'Juhu', 21: 'Worli', 22: 'BEST', 23: 'Malabar Hill',
    },
  },
];

const themed = THEMES.map(theme => board.spaces.map(space => ({ ...space, name: theme.names[space.index] ?? space.name })));

/** The board's spaces with this theme's names; an unknown theme falls back to Classic. */
export const spacesFor = (theme: number): BoardSpace[] => themed[theme] ?? themed[0];
