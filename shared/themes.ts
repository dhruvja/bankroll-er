import { board, type BoardSpace } from './board';

/** Board themes rename spaces only. Rules, prices and groups come from `board.json` for every theme,
 * and the table stores the host's pick on-chain (`Table.theme`, below the program's `BOARD_THEMES`). */
export interface Theme { id: number; name: string; tagline: string; names: Record<number, string> }

export const THEMES: Theme[] = [
  { id: 0, name: 'Classic', tagline: 'World cities, Lisbon to New York', names: {} },
  {
    id: 1, name: 'Bangalore', tagline: 'Jayanagar to Koramangala',
    // Ragebait pricing: Twitter's hyped tech-corridor areas sit on the expensive slots, old Bangalore on the cheap ones.
    names: {
      1: 'Jayanagar', 2: 'Basavanagudi', 3: 'Namma Metro', 4: 'Malleshwaram', 5: 'Frazer Town', 6: 'Sadashivanagar',
      8: 'Richmond Town', 9: 'Lavelle Road', 10: 'Airport', 11: 'Cunningham Road', 12: 'MG Road', 13: 'Peenya',
      15: 'Hebbal', 16: 'BTM Layout', 17: 'BMTC Bus', 18: 'E-City', 19: 'Sarjapur Road', 20: 'Marathahalli',
      22: 'Whitefield', 23: 'Bellandur', 24: 'BESCOM', 25: 'HSR Layout', 26: 'Indiranagar', 27: 'Koramangala',
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
