import { useEffect } from 'react';
import { board } from '../../shared/board';
import { money } from './Board';

const rules = board.rules, targets = rules.defaultTargetByPlayers;

/** The basic rules, built from the same board.json the program is generated from. */
export function Rules({ demo }: { demo: boolean }) {
  return (
    <div className="rules">
      <h3>Win</h3>
      <p>Be first to the target net worth: {money(targets['2'])} with 2 players, {money(targets['3'])} with 3, {money(targets['4'])} with 4.
        Net worth is your cash plus the price of everything you own, buildings included. Or be the last player left.</p>
      <h3>Your turn</h3>
      <ul>
        <li>Roll the die and move. A 6 rolls again, up to {rules.maxRollsPerTurn} times a turn. Passing Start pays {money(rules.salary)}.</li>
        <li>You get {rules.deadlinesSec.preRoll} seconds to roll. Time out {rules.strikesToForfeit} times and you are out.</li>
        <li>Everyone starts with {money(rules.startCash)}, or {rules.startCashOptions.filter(value => value !== rules.startCash).map(money).join(' or ')} if the host picks it; the target then moves by the same amount. Later turns in the order start with a little more.</li>
      </ul>
      <h3>Properties</h3>
      <ul>
        <li>Land on an unowned property to buy it or pass ({rules.deadlinesSec.buyDecision} seconds).</li>
        <li>Land on someone else’s and you pay them rent. Rent doubles once they own the whole color group.</li>
        <li>Houses: own every area of one color, then on your turn before you roll, tap an area and build. Up to 4 houses, then a hotel; rent climbs with each.</li>
        <li>The metro, airport, bus and power company take no houses. Their rent grows with how many of the four the owner has.</li>
        <li>On your turn you can sell a property for {rules.saleBps / 100}% of its price and buildings.</li>
      </ul>
      <h3>Special spaces</h3>
      <ul>
        <li><b>Lucky:</b> draw a card. Collect or pay money, move, go to jail, or pay $25 per building.</li>
        <li><b>Jail:</b> land here and you sit out {rules.jailTurns} turns, or pay {money(rules.bail)} bail on your turn.</li>
        <li><b>Auction:</b> offer one of your properties without buildings for a swap. Others offer one back; if you take one, you both get {money(rules.tradeBonus)}.</li>
      </ul>
      <h3>Out of the game</h3>
      <ul>
        <li>You go bankrupt at a net worth of $0 or below, or cash under {money(rules.bankruptCashBelow)}.</li>
        <li>You can also forfeit any time during play.</li>
        <li>Either way, everything you own goes back on sale, buildings removed.</li>
      </ul>
      {!demo && <p className="quiet">USDC tables pay the pot out by final rank; players who are out rank below everyone still playing.</p>}
    </div>
  );
}

/** Full-screen rules page, opened from the table. */
export function RulesSheet({ demo, onClose }: { demo: boolean; onClose: () => void }) {
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; addEventListener('keydown', close); return () => removeEventListener('keydown', close); }, [onClose]);
  return (
    <section className="invite-sheet rules-sheet" role="dialog" aria-modal="true" aria-labelledby="rules-title" data-testid="rules-sheet">
      <header><h2 id="rules-title">How to play</h2><button className="close" onClick={onClose} aria-label="Close rules">×</button></header>
      <Rules demo={demo} />
    </section>
  );
}
