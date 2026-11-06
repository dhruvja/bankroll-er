import { board, type BoardSpace } from './board';

/** Board themes rename spaces only. Rules, prices and groups come from `board.json` for every theme,
 * and the table stores the host's pick on-chain (`Table.theme`, below the program's `BOARD_THEMES`). */
export interface Theme { id: number; name: string; tagline: string; names: Record<number, string> }

export const THEMES: Theme[] = [
  { id: 0, name: 'Classic', tagline: 'World cities, Lisbon to New York', names: {} },
  {
    id: 1, name: 'Bangalore', tagline: 'Peenya to Lavelle Road',
    names: {
      1: 'Peenya', 2: 'Yelahanka', 3: 'Namma Metro', 4: 'E-City', 5: 'Bellandur', 6: 'BTM Layout', 8: 'Jayanagar',
      9: 'Malleshwaram', 10: 'Airport', 11: 'HSR Layout', 12: 'Whitefield', 13: 'Marathahalli', 15: 'Hebbal', 16: 'JP Nagar',
      17: 'BMTC Bus', 18: 'Indiranagar', 19: 'Koramangala', 20: 'Frazer Town', 22: 'Richmond Town', 23: 'Cunningham Road',
      24: 'BESCOM', 25: 'MG Road', 26: 'Sadashivanagar', 27: 'Lavelle Road',
    },
  },
  {
    id: 2, name: 'Mumbai', tagline: 'Dharavi to Malabar Hill',
    names: {
      1: 'Dharavi', 2: 'Kurla', 3: 'Local Train', 4: 'Borivali', 5: 'Thane', 6: 'Ghatkopar', 8: 'Chembur',
      9: 'Dadar', 10: 'Airport', 11: 'Andheri', 12: 'Powai', 13: 'Goregaon', 15: 'Matunga', 16: 'Lower Parel',
      17: 'Ferry', 18: 'Bandra', 19: 'Juhu', 20: 'Khar', 22: 'Colaba', 23: 'Marine Drive',
      24: 'BEST', 25: 'Worli', 26: 'Cuffe Parade', 27: 'Malabar Hill',
    },
  },
];

const themed = THEMES.map(theme => board.spaces.map(space => ({ ...space, name: theme.names[space.index] ?? space.name })));

/** The board's spaces with this theme's names; an unknown theme falls back to Classic. */
export const spacesFor = (theme: number): BoardSpace[] => themed[theme] ?? themed[0];
