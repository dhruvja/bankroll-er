import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Keypair } from '@solana/web3.js';
import { QRCodeSVG } from 'qrcode.react';
import { board, isProperty } from '../../shared/board';
import { PROTOCOL_FEE_BPS, TOKEN_SCALE, WITHDRAW_MINIMUM } from '../../shared/config';
import { THEMES, spacesFor } from '../../shared/themes';
import { NO_OFFER, NO_OWNER, canBuild, currentSeat, expectedPayouts, isActive, netWorth, rent, saleValue, tradeOffers, tradeable, type TableView } from '../../shared/chain';
import { acceptTrade, act, canReceive, client, friendlyError, joinTable, property, runCrank, subscribeTable, tableTransactions, trade, watchTableTransactions, type TableTransaction } from './lib/game';
import { sounds, useSoundToggle } from './sound';
import { RulesSheet } from './Rules';
import { Board, Die, GROUP_COLORS, GROUP_INK, SEAT_COLORS, SEAT_INK, money, useDie, useTokenPositions, type Highlight } from './Board';
import { PublicKey } from '@solana/web3.js';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export const usdc = (atoms: number) => (atoms / TOKEN_SCALE).toFixed(2);
const LAST_GAME = 'bankroll.lastGame';
export function navigate(path: string) { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }

export function useNow() {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 250); return () => clearInterval(timer); }, []);
  return now;
}
export function useBusy() {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const run = useCallback(async (task: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await task(); } catch (failure) { setError(friendlyError(failure)); } finally { setBusy(false); }
  }, []);
  return { busy, error, run };
}

/** Table state from the rollup: a websocket push, with a read every 4 s whenever the socket has been
 * quiet, so a dropped connection or a reload always lands on the exact current stage. */
function useTable(table: string) {
  const [view, setView] = useState<TableView>(), [connected, setConnected] = useState(true), [readError, setReadError] = useState<string>();
  useEffect(() => {
    let lastPush = 0, alive = true;
    const accept = (next: TableView) => { if (alive) { setView(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); setReadError(undefined); } };
    const stop = subscribeTable(table, next => { lastPush = Date.now(); setConnected(true); accept(next); }, failure => setReadError(failure.message));
    const timer = setInterval(() => {
      if (Date.now() - lastPush < 4_000) return;
      const started = Date.now();
      client.readTable(new PublicKey(table)).then(next => { setConnected(true); if (lastPush < started) accept(next); }, () => setConnected(false));
    }, 4_000);
    return () => { alive = false; stop(); clearInterval(timer); };
  }, [table]);
  return { view, connected, readError };
}

export interface FeedEntry { at: number; kind: 'roll' | 'buy' | 'sell' | 'build' | 'trade' | 'rent' | 'card' | 'jail' | 'strike' | 'out' | 'end'; text: string }

/** A readable game log derived from consecutive table snapshots, kept per game in this browser. */
function useFeed(view: TableView | undefined, key: string) {
  const [feed, setFeed] = useState<FeedEntry[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? '[]') as FeedEntry[]; } catch { return []; } });
  const previous = useRef<TableView>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = view;
    if (!view || !before || before.gameNonce !== view.gameNonce) return;
    const name = (seat: number) => view.seats[seat]?.name ?? `Seat ${seat + 1}`, at = Date.now(), added: FeedEntry[] = [];
    const lander = currentSeat(before);
    if (before.phase === 'playing' && before.stage === 'rolling' && view.stage !== 'rolling' && view.vrfNonce === before.vrfNonce && view.lastRoll) {
      added.push({ at, kind: 'roll', text: `${name(lander)} rolled a ${view.lastRoll}${view.lastCard ? '' : ` to ${spacesFor(view.theme)[view.seats[lander].position].name}`}` });
      if (view.lastCard) added.push({ at, kind: 'card', text: `${name(lander)} drew: ${board.luckyDeck[view.lastCard - 1].text}` });
      const lot = view.board[view.seats[lander].position];
      if (lot.owner !== NO_OWNER && lot.owner !== lander) {
        const paid = view.seats[lot.owner].cash - before.seats[lot.owner].cash;
        if (paid > 0) added.push({ at, kind: 'rent', text: `${name(lander)} paid ${money(paid)} rent to ${name(lot.owner)}` });
      }
    }
    const moved: { space: number; from: number; to: number }[] = [];
    view.board.forEach((lot, space) => {
      const was = before.board[space];
      if (was.owner === NO_OWNER && lot.owner !== NO_OWNER) added.push({ at, kind: 'buy', text: `${name(lot.owner)} bought ${spacesFor(view.theme)[space].name} for ${money(spacesFor(view.theme)[space].price ?? 0)}` });
      else if (was.owner !== NO_OWNER && lot.owner === NO_OWNER && before.phase === 'playing' && view.phase === 'playing' && !view.seats[was.owner]?.eliminatedAt) added.push({ at, kind: 'sell', text: `${name(was.owner)} sold ${spacesFor(view.theme)[space].name}` });
      else if (was.owner !== NO_OWNER && lot.owner !== NO_OWNER && was.owner !== lot.owner) moved.push({ space, from: was.owner, to: lot.owner });
      if (lot.owner === was.owner && lot.buildings > was.buildings) added.push({ at, kind: 'build', text: `${name(lot.owner)} built ${lot.buildings === HOTEL ? 'a hotel' : `house ${lot.buildings}`} on ${spacesFor(view.theme)[space].name}` });
    });
    // A swap is two lots that changed hands in opposite directions; pairing them survives coalesced updates.
    for (const [i, x] of moved.entries()) {
      const y = moved.slice(i + 1).find(other => other.from === x.to && other.to === x.from);
      if (y) added.push({ at, kind: 'trade', text: `${name(x.to)} and ${name(y.to)} traded: ${name(x.to)} got ${spacesFor(view.theme)[x.space].name}, ${name(y.to)} got ${spacesFor(view.theme)[y.space].name}, ${money(board.rules.tradeBonus)} each` });
    }
    view.seats.forEach((seat, index) => {
      const was = before.seats[index];
      if (!was) return;
      if (seat.strikes > was.strikes) added.push({ at, kind: 'strike', text: `${seat.name} ran out of time (strike ${seat.strikes} of ${board.rules.strikesToForfeit})` });
      if (seat.jailTurns > 0 && was.jailTurns === 0) added.push({ at, kind: 'jail', text: `${seat.name} went to jail` });
      // A forfeit is the only way out with no payment behind it: not a roll, a swap, a bail or a seat already in debt.
      const bankrupt = before.stage === 'rolling' || moved.length > 0 || was.cash < 0 || (was.jailTurns > 0 && seat.jailTurns === 0);
      if (seat.eliminatedAt && !was.eliminatedAt) added.push({ at, kind: 'out', text: seat.strikes >= board.rules.strikesToForfeit ? `${seat.name} forfeited after ${board.rules.strikesToForfeit} strikes`
        : bankrupt ? `${seat.name} went bankrupt` : `${seat.name} forfeited; their properties are for sale` });
    });
    if (before.phase === 'playing' && view.phase !== 'playing') added.push({ at, kind: 'end', text: 'Game over' });
    if (!added.length) return;
    setFeed(current => {
      const next = [...added.reverse(), ...current].slice(0, 80);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage is a convenience only. */ }
      return next;
    });
  }, [view, key]);
  return feed;
}

/** The newest rent payment or player out, shown for a few seconds once every token has finished walking. */
function useRentToast(feed: FeedEntry[], landed: boolean) {
  const seen = useRef(feed[0]?.at ?? 0), [queue, setQueue] = useState<FeedEntry[]>([]), [shown, setShown] = useState<FeedEntry>();
  useEffect(() => {
    const fresh = feed.filter(entry => (entry.kind === 'rent' || entry.kind === 'out') && entry.at > seen.current).reverse();
    seen.current = Math.max(seen.current, feed[0]?.at ?? 0);
    if (fresh.length) setQueue(current => [...current, ...fresh]);
  }, [feed]);
  useEffect(() => {
    if (shown || !landed || !queue.length) return;
    setShown(queue[0]); setQueue(current => current.slice(1));
  }, [queue, landed, shown]);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(undefined), 3500);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
}

/** The Lucky card the latest roll drew, tied to that roll and hidden once the next roll starts. */
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

const STAGE_SECONDS: Record<string, number> = {
  preroll: board.rules.deadlinesSec.preRoll, buydecision: board.rules.deadlinesSec.buyDecision,
  tradeopen: board.rules.deadlinesSec.tradeOpen, tradeoffers: board.rules.deadlinesSec.tradeOffers + board.rules.deadlinesSec.tradeOwnerDecision,
};

/** `demo` tables hide every amount (the faucet pays their 0.001 USDC entries); USDC tables show the
 * entry, pot, payouts and wallet. */
export function TableScreen({ demo, table, nonce, me, signer, refresh, openWallet }: {
  demo: boolean; table: string; nonce: number; me: string; signer: Keypair; refresh: () => void; openWallet: () => void;
}) {
  const { view, connected, readError } = useTable(table);
  const { busy, error, run } = useBusy(), now = useNow();
  const [selected, setSelected] = useState<number>(), [requested, setRequested] = useState(false), [name, setName] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false), [rulesOpen, setRulesOpen] = useState(false), [quitting, setQuitting] = useState(false);
  const seat = view ? view.seats.findIndex(item => item.wallet === me) : -1, current = view && nonce === view.gameNonce;
  const feed = useFeed(current ? view : undefined, `bankroll.feed.${table}.${nonce}`);
  const card = useDrawnCard(current ? view : undefined);
  const die = useDie(current ? view : undefined, requested);
  const positions = useTokenPositions(current ? view : undefined, die.settleAt);
  const rentToast = useRentToast(feed, !die.tumbling && !!view && positions.every((at, index) => at === view.seats[index]?.position));
  const prefix = demo ? '/demo' : '', home = demo ? '/demo' : '/', invite = `${location.origin}${prefix}/play/${table}/${nonce}`;
  useEffect(() => (current && seat >= 0 ? runCrank(table, signer) : undefined), [table, signer, current, seat]);
  const yourTurn = !!current && view.phase === 'playing' && view.stage === 'preroll' && seat >= 0 && seat === currentSeat(view);
  useEffect(() => { if (yourTurn) { sounds.turn(); navigator.vibrate?.(60); } }, [yourTurn]);
  useEffect(() => { if (!demo && (view?.phase === 'free' || view?.phase === 'finished')) refresh(); }, [demo, view?.phase, refresh]);
  useEffect(() => {
    if (!current || seat < 0) return;
    try { if (view.phase === 'free') localStorage.removeItem(LAST_GAME); else localStorage.setItem(LAST_GAME, `${prefix}/play/${table}/${nonce}`); } catch { /* Convenience only. */ }
  }, [current, seat, view?.phase, table, nonce, prefix]);

  // Trade alert: someone else's Auction landing wants your offer.
  const lander = view ? currentSeat(view) : -1;
  const tradeAlert = Boolean(view && current && seat >= 0 && seat !== lander && isActive(view, seat) && view.phase === 'playing'
    && (view.stage === 'tradeopen' || view.stage === 'tradeoffers' && now < view.trade.deadline));
  useEffect(() => {
    if (!tradeAlert) return;
    navigator.vibrate?.(150);
    const title = document.title; document.title = 'Auction! Bankroll';
    return () => { document.title = title; };
  }, [tradeAlert]);

  const highlights = useMemo(() => {
    const marks = new Map<number, { kind: Highlight; seat: number }>();
    if (view?.stage === 'tradeoffers') {
      marks.set(view.trade.space, { kind: 'give', seat: currentSeat(view) });
      for (const offer of tradeOffers(view)) marks.set(offer.space, { kind: 'offer', seat: offer.seat });
    }
    return marks;
  }, [view]);

  if (!view) return <section className="sheet center-note" data-testid="table-loading">{readError ?? 'Finding the table on the rollup…'}</section>;
  if (!current) return (
    <section className="sheet center-note" data-testid="stale-invite">
      <p>This invite was for an earlier game at table {view.index + 1}. That game has ended.</p>
      <button className="btn" onClick={() => navigate(home)}>Back to the tables</button>
    </section>
  );

  const action = (kind: Parameters<typeof act>[1]) => () => void run(async () => {
    if (kind === 'roll') setRequested(true);
    try { await act(table, kind); } finally { setRequested(false); }
  });
  const canQuit = view.phase === 'playing' && view.stage !== 'ordering' && seat >= 0 && isActive(view, seat);
  const turnSeat = currentSeat(view), myTurn = view.phase === 'playing' && seat === turnSeat && view.stage !== 'ordering';
  const deadline = view.phase === 'lobby' ? view.lobbyDeadline : view.stage === 'tradeoffers' && now < view.trade.deadline && seat !== turnSeat ? view.trade.deadline : view.stageDeadline;
  const left = Math.max(0, Math.ceil(deadline - now));
  const idleAt = view.lastActionAt + board.rules.deadlinesSec.idle, timedOut = view.phase === 'playing' && view.stage !== 'ordering' && now >= idleAt;
  const mine = seat >= 0 ? view.seats[seat] : undefined;

  return (
    <div className="table-screen" data-testid="table" data-phase={view.phase} data-stage={view.stage} data-my-seat={seat} data-turn-seat={turnSeat}
      data-my-turn={myTurn ? 'yes' : 'no'} data-lander={turnSeat} data-nonce={view.gameNonce} data-busy={busy ? 'yes' : 'no'}>
      <div className="table-head">
        <a className="head-home" href={home} onClick={event => { event.preventDefault(); navigate(home); }} aria-label="Back to the tables">←</a>
        <div className="head-title">
          <h1>Table {view.index + 1}</h1>
          <p>{demo ? '' : `${usdc(view.entry)} USDC entry, ${usdc(view.entry * view.playerCount)} pot, `}{THEMES[view.theme]?.name ?? 'Classic'} board, first to {money(view.target)} net worth</p>
        </div>
        <SoundToggle />
        <span className={`link-state${connected ? '' : ' offline'}`} data-testid="connection">{connected ? 'Live' : 'Reconnecting…'}</span>
        <button type="button" className="head-act" data-testid="rules-open" onClick={() => setRulesOpen(true)} aria-label="How to play"><span className="label">Rules</span></button>
        {canQuit && <button type="button" className="head-act quit" data-testid="forfeit-open" onClick={() => setQuitting(true)} aria-label="Forfeit"><span className="label">Forfeit</span></button>}
        {!demo && <button type="button" className="head-btn" onClick={openWallet}>Wallet</button>}
        {!canQuit && <button type="button" className="head-btn invite-btn" data-testid="invite-open" onClick={() => setInviteOpen(true)}>Invite</button>}
      </div>
      {inviteOpen && <InviteSheet invite={invite} onClose={() => setInviteOpen(false)} />}
      {rulesOpen && <RulesSheet demo={demo} onClose={() => setRulesOpen(false)} />}
      {tradeAlert && <div className="alert" role="status" data-testid="trade-alert">
        {view.stage === 'tradeopen' ? `${view.seats[turnSeat].name} landed on Auction and is picking a property to trade.`
          : `${view.seats[turnSeat].name} puts ${spacesFor(view.theme)[view.trade.space].name} up for a swap. Make an offer within ${Math.max(0, Math.ceil(view.trade.deadline - now))}s.`}
      </div>}
      {timedOut && <div className="alert warn" role="status" data-testid="timed-out">This game timed out after an hour without a move. {demo ? 'It ends now, ranked by net worth.' : 'It is ending by ranking and paying out now.'}</div>}
      {!timedOut && view.phase === 'playing' && view.stage !== 'ordering' && idleAt - now < 600 && <div className="alert warn" role="status">No moves for {Math.floor((now - view.lastActionAt) / 60)} minutes. If nobody moves, the game ends by ranking in {clock(Math.max(0, idleAt - now))}.</div>}

      <div className="table-grid">
        <div className="board-col">
        {rentToast && <p key={rentToast.at} className="rent-toast" role="status" data-testid="rent-toast">{rentToast.text}</p>}
          <SeatStrip view={view} me={me} />
          <Board view={view} positions={positions} highlights={highlights} selected={selected} onSelect={space => setSelected(space === selected ? undefined : space)}>
            <Center view={view} seat={seat} myTurn={myTurn} left={left} now={now} busy={busy} die={die} card={card} timedOut={timedOut} demo={demo} home={home}
              onRoll={action('roll')} onBail={action('bail')} onStart={action('start')} onCancel={action('cancel')} onBuy={action('buy')} onPass={action('pass')} />
          </Board>
        </div>

        <div className="side">
          <Players view={view} me={me} />
          {error && <p className="error pop" role="alert" data-testid="error">{error}</p>}
          {quitting && canQuit && <section className="panel confirm pop" data-testid="forfeit-confirm">
            <h2>Forfeit the game?</h2>
            <p>You are out for good, and everything you own goes back on sale for the others.{demo ? '' : ' You rank below everyone still playing.'}</p>
            <div className="actions">
              <button className="btn danger" data-testid="forfeit-confirm-button" disabled={busy || view.stage === 'rolling'}
                onClick={() => void run(async () => { await act(table, 'forfeit'); setQuitting(false); })}>{view.stage === 'rolling' ? 'Wait for the roll…' : 'Forfeit'}</button>
              <button className="btn" onClick={() => setQuitting(false)}>Keep playing</button>
            </div>
          </section>}

          {view.phase === 'lobby' && seat < 0 && view.playerCount < view.maxPlayers && <JoinForm view={view} name={name} setName={setName} busy={busy} demo={demo} openWallet={openWallet}
            onJoin={() => void run(async () => { await joinTable(table, nonce, name.trim(), view.entry); if (!demo) refresh(); })} />}
          {view.phase === 'lobby' && <section className="panel invite"><h2>Invite friends</h2><InviteBody invite={invite} size={132} /></section>}

          {view.phase === 'playing' && view.stage === 'buydecision' && <PropertyCard view={view} space={view.seats[turnSeat].position} seat={seat}
            heading={myTurn ? 'Buy this property?' : `${view.seats[turnSeat].name} is deciding`} />}

          {view.phase === 'playing' && (view.stage === 'tradeopen' || view.stage === 'tradeoffers') && seat >= 0 && <div className="pop">
            <TradeSheet view={view} seat={seat} now={now} busy={busy}
              onOpen={space => void run(() => trade(table, 'open', space))} onOffer={space => void run(() => trade(table, 'offer', space))}
              onAccept={(from, space) => void run(() => acceptTrade(table, from, space))} onPass={action('pass')} />
          </div>}

          {myTurn && mine && mine.cash < 0 && <p className="error pop">You are {money(mine.cash)} in debt. Sell a property before you can buy, build or pay bail.
            Below {money(board.rules.bankruptCashBelow)}, or at a net worth of $0, you are bankrupt.</p>}

          {selected !== undefined && view.phase === 'playing' && <div className="pop"><PropertyCard view={view} space={selected} seat={seat} heading="Property" onClose={() => setSelected(undefined)}>
            {myTurn && view.board[selected].owner === seat && (view.stage === 'preroll' || view.stage === 'buydecision') && <div className="actions">
              {view.stage === 'preroll' && spacesFor(view.theme)[selected].kind === 'city' && <button className="btn" data-testid="card-build" disabled={busy || !canBuild(view, seat, selected)}
                onClick={() => void run(() => property(table, 'build', selected))}>{view.board[selected].buildings === HOTEL ? 'Has a hotel' : `Build ${view.board[selected].buildings === HOTEL - 1 ? 'hotel' : 'house'} for ${money(spacesFor(view.theme)[selected].buildingCost ?? 0)}`}</button>}
              <button className="btn" data-testid="card-sell" disabled={busy} onClick={() => void run(async () => { await property(table, 'sell', selected); setSelected(undefined); })}>
                Sell for {money(saleValue(view, selected))}</button>
            </div>}
          </PropertyCard></div>}

          {view.phase === 'playing' && seat >= 0 && <Holdings view={view} seat={seat} buildNow={myTurn && view.stage === 'preroll'} onSelect={setSelected} />}
          {(view.phase === 'finished' || view.phase === 'free' && view.endedAt > 0) && <Results view={view} me={me} demo={demo} home={home} openWallet={openWallet} />}
          {view.phase === 'free' && !view.endedAt && <section className="panel" data-testid="refunded"><h2>{demo ? 'Table closed' : 'Entries refunded'}</h2>
            <p className="quiet">{demo ? 'The game never started.' : 'The game never started, so every entry went back to its play balance with no fee.'}</p>
            <button className="btn primary" onClick={() => navigate(home)}>Back to the tables</button></section>}
          {view.phase === 'refunding' && (demo ? <Closing view={view} /> : <div className="pop"><Refunding view={view} seat={seat} now={now} openWallet={openWallet} /></div>)}
          <Feed feed={feed} />
          <TxLog table={table} since={view.lobbyDeadline - LOBBY_SECONDS} />
        </div>
      </div>
    </div>
  );
}

function SoundToggle() {
  const [muted, toggle] = useSoundToggle();
  return <button type="button" className={`sound-toggle${muted ? ' off' : ''}`} data-testid="sound-toggle" aria-pressed={!muted} aria-label={muted ? 'Sound off' : 'Sound on'} onClick={toggle}><span className="label">{muted ? 'Sound off' : 'Sound on'}</span></button>;
}

function Center({ view, seat, myTurn, left, now, busy, die, card, timedOut, demo, home, onRoll, onBail, onStart, onCancel, onBuy, onPass }: {
  view: TableView; seat: number; myTurn: boolean; left: number; now: number; busy: boolean; die: { face: number; tumbling: boolean };
  card?: { seat: number; card: number }; timedOut: boolean; demo: boolean; home: string; onRoll: () => void; onBail: () => void; onStart: () => void; onCancel: () => void;
  onBuy: () => void; onPass: () => void;
}) {
  const turnSeat = currentSeat(view), who = view.seats[turnSeat];
  if (view.phase === 'lobby') return (
    <div className="center-stack">
      <p className="big" data-testid="seated">{view.playerCount} of {view.maxPlayers} seated</p>
      <p className="quiet">Lobby closes in {clock(left)}</p>
      {view.host === view.seats[seat]?.wallet && <div className="actions">
        <button className="btn primary" data-testid="start-game" disabled={busy || view.playerCount < 2} onClick={onStart}>Start game</button>
        <button className="btn ghost" data-testid="cancel-table" disabled={busy} onClick={onCancel}>{demo ? 'Cancel table' : 'Cancel and refund'}</button>
      </div>}
      {seat >= 0 && view.host !== view.seats[seat].wallet && <p className="quiet">You’re in. Waiting for the host to start.</p>}
    </div>
  );
  if (view.phase !== 'playing') {
    // Only a game that ended has a ranking; a refunded lobby may have a single seat.
    if (!view.endedAt) return <div className="center-stack"><p className="big">No game</p><p className="quiet">{demo ? 'The game never started.' : 'The game never started, so every entry comes back in full.'}</p>
      <button className="btn" onClick={() => navigate(home)}>Back to the tables</button></div>;
    const payouts = view.phase === 'free' ? view.seats.map(item => item.payout) : expectedPayouts(view).payouts;
    const ranked = view.seats.map((item, index) => ({ item, payout: payouts[index] })).sort((a, b) => b.payout - a.payout);
    return (
      <div className="center-stack">
        <p className="quiet">Game over</p>
        <p className="big" data-testid="winner">{ranked[0].item.name} wins</p>
        <p className="mint">{demo ? money(netWorth(view, view.seats.indexOf(ranked[0].item))) : `${usdc(ranked[0].payout)} USDC`}</p>
        <button className="btn primary" onClick={() => navigate(home)}>Play again</button>
      </div>
    );
  }
  const offerWindow = view.stage === 'tradeoffers' && seat !== turnSeat && now < view.trade.deadline;
  const total = offerWindow ? board.rules.deadlinesSec.tradeOffers : STAGE_SECONDS[view.stage] ?? 30, fraction = Math.min(1, left / total);
  const jailed = who.jailTurns > 0;
  const status = view.stage === 'ordering' ? 'Drawing the turn order'
    : view.stage === 'rolling' ? `${myTurn ? 'You are' : `${who.name} is`} rolling`
    : view.stage === 'buydecision' ? `${myTurn ? 'Buy or pass' : `${who.name} is deciding`}`
    : view.stage === 'tradeopen' ? `${myTurn ? 'You' : who.name} landed on Auction`
    : view.stage === 'tradeoffers' ? 'Auction swap'
    : jailed ? `${myTurn ? 'You are' : `${who.name} is`} in jail` : myTurn ? (view.rollsThisTurn ? 'You rolled a 6. Roll again' : 'Your turn') : `${who.name}’s turn`;
  const slow = view.stage === 'rolling' && now - view.vrfRequestedAt > board.rules.deadlinesSec.vrfRetry;
  return (
    <div className="center-stack">
      <div className={`banner${myTurn ? ' mine' : ''}`} data-testid="turn-banner" style={{ borderColor: SEAT_COLORS[turnSeat] }}>
        <span className="banner-dot" style={{ background: SEAT_COLORS[turnSeat] }} />{status}
      </div>
      <div className="die-wrap">
        <svg className="countdown" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="46" className="track" />
          {view.stage !== 'rolling' && view.stage !== 'ordering' && <circle cx="50" cy="50" r="46" className={`fill${left <= 5 ? ' low' : ''}`} style={{ strokeDashoffset: 289 * (1 - fraction) }} />}
        </svg>
        <Die face={die.face} tumbling={die.tumbling || view.stage === 'rolling' || view.stage === 'ordering'} />
      </div>
      {view.stage !== 'rolling' && view.stage !== 'ordering' && <p className="quiet" data-testid="countdown">{timedOut ? 'Timed out' : `${left}s left`}</p>}
      {slow && <p className="quiet">The roll is slow. Asking the oracle again…</p>}
      {view.stage === 'buydecision' && (() => {
        const space = spacesFor(view.theme)[who.position], price = space.price ?? 0;
        return myTurn ? (
          <div className="decide">
            <p className="decide-name">{space.name}</p>
            <div className="actions">
              <button className="btn primary" data-testid="buy" data-price={price} disabled={busy || who.cash < price} onClick={onBuy}>Buy {money(price)}</button>
              <button className="btn" data-testid="pass" disabled={busy} onClick={onPass}>Pass</button>
            </div>
          </div>
        ) : <p className="decide-name">{space.name}</p>;
      })()}
      {card && <div className="lucky-reveal" data-testid="lucky-card"><span>{view.seats[card.seat].name} drew a Lucky card</span><b>{board.luckyDeck[card.card - 1].text}</b></div>}
      {myTurn && view.stage === 'preroll' && !timedOut && (jailed ? (
        <div className="actions">
          <button className="btn primary" data-testid="bail" disabled={busy || who.cash < board.rules.bail} onClick={onBail}>
            Pay {money(board.rules.bail)} bail{netWorth(view, seat) - board.rules.bail <= 0 ? ' (bankrupts you)' : ''}</button>
          <button className="btn" data-testid="serve" disabled={busy} onClick={onRoll}>Serve a turn ({who.jailTurns} left)</button>
        </div>
      ) : <button className="btn primary roll" data-testid="roll" disabled={busy} onClick={onRoll}>{view.rollsThisTurn ? 'Roll again' : 'Roll'}</button>)}
    </div>
  );
}

/** Phones: two seats above the board and two below, each with cash and net worth. */
/** Phones: every seat in one row above the board, with cash and a bar toward the target. */
function SeatStrip({ view, me }: { view: TableView; me: string }) {
  const live = view.phase !== 'lobby', turn = view.phase === 'playing' ? currentSeat(view) : -1;
  return (
    <div className="seat-strip" style={{ gridTemplateColumns: `repeat(${live ? Math.max(view.seats.length, 2) : view.maxPlayers}, minmax(0, 1fr))` }}>{view.seats.map((seat, index) => {
      const out = seat.eliminatedAt > 0, worth = netWorth(view, index);
      return (
        <div key={seat.wallet} className={`seat-chip${index === turn ? ' turn' : ''}${out ? ' out' : ''}`} style={{ '--seat': SEAT_COLORS[index] } as CSSProperties} data-testid={`seat-chip-${index}`}>
          <span className="seat-name"><span className="player-token" style={{ background: SEAT_COLORS[index], color: SEAT_INK[index] }}>{seat.name.slice(0, 1).toUpperCase()}</span>
            {seat.wallet === me ? 'You' : seat.name}</span>
          {live && <span className={`seat-cash${seat.cash < 0 ? ' neg' : ''}`}>{money(seat.cash)}</span>}
          {live && <span className="seat-note">{out ? 'Out' : seat.jailTurns > 0 ? 'In jail' : `Worth ${money(worth)}`}</span>}
          {live && <span className="seat-bar"><i style={{ width: `${Math.min(100, Math.max(0, worth / view.target * 100))}%` }} /></span>}
        </div>
      );
    })}{!live && Array.from({ length: Math.max(0, view.maxPlayers - view.seats.length) }, (_, at) => <div key={`open-${at}`} className="seat-chip open"><span className="seat-name">Open seat</span></div>)}</div>
  );
}

function Players({ view, me }: { view: TableView; me: string }) {
  const live = view.phase !== 'lobby';
  return (
    <section className="panel players" aria-label="Players">
      {view.seats.map((seat, index) => {
        const worth = netWorth(view, index), out = seat.eliminatedAt > 0, turn = view.phase === 'playing' && currentSeat(view) === index;
        const status = out ? (seat.strikes >= board.rules.strikesToForfeit ? 'Forfeited' : 'Bankrupt') : seat.jailTurns ? `In jail, ${seat.jailTurns} left` : seat.cash < 0 ? 'In debt' : '';
        return (
          <div key={seat.wallet} className={`player${turn ? ' turn' : ''}${out ? ' out' : ''}`} data-testid={`player-${index}`} data-cash={seat.cash} data-networth={worth} data-out={out ? 'yes' : 'no'}>
            <span className="player-token" style={{ background: SEAT_COLORS[index], color: SEAT_INK[index] }}>{seat.name.slice(0, 1).toUpperCase()}</span>
            <div className="player-main">
              <div className="player-name">{seat.name}{seat.wallet === me && <em> (you)</em>}{view.host === seat.wallet && <small> host</small>}</div>
              {live && !out && <div className="progress" title={`${money(worth)} of ${money(view.target)}`}><i style={{ width: `${Math.max(0, Math.min(100, worth / view.target * 100))}%`, background: SEAT_COLORS[index] }} /></div>}
              {(status || seat.strikes > 0) && <div className="player-status">{status}{seat.strikes > 0 && !out && <span className="strikes" title={`${seat.strikes} of 3 strikes`}>{Array.from({ length: 3 }, (_, i) => <i key={i} className={i < seat.strikes ? 'on' : ''} />)}</span>}</div>}
            </div>
            {live && !out && <div className="player-money">
              <span className={`cash${seat.cash < 0 ? ' neg' : ''}`} title="Cash">{money(seat.cash)}</span>
              <span className="worth" title="Net worth">{money(worth)}</span>
            </div>}
          </div>
        );
      })}
      {view.phase !== 'lobby' && <p className="legend"><span className="cash">Cash</span> and <span className="worth">net worth</span>. The bar fills toward {money(view.target)}.</p>}
    </section>
  );
}

function JoinForm({ view, name, setName, busy, demo, openWallet, onJoin }: {
  view: TableView; name: string; setName: (value: string) => void; busy: boolean; demo: boolean; openWallet: () => void; onJoin: () => void;
}) {
  return (
    <form className="panel join pop" onSubmit={event => { event.preventDefault(); if (name.trim()) onJoin(); }}>
      <h2>Join this table</h2>
      <label>Your name<input data-testid="join-name" required maxLength={16} value={name} onChange={event => setName(event.target.value)} /></label>
      <button className="btn primary" data-testid="join-submit" disabled={busy || !name.trim()}>{busy ? 'Joining…' : demo ? 'Join table' : `Join for ${usdc(view.entry)} USDC`}</button>
      {!demo && <p className="quiet">If your play balance is short, this first moves USDC in from your wallet (0.20 USDC fee, no SOL). <button type="button" className="linkish" onClick={openWallet}>Open wallet</button></p>}
    </form>
  );
}

function InviteBody({ invite, size }: { invite: string; size: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(invite).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <>
      <div className="qr"><QRCodeSVG value={invite} size={size} bgColor="#FFFFFF" fgColor="#111111" level="M" title="Scan to join this table" /></div>
      <input className="invite-url" data-testid="invite-link" readOnly value={invite} onFocus={event => event.currentTarget.select()} aria-label="Invite link" />
      <div className="actions">
        <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        {'share' in navigator && <button className="btn ghost" onClick={() => void navigator.share({ title: 'Bankroll', url: invite }).catch(() => {})}>Share</button>}
      </div>
    </>
  );
}

/** Phones: the invite gets its own full-screen page instead of a side panel. */
function InviteSheet({ invite, onClose }: { invite: string; onClose: () => void }) {
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; addEventListener('keydown', close); return () => removeEventListener('keydown', close); }, [onClose]);
  return (
    <section className="invite-sheet" role="dialog" aria-modal="true" aria-labelledby="invite-title" data-testid="invite-sheet">
      <header><h2 id="invite-title">Invite friends</h2><button className="close" onClick={onClose} aria-label="Close invite">×</button></header>
      <p className="quiet">Friends scan this or open the link to take a seat.</p>
      <InviteBody invite={invite} size={240} />
    </section>
  );
}

/** A deed card: group, price, the rent ladder and who owns it. */
/** A city takes up to four houses, then a hotel: the last building level. */
const HOTEL = board.rules.maxBuildingsPerCity;
const buildingLabel = (count: number) => count === HOTEL ? 'Hotel' : `${count} house${count > 1 ? 's' : ''}`;

function PropertyCard({ view, space: index, seat, heading, onClose, children }: {
  view: TableView; space: number; seat: number; heading: string; onClose?: () => void; children?: ReactNode;
}) {
  const space = spacesFor(view.theme)[index], lot = view.board[index];
  const color = space.group ? GROUP_COLORS[space.group] : '#2C4466';
  if (!isProperty(space)) return (
    <section className="panel deed plain" data-testid="property-card">
      <header><b>{space.name}</b>{onClose && <button className="close" onClick={onClose} aria-label="Close">×</button>}</header>
      <p className="quiet">{space.kind === 'lucky' ? 'Draw a Lucky card.' : space.kind === 'jail' ? `Land here, by roll or card, and you sit out ${board.rules.jailTurns} turns, or pay ${money(board.rules.bail)} bail on your turn.`
        : space.kind === 'auction' ? `Put one of your properties up for a swap. Both sides of a completed swap get ${money(board.rules.tradeBonus)}.` : `Collect ${money(board.rules.salary)} each time you pass.`}</p>
    </section>
  );
  const ladder = space.kind === 'city'
    ? [['Rent', space.rent!], ['Whole group', space.rent! * board.rules.groupRentMultiplier], ...board.rules.buildingRentMultipliers.map((m, i) => [buildingLabel(i + 1), space.rent! * m] as [string, number])] as [string, number][]
    : [1, 2, 3, 4].map(count => [`Owner has ${count} of 4 public`, space.rent! * count] as [string, number]);
  const current = lot.owner === NO_OWNER ? -1 : rent(view, index);
  return (
    <section className="panel deed" data-testid="property-card" data-space={index}>
      <header style={{ background: color, color: space.group ? GROUP_INK[space.group] : '#FFFFFF' }}><small>{heading}</small><b>{space.name}</b>{onClose && <button className="close" onClick={onClose} aria-label="Close">×</button>}</header>
      <p className="deed-line">{space.group === 'Public' ? 'Public property' : `${space.group} group`}, price {money(space.price ?? 0)}{space.buildingCost ? `, houses and hotel ${money(space.buildingCost)} each` : '. No houses here: rent grows with each public property the owner holds.'}</p>
      <table><tbody>{ladder.map(([label, value]) => <tr key={label} className={value === current ? 'now' : ''}><td>{label}</td><td>{money(value)}</td></tr>)}</tbody></table>
      <p className="deed-line">{lot.owner === NO_OWNER ? 'For sale' : `Owned by ${lot.owner === seat ? 'you' : view.seats[lot.owner].name}${lot.buildings ? `, ${lot.buildings === HOTEL ? 'a hotel' : buildingLabel(lot.buildings)}` : ''}`}</p>
      {children}
    </section>
  );
}

function Holdings({ view, seat, buildNow, onSelect }: { view: TableView; seat: number; buildNow: boolean; onSelect: (space: number) => void }) {
  const owned = spacesFor(view.theme).filter(space => view.board[space.index].owner === seat);
  if (!owned.length) return null;
  return (
    <section className="panel holdings">
      <h2>Your properties</h2>
      <div className="chips">{owned.map(space => (
        <button key={space.index} className="chip" data-testid={`holding-${space.index}`}
          data-can-build={buildNow && canBuild(view, seat, space.index) ? 'yes' : 'no'} data-cost={space.buildingCost ?? 0} onClick={() => onSelect(space.index)} style={{ borderColor: GROUP_COLORS[space.group ?? 'Public'] }}>
          {space.name}{view.board[space.index].buildings > 0 && <span className="chip-pips">{view.board[space.index].buildings === HOTEL ? 'Hotel' : '▪'.repeat(view.board[space.index].buildings)}</span>}
        </button>))}</div>
      <p className="quiet">Tap one to build or sell. Building needs the whole color group, on your turn before you roll.</p>
    </section>
  );
}

/** Whether `seat` would hold a whole city group after swapping `give` (NO_OFFER for none) for `gain`. */
function completesGroup(view: TableView, seat: number, gain: number, give: number) {
  const space = spacesFor(view.theme)[gain];
  return space.kind === 'city' && Boolean(space.group)
    && board.groups[space.group!].every(member => member === gain || (member !== give && view.board[member].owner === seat));
}
/** What a swap does to `seat`: cash, net worth and any group it completes. */
function SwapEffect({ view, seat, gain, give }: { view: TableView; seat: number; gain: number; give: number }) {
  const delta = (spacesFor(view.theme)[gain].price ?? 0) - (spacesFor(view.theme)[give].price ?? 0) + board.rules.tradeBonus;
  // Public rent scales with how many publics one owner holds, so a public changing hands moves it.
  const publics = spacesFor(view.theme)[gain].kind === 'public' || spacesFor(view.theme)[give]?.kind === 'public'
    ? board.publics.filter(index => index === gain || (index !== give && view.board[index].owner === seat)).length : 0;
  return (
    <span className="effect">
      <span className="cash">cash +{money(board.rules.tradeBonus)}</span>, <span className="worth">net worth {delta >= 0 ? '+' : ''}{money(delta)}</span>
      {completesGroup(view, seat, gain, give) && <b> Completes your {spacesFor(view.theme)[gain].group} group</b>}
      {publics > 0 && <b> Your public properties would charge {money((spacesFor(view.theme).find(item => item.kind === 'public')?.rent ?? 0) * publics)} each</b>}
    </span>
  );
}

function TradeSheet({ view, seat, now, busy, onOpen, onOffer, onAccept, onPass }: {
  view: TableView; seat: number; now: number; busy: boolean;
  onOpen: (space: number) => void; onOffer: (space: number) => void; onAccept: (seat: number, space: number) => void; onPass: () => void;
}) {
  const lander = currentSeat(view), mine = spacesFor(view.theme).filter(space => tradeable(view, seat, space.index)), bonus = money(board.rules.tradeBonus);
  const offersLeft = Math.max(0, Math.ceil(view.trade.deadline - now)), decideLeft = Math.max(0, Math.ceil(view.stageDeadline - now));
  const swatch = (index: number) => <i className="swatch" style={{ background: GROUP_COLORS[spacesFor(view.theme)[index].group ?? 'Public'] }} />;
  if (view.stage === 'tradeopen') {
    if (seat !== lander) return <section className="panel trade" data-testid="trade-sheet"><h2>Auction</h2><p className="quiet">{view.seats[lander].name} is choosing a property to put up for a swap.</p></section>;
    return (
      <section className="panel trade" data-testid="trade-sheet">
        <h2>Put a property up for a swap</h2>
        <p className="quiet">Pick one without buildings. The others can each offer one back and you choose. A completed swap pays you both {bonus}.
          Skipping is free; letting the {decideLeft}s timer run out costs a strike.</p>
        <div className="offers">{mine.map(space => (
          <button key={space.index} className="offer" data-testid={`trade-open-${space.index}`} disabled={busy} onClick={() => onOpen(space.index)}>
            {swatch(space.index)}<b>{space.name}</b><small>{space.group}, {money(space.price ?? 0)}</small></button>))}</div>
        <button className="btn ghost" data-testid="trade-skip" disabled={busy} onClick={onPass}>Skip the trade</button>
      </section>
    );
  }
  const offers = tradeOffers(view), give = view.trade.space, offering = view.trade.offers[seat] ?? NO_OFFER;
  if (seat === lander) return (
    <section className="panel trade" data-testid="trade-sheet">
      <h2>You put up {spacesFor(view.theme)[give].name}</h2>
      <p className="quiet">{offersLeft ? `Offers close in ${offersLeft}s. You can take one now or wait for more.` : 'Offers are closed.'}{' '}
        {offers.length ? `Decide within ${decideLeft}s or the trade is cancelled with a strike.` : 'If nobody offers, the trade is cancelled with no strike.'}</p>
      <div className="offers">{offers.map(offer => (
        <div key={offer.seat} className="offer" style={{ borderColor: SEAT_COLORS[offer.seat] }}>
          <span>{view.seats[offer.seat].name} offers</span>
          <b>{swatch(offer.space)}{spacesFor(view.theme)[offer.space].name}</b><small>{spacesFor(view.theme)[offer.space].group}, {money(spacesFor(view.theme)[offer.space].price ?? 0)}</small>
          <SwapEffect view={view} seat={seat} gain={offer.space} give={give} />
          <button className="btn primary" data-testid={`trade-accept-${offer.seat}`} disabled={busy} onClick={() => onAccept(offer.seat, offer.space)}>Swap</button>
        </div>))}
        {!offers.length && <p className="quiet">Waiting for offers…</p>}</div>
      <button className="btn ghost" data-testid="trade-cancel" disabled={busy} onClick={onPass}>Cancel the trade</button>
    </section>
  );
  if (!isActive(view, seat)) return null;
  return (
    <section className="panel trade" data-testid="trade-sheet">
      <h2>{view.seats[lander].name} puts up {spacesFor(view.theme)[give].name}</h2>
      {offersLeft ? <>
        <p className="quiet">Offer one of your properties without buildings. You can replace your offer until offers close in {offersLeft}s; an offer can’t be withdrawn.</p>
        {mine.length ? <div className="offers">{mine.map(space => (
          <button key={space.index} className={`offer${offering === space.index ? ' chosen' : ''}`} data-testid={`trade-offer-${space.index}`} disabled={busy || offering === space.index} onClick={() => onOffer(space.index)}>
            <b>{swatch(space.index)}{space.name}</b><small>{offering === space.index ? 'Your offer' : offering !== NO_OFFER ? 'Offer this instead' : `Offer ${space.name}`}</small>
            <SwapEffect view={view} seat={seat} gain={give} give={space.index} /></button>))}</div>
          : <p className="quiet">You have no property without buildings to offer.</p>}
      </> : <p className="quiet">Offers are closed. {view.seats[lander].name} is deciding{offering !== NO_OFFER ? ` on your ${spacesFor(view.theme)[offering].name}` : ''}.</p>}
    </section>
  );
}

function Results({ view, me, demo, home, openWallet }: { view: TableView; me: string; demo: boolean; home: string; openWallet: () => void }) {
  // The on-chain ranking settles ties and eliminations. Demo shows net worth; USDC mode shows each payout.
  const settled = view.phase === 'free', payouts = settled ? view.seats.map(seat => seat.payout) : expectedPayouts(view).payouts;
  const ranked = view.seats.map((seat, index) => ({ seat, index, payout: payouts[index] })).sort((a, b) => b.payout - a.payout || netWorth(view, b.index) - netWorth(view, a.index));
  const mine = ranked.find(item => item.seat.wallet === me);
  return (
    <section className="panel results" data-testid="results" data-settled={settled ? 'yes' : 'no'}>
      <h2>{demo ? 'Final standings' : settled ? 'Paid out' : 'Game over, paying out…'}</h2>
      <ol>{ranked.map((item, place) => (
        <li key={item.seat.wallet} data-testid={`result-${item.index}`} data-payout={item.payout}>
          <span className="place">{place + 1}</span><span className="player-token" style={{ background: SEAT_COLORS[item.index], color: SEAT_INK[item.index] }}>{item.seat.name.slice(0, 1).toUpperCase()}</span>
          <span className="result-name">{item.seat.name}{item.seat.wallet === me && <em> (you)</em>}
            <small>{item.seat.eliminatedAt ? (item.seat.strikes >= board.rules.strikesToForfeit ? 'forfeited' : 'bankrupt') : demo ? '' : `net worth ${money(netWorth(view, item.index))}`}</small></span>
          <span className="mint">{demo ? (item.seat.eliminatedAt ? '' : money(netWorth(view, item.index))) : `${usdc(item.payout)} USDC`}</span>
        </li>))}</ol>
      {!demo && <p className="quiet">Payouts land in each play balance. The {PROTOCOL_FEE_BPS / 100}% fee and rounding dust go to the treasury.
        {mine && mine.payout > 0 && mine.payout < WITHDRAW_MINIMUM ? ` Your ${usdc(mine.payout)} USDC is under the ${usdc(WITHDRAW_MINIMUM)} USDC withdraw minimum, so it stays in play for your next entry.`
          : ` Withdrawals need at least ${usdc(WITHDRAW_MINIMUM)} USDC; smaller balances stay in play for your next entry.`}</p>}
      <div className="actions">
        {!demo && mine && mine.payout >= WITHDRAW_MINIMUM && <button className="btn" onClick={openWallet}>Withdraw winnings</button>}
        <button className="btn primary" data-testid="new-table" onClick={() => navigate(home)}>Play again</button>
      </div>
    </section>
  );
}

/** Refunding: a lobby that never started, a settle that deferred one unreachable seat, or the
 * emergency path after a settle kept failing. Each seat collects its own amount. */
function Refunding({ view, seat, now, openWallet }: { view: TableView; seat: number; now: number; openWallet: () => void }) {
  const done = view.seats.filter(item => item.refunded).length, mine = seat >= 0 ? view.seats[seat] : undefined;
  const [reachable, setReachable] = useState<boolean>();
  useEffect(() => {
    if (!mine || mine.refunded) return;
    let alive = true;
    const check = () => void canReceive(mine.wallet).then(value => { if (alive) setReachable(value); }, () => {});
    check(); const timer = setInterval(check, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, [mine?.wallet, mine?.refunded]);
  const grace = Math.max(0, view.stageDeadline - now);
  return (
    <section className="panel" data-testid="refunding">
      <h2>{view.endedAt ? 'Paying out' : 'Refunding entries'}</h2>
      <p>{view.endedAt ? `The game is over. ${done} of ${view.playerCount} players have their ranked share; the rest are sent as soon as each play balance can receive it.`
        : `The game never started, so every entry comes back in full, with no fee. ${done} of ${view.playerCount} returned.`}</p>
      {mine && !mine.refunded && reachable === false && <p className="error" data-testid="treasury-warning">
        Your play balance can’t receive your {view.endedAt ? 'share' : 'entry'} right now. {grace > 0 ? `Reopen it within ${clock(grace)} by depositing any amount from your wallet, or it goes to the treasury.`
          : 'The grace period is over, so it can now be sent to the treasury.'} <button className="linkish" onClick={openWallet}>Open wallet</button></p>}
      {mine && !mine.refunded && reachable && <p className="quiet">Your {view.endedAt ? 'share' : 'entry'} is on its way to your play balance.</p>}
      {mine?.refunded && <p className="mint">You have yours.</p>}
    </section>
  );
}

/** The table is settling on-chain (a lobby that never started, or a finished game). Nothing to do but wait. */
function Closing({ view }: { view: TableView }) {
  const done = view.seats.filter(item => item.refunded).length;
  return (
    <section className="panel" data-testid="refunding">
      <h2>Closing the table</h2>
      <p className="quiet">{view.endedAt ? 'The game is over.' : 'The game never started.'} Wrapping up {done} of {view.playerCount} seats…</p>
    </section>
  );
}

function Feed({ feed }: { feed: FeedEntry[] }) {
  const trades = feed.filter(entry => entry.kind === 'trade');
  if (!feed.length) return null;
  return (
    <section className="panel feed" data-testid="feed">
      {trades.length > 0 && <><h2>Trades</h2><ul data-testid="trade-history">{trades.map(entry => <li key={`${entry.at}-${entry.text}`}>{entry.text}</li>)}</ul></>}
      <h2>What happened</h2>
      <ul>{feed.slice(0, 12).map(entry => <li key={`${entry.at}-${entry.text}`} className={entry.kind}>{entry.text}</li>)}</ul>
    </section>
  );
}

/** Mirrors the program's `LOBBY_SECONDS`: a table's lobby opens this long before its lobby deadline. */
const LOBBY_SECONDS = 600;

/** The table account is reused across games, so the log keeps only transactions since this game's lobby opened. */
function TxLog({ table, since }: { table: string; since: number }) {
  const [open, setOpen] = useState(false), [rows, setRows] = useState<TableTransaction[]>([]), [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const merge = (incoming: TableTransaction[]) => setRows(current => {
      const byId = new Map(current.map(row => [row.signature, row]));
      for (const row of incoming) byId.set(row.signature, { ...row, time: byId.get(row.signature)?.time ?? row.time, label: row.label ?? byId.get(row.signature)?.label });
      return [...byId.values()].filter(row => row.time === null || row.time >= since).sort((a, b) => (b.time ?? 0) - (a.time ?? 0)).slice(0, 60);
    });
    const load = () => tableTransactions(table).then(list => { if (alive) { merge(list); setError(undefined); } }, failure => { if (alive) setError(friendlyError(failure)); });
    void load();
    const stop = watchTableTransactions(table, row => { if (alive) merge([row]); });
    const timer = setInterval(load, 10_000);
    return () => { alive = false; stop(); clearInterval(timer); };
  }, [open, table, since]);
  return (
    <section className="panel txlog" data-testid="tx-log">
      <button className="txlog-toggle" data-testid="tx-log-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        Rollup transactions{rows.length ? ` (${rows.length})` : ''}<span aria-hidden="true">{open ? '−' : '+'}</span></button>
      {open && <>
        <p className="quiet">Every move in this game, from every player, plus the oracle’s dice. Your own moves are named. Read only.</p>
        {error && <p className="error">{error}</p>}
        <table><tbody>{rows.map(row => (
          <tr key={row.signature} data-testid="tx-row">
            <td><a href={row.explorer} target="_blank" rel="noopener noreferrer" title={row.signature}>{row.signature.slice(0, 6)}…{row.signature.slice(-4)}</a></td>
            <td>{row.label ?? 'table'}</td>
            <td>{row.time ? new Date(row.time * 1000).toLocaleTimeString() : ''}</td>
            <td className={row.err ? 'neg' : 'ok'}>{row.err ? 'Failed' : 'OK'}</td>
          </tr>))}</tbody></table>
        {!rows.length && !error && <p className="quiet">Loading…</p>}
      </>}
    </section>
  );
}

export const lastGamePath = () => { try { return localStorage.getItem(LAST_GAME) ?? undefined; } catch { return undefined; } };
