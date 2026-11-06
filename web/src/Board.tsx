import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { board, isProperty } from '../../shared/board';
import { spacesFor } from '../../shared/themes';
import { NO_OWNER, rent, type TableView } from '../../shared/chain';
import { sounds } from './sound';

/** Bauhaus palette: seats are red, blue, yellow and black; each takes the ink in SEAT_INK on top. */
export const SEAT_COLORS = ['#E03C28', '#1D4ED8', '#FFC21A', '#111111'];
export const SEAT_INK = ['#FFFFFF', '#FFFFFF', '#111111', '#FFFFFF'];
/** Each color group also has its own shape, so groups differ by more than hue. */
export const GROUP_COLORS: Record<string, string> = {
  Brown: '#8B5A2B', Sky: '#1D4ED8', Pink: '#E86AA6', Orange: '#F07C1A', Teal: '#14A3A3', Green: '#1F8A4C', Purple: '#6B3FA0', Gold: '#FFC21A', Public: '#111111',
};
export const GROUP_INK: Record<string, string> = {
  Brown: '#FFFFFF', Sky: '#FFFFFF', Pink: '#111111', Orange: '#111111', Teal: '#111111', Green: '#FFFFFF', Purple: '#FFFFFF', Gold: '#111111', Public: '#FFFFFF',
};
const GROUP_SHAPES: Record<string, string> = {
  Brown: 'square', Sky: 'circle', Pink: 'half', Orange: 'triangle', Teal: 'diamond', Green: 'quarter', Purple: 'ring', Gold: 'circle', Public: 'stripes',
};
export const money = (value: number) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US')}`;

/** Grid cell (row, column) of each space on the 8×8 ring: Start bottom right, then clockwise
 * along the bottom, up the left, across the top and down the right. The corners are Start, Jail,
 * Auction and Lucky. */
export function ringCell(index: number): [number, number] {
  if (index <= 7) return [8, 8 - index];
  if (index <= 14) return [8 - (index - 7), 1];
  if (index <= 21) return [1, 1 + (index - 14)];
  return [1 + (index - 21), 8];
}

/** Spaces whose label sits low, so a token parks higher on them. */
const LOW_LABEL = new Set(['start', 'jail', 'auction', 'lucky']);

/** Cell labels: short forms, and soft hyphens (\u00AD) so long area names wrap as KORA-MANGALA, never mid-letter. */
const SPACES = board.spaces.length;
const SHORT: Record<string, string> = {
  'Lucky Card': 'Lucky', 'Power Plant': 'Power', 'New York': 'New York',
  Malleshwaram: 'Malle\u00ADshwaram', Koramangala: 'Kora\u00ADmangala', Indiranagar: 'Indira\u00ADnagar', Jayanagar: 'Jaya\u00ADnagar', Basavanagudi: 'Basava\u00ADnagudi', 'Sarjapur Road': 'Sarjapur Road',
  Yelahanka: 'Yela\u00ADhanka', Bellandur: 'Bellan\u00ADdur', Whitefield: 'White\u00ADfield', Ghatkopar: 'Ghat\u00ADkopar', Borivali: 'Bori\u00ADvali',
  Marathahalli: 'Maratha\u00ADhalli', Sadashivanagar: 'Sadashiva\u00ADnagar', 'Cunningham Road': 'Cunning\u00ADham Road', Goregaon: 'Gore\u00ADgaon',
  'Frazer Town': 'Frazer Town', 'Richmond Town': 'Rich\u00ADmond Town', 'Lower Parel': 'Lower Parel', 'Lavelle Road': 'Lavelle Road',
};

export type Highlight = 'give' | 'offer';

/** The 28-space ring. Tokens are drawn over the grid so a move animates cell by cell. */
export function Board({ view, positions, highlights, selected, onSelect, children }: {
  view: TableView; positions: number[]; highlights: Map<number, { kind: Highlight; seat: number }>; selected?: number;
  onSelect: (space: number) => void; children: ReactNode;
}) {
  const live = view.phase !== 'lobby', spaces = spacesFor(view.theme);
  return (
    <div className="ring-wrap"><div className="ring" data-testid="board">
      {spaces.map(space => {
        const [row, column] = ringCell(space.index), lot = view.board[space.index], owned = live && lot.owner !== NO_OWNER;
        const mark = highlights.get(space.index);
        const style = { gridRow: row, gridColumn: column, '--group': space.group ? GROUP_COLORS[space.group] : 'transparent',
          '--group-ink': space.group ? GROUP_INK[space.group] : 'inherit', '--owner': owned ? SEAT_COLORS[lot.owner] : 'transparent',
          '--owner-ink': owned ? SEAT_INK[lot.owner] : 'inherit', '--mark': mark ? SEAT_COLORS[mark.seat] : 'transparent' } as CSSProperties;
        const name = SHORT[space.name] ?? space.name;
        return (
          <button key={space.index} type="button" style={style} data-testid={`space-${space.index}`} data-owner={owned ? lot.owner : ''}
            className={`cell ${space.kind}${owned ? ' owned' : ''}${live && lot.buildings > 0 ? ' built' : ''}${mark ? ` mark-${mark.kind}` : ''}${selected === space.index ? ' selected' : ''}`}
            onClick={() => onSelect(space.index)} aria-label={`${space.name}${owned ? `, owned by ${view.seats[lot.owner]?.name}` : ''}`}>
            {isProperty(space) && <span className="cell-price" title={owned ? 'Rent' : 'Price'}>{owned ? money(rent(view, space.index)) : money(space.price ?? 0)}</span>}
            {isProperty(space) && <span className={`shape ${GROUP_SHAPES[space.group ?? 'Public']}`} aria-hidden="true" />}
            <span className="cell-name">{name}</span>
            {lot.buildings > 0 && live && (lot.buildings === board.rules.maxBuildingsPerCity
              ? <span className="pips" aria-label="Hotel"><i className="hotel" /></span>
              : <span className="pips" aria-label={`${lot.buildings} house${lot.buildings > 1 ? 's' : ''}`}>{Array.from({ length: lot.buildings }, (_, i) => <i key={i} />)}</span>)}
            {space.kind === 'start' && <span className="cell-note">+{money(board.rules.salary)}</span>}
          </button>
        );
      })}
      {live && view.seats.map((seat, index) => {
        if (seat.eliminatedAt) return null;
        const at = positions[index] ?? seat.position, [row, column] = ringCell(at);
        const stack = view.seats.filter((other, at) => !other.eliminatedAt && (positions[at] ?? other.position) === (positions[index] ?? seat.position)).indexOf(seat);
        const corner = LOW_LABEL.has(spaces[at].kind) ? 1 : 0;
        const style = { '--row': row - 1, '--col': column - 1, '--stack': stack, '--corner': corner, background: SEAT_COLORS[index], color: SEAT_INK[index] } as CSSProperties;
        return <span key={seat.wallet} className="token" style={style} data-testid={`token-${index}`} title={seat.name}>{seat.name.slice(0, 1).toUpperCase()}</span>;
      })}
      <div className="rosette">{children}</div>
    </div></div>
  );
}

const PIPS: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
export function Die({ face, tumbling }: { face: number; tumbling: boolean }) {
  return (
    <div className={`die${tumbling ? ' tumbling' : ''}`} data-testid="die" data-face={tumbling ? '' : face} aria-label={tumbling ? 'Rolling' : face ? `Rolled ${face}` : 'Die'}>
      {Array.from({ length: 9 }, (_, i) => <i key={i} className={(PIPS[face] ?? []).includes(i) ? 'on' : ''} />)}
    </div>
  );
}

/** The die keeps tumbling for at least 700 ms after a roll is requested, so the VRF round trip
 * (about 160–240 ms) reads as a throw rather than a flicker. Returns the face to show and the time
 * the die settles, which holds token movement until the number is visible. */
export function useDie(view: TableView | undefined, requested: boolean) {
  const rolling = view?.phase === 'playing' && (view.stage === 'rolling' || requested);
  const startedAt = useRef(0), settleAt = useRef(0);
  const [face, setFace] = useState(view?.lastRoll || 1), [tumbling, setTumbling] = useState(false);
  useEffect(() => {
    if (rolling) {
      if (!startedAt.current) startedAt.current = Date.now();
      settleAt.current = Number.MAX_SAFE_INTEGER;
      setTumbling(true);
      const timer = setInterval(() => { setFace(1 + Math.floor(Math.random() * 6)); sounds.clack(); }, 90);
      return () => clearInterval(timer);
    }
    const wait = Math.max(0, startedAt.current + 700 - Date.now()), thrown = startedAt.current > 0;
    startedAt.current = 0;
    settleAt.current = Date.now() + wait;
    // The rattle keeps going for as long as the die still tumbles on screen.
    const rattle = thrown ? setInterval(() => sounds.clack(), 90) : undefined;
    const timer = setTimeout(() => { clearInterval(rattle); setTumbling(false); if (view?.lastRoll) setFace(view.lastRoll); if (thrown) sounds.settle(); }, wait);
    return () => { clearTimeout(timer); clearInterval(rattle); };
  }, [rolling, view?.lastRoll, view?.vrfNonce]);
  return { face, tumbling, settleAt };
}

/** Displayed token positions: a roll or a short card move walks space by space once the die has
 * settled; anything longer (jail, move back) jumps. */
export function useTokenPositions(view: TableView | undefined, settleAt: { current: number }) {
  const goal = useRef<number[]>([]);
  goal.current = view?.seats.map(seat => seat.position) ?? [];
  const [shown, setShown] = useState<number[]>(goal.current), current = useRef(shown);
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() < settleAt.current) return;
      const previous = current.current;
      let stepLeft = -1, landed = false;
      const next = goal.current.map((target, seat) => {
        const at = previous[seat] ?? target;
        if (at === target) return at;
        const ahead = (target - at + SPACES) % SPACES, to = ahead <= 9 ? (at + 1) % SPACES : target;
        if (to === target) landed = true; else stepLeft = Math.max(stepLeft, ahead - 1);
        return to;
      });
      if (next.length === previous.length && next.every((value, seat) => value === previous[seat])) return;
      // Sounds only for a walk or jump seen on screen, never for the first snapshot.
      if (previous.length === next.length) { if (landed) sounds.land(); else if (stepLeft >= 0) sounds.step(stepLeft); }
      current.current = next;
      setShown(next);
    }, 170);
    return () => clearInterval(timer);
  }, [settleAt]);
  return shown;
}
