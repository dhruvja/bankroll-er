import { board, type BoardSpace } from './board';

/** Board themes rename spaces only. Rules, prices and groups come from `board.json` for every theme,
 * and the table stores the host's pick on-chain (`Table.theme`, below the program's `BOARD_THEMES`). */
export interface Theme { id: number; name: string; tagline: string; names: Record<number, string> }

export const THEMES: Theme[] = [
  { id: 0, name: 'Classic', tagline: 'World cities, Lisbon to New York', names: {} },
  {
    id: 1, name: 'Bangalore', tagline: 'Peenya to Koramangala',
    names: {
      1: 'Peenya', 2: 'Yelahanka', 3: 'BMTC Bus', 4: 'E-City', 5: 'Marathahalli', 6: 'BTM Layout', 8: 'Jayanagar',
      9: 'Malleshwaram', 10: 'BESCOM', 11: 'Hebbal', 12: 'Whitefield', 13: 'JP Nagar', 15: 'Bellandur', 16: 'Sarjapur Road',
      17: 'Namma Metro', 18: 'MG Road', 19: 'Frazer Town', 20: 'HSR Layout', 22: 'Sadashivanagar', 23: 'Lavelle Road',
      24: 'Airport', 25: 'Cunningham Road', 26: 'Indiranagar', 27: 'Koramangala',
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
