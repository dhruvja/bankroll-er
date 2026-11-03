import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { board, isProperty } from '../../shared/board';
import { NO_OWNER, rent, type TableView } from '../../shared/chain';

export const SEAT_COLORS = ['#FF7A59', '#B794F6', '#FFD166', '#6EE7F0'];
export const GROUP_COLORS: Record<string, string> = {
  Brown: '#B07A4F', Sky: '#69C3F0', Pink: '#F28AB2', Orange: '#F59A3B', Green: '#3BAA72', Gold: '#E8C547', Public: '#8FA3BD',
};
export const money = (value: number) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US')}`;

/** Grid cell (row, column) of each space on the 7×7 ring: Start bottom right, then clockwise
 * along the bottom, up the left, across the top and down the right. Corners are Start, Jail,
 * Auction and the last Lucky space. */
export function ringCell(index: number): [number, number] {
  if (index <= 6) return [7, 7 - index];
  if (index <= 12) return [7 - (index - 6), 1];
  if (index <= 18) return [1, 1 + (index - 12)];
  return [1 + (index - 18), 7];
}

const SHORT: Record<string, string> = { 'Lucky Card': 'Lucky', 'Power Plant': 'Power', 'New York': 'New York' };

export type Highlight = 'give' | 'offer';

/** The 24-space ring. Tokens are drawn over the grid so a move animates cell by cell. */
export function Board({ view, positions, highlights, selected, onSelect, children }: {
  view: TableView; positions: number[]; highlights: Map<number, { kind: Highlight; seat: number }>; selected?: number;
  onSelect: (space: number) => void; children: ReactNode;
}) {
  const live = view.phase !== 'lobby';
  return (
    <div className="ring-wrap"><div className="ring" data-testid="board">
      {board.spaces.map(space => {
        const [row, column] = ringCell(space.index), lot = view.board[space.index], owned = live && lot.owner !== NO_OWNER;
        const mark = highlights.get(space.index);
        const style = { gridRow: row, gridColumn: column, '--group': space.group ? GROUP_COLORS[space.group] : 'transparent',
          '--owner': owned ? SEAT_COLORS[lot.owner] : 'transparent', '--mark': mark ? SEAT_COLORS[mark.seat] : 'transparent' } as CSSProperties;
        const name = SHORT[space.name] ?? space.name;
        return (
          <button key={space.index} type="button" style={style} data-testid={`space-${space.index}`} data-owner={owned ? lot.owner : ''}
            className={`cell ${space.kind}${owned ? ' owned' : ''}${mark ? ` mark-${mark.kind}` : ''}${selected === space.index ? ' selected' : ''}`}
            onClick={() => onSelect(space.index)} aria-label={`${space.name}${owned ? `, owned by ${view.seats[lot.owner]?.name}` : ''}`}>
            {isProperty(space) && <span className="band" />}
            <span className="cell-name">{name}</span>
            {isProperty(space) && <span className="cell-price">{owned ? money(rent(view, space.index)) : money(space.price ?? 0)}</span>}
            {lot.buildings > 0 && live && <span className="pips" aria-label={`${lot.buildings} buildings`}>{Array.from({ length: lot.buildings }, (_, i) => <i key={i} />)}</span>}
            {space.kind === 'start' && <span className="cell-note">+{money(board.rules.salary)}</span>}
          </button>
        );
      })}
      {live && view.seats.map((seat, index) => {
        if (seat.eliminatedAt) return null;
        const [row, column] = ringCell(positions[index] ?? seat.position);
        const stack = view.seats.filter((other, at) => !other.eliminatedAt && (positions[at] ?? other.position) === (positions[index] ?? seat.position)).indexOf(seat);
        const style = { '--row': row - 1, '--col': column - 1, '--stack': stack, background: SEAT_COLORS[index] } as CSSProperties;
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
      const timer = setInterval(() => setFace(1 + Math.floor(Math.random() * 6)), 90);
      return () => clearInterval(timer);
    }
    const wait = Math.max(0, startedAt.current + 700 - Date.now());
    startedAt.current = 0;
    settleAt.current = Date.now() + wait;
    const timer = setTimeout(() => { setTumbling(false); if (view?.lastRoll) setFace(view.lastRoll); }, wait);
    return () => clearTimeout(timer);
  }, [rolling, view?.lastRoll, view?.vrfNonce]);
  return { face, tumbling, settleAt };
}

/** Displayed token positions: a roll or a short card move walks space by space once the die has
 * settled; anything longer (jail, move back) jumps. */
export function useTokenPositions(view: TableView | undefined, settleAt: { current: number }) {
  const goal = useRef<number[]>([]);
  goal.current = view?.seats.map(seat => seat.position) ?? [];
  const [shown, setShown] = useState<number[]>(goal.current);
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() < settleAt.current) return;
      setShown(previous => {
        const next = goal.current.map((target, seat) => {
          const at = previous[seat] ?? target;
          if (at === target) return at;
          const ahead = (target - at + 24) % 24;
          return ahead <= 9 ? (at + 1) % 24 : target;
        });
        return next.length === previous.length && next.every((value, seat) => value === previous[seat]) ? previous : next;
      });
    }, 170);
    return () => clearInterval(timer);
  }, [settleAt]);
  return shown;
}
