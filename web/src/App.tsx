import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Keypair } from '@solana/web3.js';
import { board, defaultTarget, isProperty } from '../../shared/board';
import { ENTRIES, PROTOCOL_FEE_BPS, RELAY_FEE, TOKEN_SCALE, WITHDRAW_MINIMUM } from '../../shared/config';
import { NO_OFFER, NO_OWNER, canBuild, currentSeat, expectedPayouts, isActive, netWorth, rent, saleValue, tradeOffers, tradeable, type TableView } from '../../shared/chain';
import { acceptTrade, act, deposit, getWalletInfo, joinTable, openTable, property, runCrank, subscribeTable, trade, wallet, withdraw, type WalletInfo } from './lib/game';
import { exportWallet } from './lib/wallet';

const usdc = (atoms: number) => (atoms / TOKEN_SCALE).toFixed(2);
const money = (value: number) => `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString()}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const SEAT_COLORS = ['#e4572e', '#29335c', '#f3a712', '#669bbc'];

function navigate(path: string) { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const update = () => setPath(location.pathname); addEventListener('popstate', update); return () => removeEventListener('popstate', update); }, []);
  return path;
}
function useNow() {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 500); return () => clearInterval(timer); }, []);
  return now;
}
function useBusy() {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const run = useCallback(async (task: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await task(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }, []);
  return { busy, error, run };
}

export default function App() {
  const path = usePath(), match = /^\/play\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(\d+)$/.exec(path);
  const [info, setInfo] = useState<WalletInfo>(), [signer, setSigner] = useState<Keypair>();
  const refresh = useCallback(() => { void getWalletInfo().then(setInfo, error => setInfo({ address: '', play: null, base: null, sol: null, pending: false, status: message(error) })); }, []);
  useEffect(() => { void wallet().then(setSigner); refresh(); const timer = setInterval(refresh, 15_000); return () => clearInterval(timer); }, [refresh]);
  return (
    <main>
      <header><h1 onClick={() => navigate('/')}>Bankroll</h1><span>devnet · 1d6 · ranked USDC pot</span></header>
      <WalletPanel info={info} signer={signer} refresh={refresh} />
      {match && signer ? <TableScreen table={match[1]} nonce={Number(match[2])} me={signer.publicKey.toBase58()} signer={signer} refresh={refresh} />
        : <OpenTableForm refresh={refresh} />}
    </main>
  );
}

function WalletPanel({ info, signer, refresh }: { info?: WalletInfo; signer?: Keypair; refresh: () => void }) {
  const { busy, error, run } = useBusy(), [amount, setAmount] = useState('');
  return (
    <section className="panel">
      <h2>Wallet</h2>
      <p className="mono">{info?.address || 'Opening wallet…'}</p>
      <p>Play balance <b>{info?.play?.toFixed(2) ?? '—'}</b> USDC · On Solana <b>{info?.base?.toFixed(2) ?? '—'}</b> USDC · SOL {info?.sol ?? '—'}</p>
      <p className="hint">Send devnet USDC to the address above, then move it into play. Deposits and withdrawals are sponsored: no SOL needed,
        {` ${usdc(RELAY_FEE)}`} USDC fee each way, minimum {usdc(WITHDRAW_MINIMUM)} USDC. Payouts below the minimum stay in play for your next entry.</p>
      <div className="row">
        <button disabled={busy || !info?.base} onClick={() => void run(async () => { await deposit(); refresh(); })}>Deposit all</button>
        <input placeholder="USDC" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" />
        <button disabled={busy || !amount} onClick={() => void run(async () => { await withdraw(Number(amount)); setAmount(''); refresh(); })}>Withdraw</button>
        <button disabled={!signer} onClick={() => signer && exportWallet(signer)}>Export recovery file</button>
        <button onClick={refresh}>Refresh</button>
      </div>
      {(error || info?.status) && <p className="error">{error ?? info?.status}</p>}
    </section>
  );
}

function OpenTableForm({ refresh }: { refresh: () => void }) {
  const { busy, error, run } = useBusy();
  const [name, setName] = useState(''), [entry, setEntry] = useState<number>(ENTRIES[0]), [players, setPlayers] = useState(2), [target, setTarget] = useState(defaultTarget(2));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => { const opened = await openTable({ name, entry, maxPlayers: players, target }); refresh(); navigate(`/play/${opened.table}/${opened.nonce}`); });
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Open a table</h2>
      <label>Your name <input required maxLength={16} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Entry <select value={entry} onChange={event => setEntry(Number(event.target.value))}>{ENTRIES.map(value => <option key={value} value={value}>{usdc(value)} USDC</option>)}</select></label>
      <label>Players <select value={players} onChange={event => { const count = Number(event.target.value); setPlayers(count); setTarget(defaultTarget(count)); }}>
        {[2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
      <label>Target net worth <select value={target} onChange={event => setTarget(Number(event.target.value))}>
        {board.rules.targets.map(value => <option key={value} value={value}>{money(value)}</option>)}</select></label>
      <p className="hint">Opening pays your entry now. The pot pays out by rank with a {PROTOCOL_FEE_BPS / 100}% fee; a lobby that never starts refunds in full.</p>
      <button disabled={busy}>{busy ? 'Opening…' : 'Open table'}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function TableScreen({ table, nonce, me, signer, refresh }: { table: string; nonce: number; me: string; signer: Keypair; refresh: () => void }) {
  const [view, setView] = useState<TableView>(), [readError, setReadError] = useState<string>();
  const { busy, error, run } = useBusy(), now = useNow(), [name, setName] = useState('');
  useEffect(() => subscribeTable(table, next => { setView(next); setReadError(undefined); }, failure => setReadError(failure.message)), [table]);
  const seat = view ? view.seats.findIndex(item => item.wallet === me) : -1, current = view && nonce === view.gameNonce;
  const card = useDrawnCard(view);
  useEffect(() => (current && seat >= 0 ? runCrank(table, signer) : undefined), [table, signer, current, seat]);
  useEffect(() => { if (view?.phase === 'free') refresh(); }, [view?.phase, refresh]);
  if (!view) return <section className="panel">{readError ?? 'Loading table…'}</section>;
  if (!current) return <section className="panel">This invite is for an earlier game at table {view.index}. <button onClick={() => navigate('/')}>Back</button></section>;
  const action = (name: Parameters<typeof act>[1]) => () => void run(() => act(table, name));
  const turnSeat = currentSeat(view), myTurn = view.phase === 'playing' && seat === turnSeat;
  const left = Math.max(0, Math.ceil((view.phase === 'lobby' ? view.lobbyDeadline : view.stageDeadline) - now));
  const invite = `${location.origin}/play/${table}/${nonce}`;
  return (
    <section className="panel">
      <h2>Table {view.index} · game {view.gameNonce} · {view.phase}{view.phase === 'playing' ? ` · round ${view.round}` : ''}</h2>
      <p>Entry {usdc(view.entry)} USDC · pot {usdc(view.entry * view.playerCount)} USDC · target {money(view.target)} · {view.playerCount}/{view.maxPlayers} players</p>
      <Players view={view} me={me} />
      {view.phase === 'lobby' && (
        <div>
          <p>Invite link: <a className="mono" href={invite}>{invite}</a> <button onClick={() => void navigator.clipboard.writeText(invite)}>Copy</button></p>
          <p>Lobby closes in {left}s.</p>
          {seat < 0 && view.playerCount < view.maxPlayers && (
            <div className="row"><input placeholder="Your name" maxLength={16} value={name} onChange={event => setName(event.target.value)} />
              <button disabled={busy || !name.trim()} onClick={() => void run(async () => { await joinTable(table, nonce, name, view.entry); refresh(); })}>Join and pay {usdc(view.entry)} USDC</button></div>
          )}
          {view.host === me && <div className="row">
            <button disabled={busy || view.playerCount < 2} onClick={action('start')}>Start game</button>
            <button disabled={busy} onClick={action('cancel')}>Cancel and refund</button></div>}
        </div>
      )}
      {view.phase === 'playing' && (
        <div>
          <Board view={view} />
          <p>{view.stage === 'ordering' ? 'Drawing turn order…' : view.stage === 'rolling' ? 'Rolling…'
            : view.stage === 'tradeopen' ? `${view.seats[turnSeat].name} landed on Auction and may offer a trade · ${left}s`
            : view.stage === 'tradeoffers' ? `Auction: ${view.seats[turnSeat].name} offers ${board.spaces[view.trade.space].name} · ${now < view.trade.deadline
              ? `offers close in ${Math.ceil(view.trade.deadline - now)}s` : `deciding · ${left}s`}`
            : `${view.seats[turnSeat].name} to ${view.stage === 'buydecision' ? 'decide' : view.seats[turnSeat].jailTurns ? 'bail or serve a jail turn' : 'roll'} · ${left}s`}
            {view.lastRoll ? ` · last roll ${view.lastRoll}` : ''}</p>
          {card && <p className="card">{view.seats[card.seat].name} drew a Lucky card: {board.luckyDeck[card.card - 1].text}</p>}
          {myTurn && view.stage === 'preroll' && (view.seats[seat].jailTurns > 0 ? (
            <div className="row">
              <span>In jail, {view.seats[seat].jailTurns} turn{view.seats[seat].jailTurns > 1 ? 's' : ''} left.</span>
              <button disabled={busy || view.seats[seat].cash < board.rules.bail} onClick={action('bail')}
                title={netWorth(view, seat) - board.rules.bail <= 0 ? 'Bail would leave your net worth at $0 or less: you would be bankrupt.' : undefined}>
                Pay {money(board.rules.bail)} bail{netWorth(view, seat) - board.rules.bail <= 0 ? ' (bankrupts you)' : ''}</button>
              <button disabled={busy} onClick={action('roll')}>Serve this turn</button>
            </div>
          ) : <button disabled={busy} onClick={action('roll')}>{view.rollsThisTurn ? 'Roll again (you rolled a 6)' : 'Roll'}</button>)}
          {myTurn && view.stage === 'buydecision' && (() => {
            const space = board.spaces[view.seats[seat].position];
            return <div className="row"><button disabled={busy || view.seats[seat].cash < (space.price ?? 0)} onClick={action('buy')}>Buy {space.name} for {money(space.price ?? 0)}</button>
              <button disabled={busy} onClick={action('pass')}>Pass</button></div>;
          })()}
          {(view.stage === 'tradeopen' || view.stage === 'tradeoffers') && seat >= 0 && (
            <TradeSheet view={view} seat={seat} now={now} busy={busy}
              onOpen={space => void run(() => trade(table, 'open', space))} onOffer={space => void run(() => trade(table, 'offer', space))}
              onAccept={(from, space) => void run(() => acceptTrade(table, from, space))} onPass={action('pass')} />
          )}
          {myTurn && view.seats[seat].cash < 0 && <p className="error">You are {money(view.seats[seat].cash)} in debt: you can’t buy, build or pay bail until you sell.
            Below {money(board.rules.bankruptCashBelow)}, or at a net worth of $0, you are bankrupt.</p>}
          {myTurn && (view.stage === 'preroll' || view.stage === 'buydecision') && (
            <Holdings view={view} seat={seat} canBuildNow={view.stage === 'preroll'} busy={busy}
              onBuild={space => void run(() => property(table, 'build', space))} onSell={space => void run(() => property(table, 'sell', space))} />
          )}
        </div>
      )}
      {(view.phase === 'finished' || view.phase === 'free') && <Results view={view} />}
      {view.phase === 'refunding' && <p>{view.endedAt ? 'Settlement failed, so each player collects their ranked share directly.' : 'Refunding every entry in full, with no fee.'} {view.seats.filter(item => item.refunded).length}/{view.playerCount} returned.</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The Lucky card the latest roll callback drew and who drew it. `last_card` outlives the turn
 * (a jailed roll or bail doesn't clear it), so the card is tied to the roll that produced it and
 * hidden once the next roll is requested. */
function useDrawnCard(view?: TableView) {
  const previous = useRef<TableView>(undefined), [card, setCard] = useState<{ seat: number; card: number }>();
  useEffect(() => {
    const before = previous.current;
    previous.current = view;
    if (!view || view.phase !== 'playing') { setCard(undefined); return; }
    if (view.stage === 'rolling') setCard(undefined);
    else if (before?.stage === 'rolling' && view.vrfNonce === before.vrfNonce) setCard(view.lastCard ? { seat: currentSeat(before), card: view.lastCard } : undefined);
  }, [view]);
  return card;
}

const spaceLabel = (index: number) => {
  const space = board.spaces[index];
  return `${space.name} (${space.group ?? space.kind}, ${money(space.price ?? 0)})`;
};

/** Whether `seat` would hold a whole city group after swapping `give` (NO_OFFER for none yet) for `gain`. */
function completesGroup(view: TableView, seat: number, gain: number, give: number) {
  const space = board.spaces[gain];
  return space.kind === 'city' && Boolean(space.group)
    && board.groups[space.group!].every(member => member === gain || (member !== give && view.board[member].owner === seat));
}

/** The Auction trade. The lander picks one unbuilt property to offer, or skips; every other active
 * seat may offer one of its own unbuilt properties back (and replace it) until offers close; the
 * lander accepts one offer or cancels. A completed swap pays both sides the trade bonus. */
function TradeSheet({ view, seat, now, busy, onOpen, onOffer, onAccept, onPass }: {
  view: TableView; seat: number; now: number; busy: boolean;
  onOpen: (space: number) => void; onOffer: (space: number) => void; onAccept: (seat: number, space: number) => void; onPass: () => void;
}) {
  const lander = currentSeat(view), mine = board.spaces.filter(space => tradeable(view, seat, space.index)), bonus = money(board.rules.tradeBonus);
  const offersLeft = Math.max(0, Math.ceil(view.trade.deadline - now)), decideLeft = Math.max(0, Math.ceil(view.stageDeadline - now));
  if (view.stage === 'tradeopen') {
    if (seat !== lander) return <p className="hint">{view.seats[lander].name} is choosing a property to put up for trade.</p>;
    return (
      <div className="trade">
        <h3>Auction: offer a property for a swap</h3>
        <p className="hint">Pick one of your properties without buildings. The others can each offer one of theirs back, and you choose which offer to
          take. A completed swap pays both of you {bonus}. Skipping does nothing; letting the timer run out costs a strike.</p>
        <div className="offers">{mine.map(space => (
          <button key={space.index} className="offer" disabled={busy} onClick={() => onOpen(space.index)}>
            <b>{space.name}</b><small>{space.group ?? space.kind} · {money(space.price ?? 0)}</small></button>))}</div>
        <button disabled={busy} onClick={onPass}>Skip the trade</button>
      </div>
    );
  }
  const offers = tradeOffers(view), give = view.trade.space, offering = view.trade.offers[seat] ?? NO_OFFER;
  if (seat === lander) return (
    <div className="trade">
      <h3>You offered {spaceLabel(give)}</h3>
      <p className="hint">{offersLeft ? `Offers close in ${offersLeft}s.` : 'Offers are closed.'} {offers.length ? `Decide within ${decideLeft}s or the trade is cancelled with a strike.` : 'If nobody offers, the trade is cancelled with no strike.'}</p>
      <div className="offers">{offers.map(offer => (
        <div key={offer.seat} className="offer">
          <span><span className="dot" style={{ background: SEAT_COLORS[offer.seat] }} />{view.seats[offer.seat].name} offers</span>
          <b>{board.spaces[offer.space].name}</b><small>{board.spaces[offer.space].group ?? board.spaces[offer.space].kind} · {money(board.spaces[offer.space].price ?? 0)}</small>
          {completesGroup(view, seat, offer.space, give) && <small className="buildings">Completes your {board.spaces[offer.space].group} group</small>}
          <button disabled={busy} onClick={() => onAccept(offer.seat, offer.space)}>Swap for it (+{bonus} each)</button>
        </div>))}
        {!offers.length && <p className="hint">Waiting for offers…</p>}</div>
      <button disabled={busy} onClick={onPass}>Cancel the trade</button>
    </div>
  );
  if (!isActive(view, seat)) return null;
  return (
    <div className="trade">
      <h3>{view.seats[lander].name} offers {spaceLabel(give)}</h3>
      {completesGroup(view, seat, give, offering) && <p className="buildings">It would complete your {board.spaces[give].group} group.</p>}
      {offersLeft ? <>
        <p className="hint">Offer one of your properties without buildings in return; you can change it until offers close in {offersLeft}s.
          If {view.seats[lander].name} picks yours, you swap and both get {bonus}.</p>
        {mine.length ? <div className="offers">{mine.map(space => (
          <button key={space.index} className={`offer${offering === space.index ? ' chosen' : ''}`} disabled={busy || offering === space.index} onClick={() => onOffer(space.index)}>
            <b>{space.name}</b><small>{space.group ?? space.kind} · {money(space.price ?? 0)}</small>
            <small>{offering === space.index ? 'Your offer' : offering !== NO_OFFER ? 'Offer this instead' : 'Offer'}</small></button>))}</div>
          : <p className="hint">You have no property without buildings to offer.</p>}
      </> : <p className="hint">Offers are closed. {view.seats[lander].name} is deciding{offering !== NO_OFFER ? ` on your ${board.spaces[offering].name}` : ''}.</p>}
    </div>
  );
}

function Holdings({ view, seat, canBuildNow, busy, onBuild, onSell }: {
  view: TableView; seat: number; canBuildNow: boolean; busy: boolean; onBuild: (space: number) => void; onSell: (space: number) => void;
}) {
  const owned = board.spaces.filter(space => view.board[space.index].owner === seat);
  if (!owned.length) return null;
  return (
    <table className="players"><thead><tr><th>Your property</th><th>Buildings</th><th>Rent</th><th /></tr></thead><tbody>
      {owned.map(space => (
        <tr key={space.index}>
          <td>{space.name}</td><td>{space.kind === 'city' ? `${view.board[space.index].buildings}/${board.rules.maxBuildingsPerCity}` : '—'}</td>
          <td>{money(rent(view, space.index))}</td>
          <td className="row">
            {canBuildNow && space.kind === 'city' && <button disabled={busy || !canBuild(view, seat, space.index)} onClick={() => onBuild(space.index)}
              title="Needs the whole color group and cash for the building">Build {money(space.buildingCost ?? 0)}</button>}
            <button disabled={busy} onClick={() => onSell(space.index)}>Sell for {money(saleValue(view, space.index))}</button>
          </td>
        </tr>))}
    </tbody></table>
  );
}

function Players({ view, me }: { view: TableView; me: string }) {
  return (
    <table className="players"><thead><tr><th>Seat</th><th>Cash</th><th>Net worth</th><th>Strikes</th><th /></tr></thead><tbody>
      {view.seats.map((seat, index) => (
        <tr key={seat.wallet} className={view.phase === 'playing' && currentSeat(view) === index ? 'turn' : ''}>
          <td><span className="dot" style={{ background: SEAT_COLORS[index] }} />{seat.name}{seat.wallet === me ? ' (you)' : ''}{view.host === seat.wallet ? ' · host' : ''}</td>
          <td className={seat.cash < 0 ? 'error' : ''}>{view.phase === 'lobby' || seat.eliminatedAt ? '—' : money(seat.cash)}</td>
          <td>{view.phase === 'lobby' || seat.eliminatedAt ? '—' : money(netWorth(view, index))}</td>
          <td>{seat.strikes}/3</td>
          <td>{seat.eliminatedAt ? (seat.strikes >= board.rules.strikesToForfeit ? 'forfeited' : 'bankrupt') : seat.jailTurns ? `in jail (${seat.jailTurns})` : seat.cash < 0 ? 'in debt' : ''}</td>
        </tr>))}
    </tbody></table>
  );
}

function Board({ view }: { view: TableView }) {
  return (
    <div className="board">
      {board.spaces.map(space => {
        const lot = view.board[space.index], here = view.seats.map((seat, index) => ({ seat, index })).filter(item => item.seat.position === space.index && !item.seat.eliminatedAt);
        return (
          <div key={space.index} className={`space ${space.kind}`} style={lot.owner !== NO_OWNER ? { borderColor: SEAT_COLORS[lot.owner] } : undefined}>
            <small>{space.index}</small><b>{space.name}</b>
            {isProperty(space) && <small>{money(space.price ?? 0)} · rent {money(lot.owner === NO_OWNER ? space.rent ?? 0 : rent(view, space.index))}</small>}
            {lot.buildings > 0 && <small className="buildings">{'■'.repeat(lot.buildings)} {lot.buildings} building{lot.buildings > 1 ? 's' : ''}</small>}
            <div>{here.map(item => <span key={item.index} className="dot" style={{ background: SEAT_COLORS[item.index] }} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Results({ view }: { view: TableView }) {
  const settled = view.phase === 'free', payouts = settled ? view.seats.map(seat => seat.payout) : expectedPayouts(view).payouts;
  return (
    <div>
      <h3>{settled ? 'Paid out' : 'Game over — settling…'}</h3>
      <ol>{view.seats.map((seat, index) => ({ seat, index, payout: payouts[index] })).sort((a, b) => b.payout - a.payout)
        .map(item => <li key={item.seat.wallet}>{item.seat.name}: {usdc(item.payout)} USDC (net worth {money(netWorth(view, item.index))})</li>)}</ol>
      <p className="hint">Payouts land in each play balance. {PROTOCOL_FEE_BPS / 100}% fee and rounding dust go to the treasury.</p>
      <button onClick={() => navigate('/')}>New table</button>
    </div>
  );
}
