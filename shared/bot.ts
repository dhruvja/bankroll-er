import { board } from './board';
import { NO_OFFER, canBuild, currentSeat, isActive, saleValue, tradeOffers, tradeable, type TableView } from './chain';

export type BotMove =
  | { kind: 'roll' | 'buy' | 'pass' | 'bail' }
  | { kind: 'build' | 'sell' | 'trade-offer'; space: number }
  | { kind: 'trade-accept'; seat: number; space: number };

/** Cash the bot keeps back for rent when it buys; it builds only while it would keep twice this. */
export const BOT_RESERVE = 150;

const price = (space: number) => board.spaces[space].price ?? 0;
/** Whether `seat` would hold a whole city group after swapping `give` away for `gain`. */
const completesGroup = (view: TableView, seat: number, gain: number, give: number) => {
  const group = board.spaces[gain].kind === 'city' ? board.spaces[gain].group : undefined;
  return Boolean(group) && board.groups[group!].every(member => member === gain || (member !== give && view.board[member].owner === seat));
};
/** A swap the bot likes: it completes a group, or it gains at least as much property value as it gives. */
const goodSwap = (view: TableView, seat: number, gain: number, give: number) => completesGroup(view, seat, gain, give) || price(gain) >= price(give);

/** The next move for the bot at `seat`, or undefined to wait. A plain, beatable strategy: buy what it
 * can afford and still keep a reserve, build on complete groups, pay bail only when rich, sell its
 * cheapest property when in debt, never put a property up at Auction, and swap only for value. */
export function botMove(view: TableView, seat: number, now: number): BotMove | undefined {
  if (view.phase !== 'playing' || !isActive(view, seat)) return undefined;
  const me = view.seats[seat], myTurn = currentSeat(view) === seat;
  const owned = view.board.flatMap((lot, space) => lot.owner === seat ? [space] : []);
  const sellCheapest = (): BotMove | undefined => {
    const space = [...owned].sort((a, b) => saleValue(view, a) - saleValue(view, b))[0];
    return space === undefined ? undefined : { kind: 'sell', space };
  };
  switch (view.stage) {
    case 'preroll': {
      if (!myTurn) return undefined;
      if (me.cash < 0) return sellCheapest() ?? { kind: 'roll' };
      if (me.jailTurns > 0) return { kind: me.cash >= board.rules.bail + 2 * BOT_RESERVE ? 'bail' : 'roll' };
      const build = owned.filter(space => canBuild(view, seat, space) && me.cash - (board.spaces[space].buildingCost ?? 0) >= 2 * BOT_RESERVE)
        .sort((a, b) => view.board[a].buildings - view.board[b].buildings || (board.spaces[a].buildingCost ?? 0) - (board.spaces[b].buildingCost ?? 0))[0];
      return build === undefined ? { kind: 'roll' } : { kind: 'build', space: build };
    }
    case 'buydecision':
      if (!myTurn) return undefined;
      return { kind: me.cash - price(me.position) >= BOT_RESERVE ? 'buy' : 'pass' };
    case 'tradeopen':
      return myTurn ? { kind: 'pass' } : undefined;
    case 'tradeoffers': {
      const give = view.trade.space;
      if (myTurn) {
        const best = tradeOffers(view).filter(offer => goodSwap(view, seat, offer.space, give))
          .sort((a, b) => Number(completesGroup(view, seat, b.space, give)) - Number(completesGroup(view, seat, a.space, give)) || price(b.space) - price(a.space))[0];
        if (best) return { kind: 'trade-accept', seat: best.seat, space: best.space };
        return now >= view.trade.deadline ? { kind: 'pass' } : undefined;
      }
      if (now >= view.trade.deadline || (view.trade.offers[seat] ?? NO_OFFER) !== NO_OFFER) return undefined;
      // Never offers a property out of a group it already holds whole.
      const keeps = (space: number) => board.spaces[space].kind === 'city' && completesGroup(view, seat, space, NO_OFFER);
      const offer = owned.filter(space => tradeable(view, seat, space) && !keeps(space) && goodSwap(view, seat, give, space)).sort((a, b) => price(a) - price(b))[0];
      return offer === undefined ? undefined : { kind: 'trade-offer', space: offer };
    }
    default:
      return undefined;
  }
}
