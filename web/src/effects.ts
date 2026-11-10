/** Money effects drawn over the page: gold coins that fly between the board and the players, and
 * "+$200" / "−$36" amounts that float up from a player's tile. Plain DOM nodes animated with the Web
 * Animations API and removed when done, so they never touch React state. Skipped when the browser
 * asks for reduced motion; the announcement still says what happened. */
import { money } from './Board';

const COIN_MS = 650, COIN_GAP_MS = 70;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The first match that is on screen: a seat shows as a tile on phones and a row on desktop. */
function visible(selector: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(selector)].find(element => element.getClientRects().length > 0);
}
const centre = (element: HTMLElement) => { const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };

export const seatElement = (seat: number) => visible(`[data-testid="seat-chip-${seat}"], [data-testid="player-${seat}"]`);
export const spaceElement = (space: number) => visible(`[data-testid="space-${space}"]`);

/** Coins in an arc from one element to another; resolves when the last one lands. */
export function flyCoins(from: HTMLElement | undefined, to: HTMLElement | undefined, count = 5): Promise<void> {
  if (!from || !to || reduced()) return Promise.resolve();
  const start = centre(from), end = centre(to), dx = end.x - start.x, dy = end.y - start.y;
  const lift = Math.min(90, 30 + Math.hypot(dx, dy) / 5);
  const landings = Array.from({ length: count }, (_, i) => {
    const coin = document.createElement('span');
    coin.className = 'coin';
    coin.textContent = '$';
    coin.style.left = `${start.x}px`;
    coin.style.top = `${start.y}px`;
    document.body.append(coin);
    const jitter = (i - (count - 1) / 2) * 6;
    const flight = coin.animate([
      { transform: 'translate(-50%, -50%) scale(.6)', opacity: 0 },
      { transform: `translate(calc(-50% + ${dx / 2 + jitter}px), calc(-50% + ${dy / 2 - lift}px)) scale(1.15)`, opacity: 1, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.8)`, opacity: 0.9 },
    ], { duration: COIN_MS, delay: i * COIN_GAP_MS, easing: 'ease-in-out', fill: 'both' });
    return flight.finished.catch(() => undefined).finally(() => coin.remove());
  });
  return Promise.all(landings).then(() => undefined);
}

/** "+$200" in green or "−$36" in red, floating up off an element. */
export function floatAmount(target: HTMLElement | undefined, amount: number) {
  if (!target || !amount || reduced()) return;
  // Starts mid-tile so it stays on screen when the tiles sit at the top of a phone.
  const { x, y } = centre(target), top = y - 12;
  const label = document.createElement('span');
  label.className = `cash-float ${amount > 0 ? 'up' : 'down'}`;
  label.textContent = `${amount > 0 ? '+' : ''}${money(amount)}`;
  label.style.left = `${x}px`;
  label.style.top = `${top}px`;
  document.body.append(label);
  label.animate([
    { transform: 'translate(-50%, 0) scale(.8)', opacity: 0 },
    { transform: 'translate(-50%, -14px) scale(1.1)', opacity: 1, offset: 0.2 },
    { transform: 'translate(-50%, -40px) scale(1)', opacity: 0 },
  ], { duration: 1400, easing: 'ease-out', fill: 'both' }).finished.catch(() => undefined).finally(() => label.remove());
}

/** Money moving between two places: coins fly, then the amount floats off each player who gained or paid. */
export function moveMoney(from: HTMLElement | undefined, to: HTMLElement | undefined, changes: { seat: number; amount: number }[], coins = 5) {
  void flyCoins(from, to, coins).then(() => { for (const change of changes) floatAmount(seatElement(change.seat), change.amount); });
}
