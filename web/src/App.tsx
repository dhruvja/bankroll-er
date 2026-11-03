import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Keypair } from '@solana/web3.js';
import { board, defaultTarget, isProperty } from '../../shared/board';
import { ENTRIES, PROTOCOL_FEE_BPS, RELAY_FEE, TOKEN_SCALE, WITHDRAW_MINIMUM } from '../../shared/config';
import { NO_OWNER, currentSeat, expectedPayouts, netWorth, type TableView } from '../../shared/chain';
import { act, deposit, getWalletInfo, joinTable, openTable, runCrank, subscribeTable, wallet, withdraw, type WalletInfo } from './lib/game';
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
            : `${view.seats[turnSeat].name} to ${view.stage === 'buydecision' ? 'decide' : 'roll'} · ${left}s`}{view.lastRoll ? ` · last roll ${view.lastRoll}` : ''}</p>
          {myTurn && view.stage === 'preroll' && <button disabled={busy} onClick={action('roll')}>Roll</button>}
          {myTurn && view.stage === 'buydecision' && (() => {
            const space = board.spaces[view.seats[seat].position];
            return <div className="row"><button disabled={busy} onClick={action('buy')}>Buy {space.name} for {money(space.price ?? 0)}</button>
              <button disabled={busy} onClick={action('pass')}>Pass</button></div>;
          })()}
        </div>
      )}
      {(view.phase === 'finished' || view.phase === 'free') && <Results view={view} />}
      {view.phase === 'refunding' && <p>Refunding every entry in full, with no fee. {view.seats.filter(item => item.refunded).length}/{view.playerCount} returned.</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Players({ view, me }: { view: TableView; me: string }) {
  return (
    <table className="players"><thead><tr><th>Seat</th><th>Cash</th><th>Net worth</th><th>Strikes</th><th /></tr></thead><tbody>
      {view.seats.map((seat, index) => (
        <tr key={seat.wallet} className={view.phase === 'playing' && currentSeat(view) === index ? 'turn' : ''}>
          <td><span className="dot" style={{ background: SEAT_COLORS[index] }} />{seat.name}{seat.wallet === me ? ' (you)' : ''}{view.host === seat.wallet ? ' · host' : ''}</td>
          <td>{view.phase === 'lobby' ? '—' : money(seat.cash)}</td><td>{view.phase === 'lobby' ? '—' : money(netWorth(view, index))}</td>
          <td>{seat.strikes}/3</td><td>{seat.eliminatedAt ? 'out' : ''}</td>
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
            {isProperty(space) && <small>{money(space.price ?? 0)} · rent {money(space.rent ?? 0)}</small>}
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
