import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Keypair } from '@solana/web3.js';
import { board, defaultTarget } from '../../shared/board';
import { DEMO_ENTRY, PAID_ENTRIES, PROTOCOL_FEE_BPS, RELAY_FEE, SHARES_BPS, WITHDRAW_MINIMUM } from '../../shared/config';
import type { TableView } from '../../shared/chain';
import { deposit, getWalletInfo, hostedTable, joinTable, listLobbies, openTable, readTable, wallet, withdraw, type WalletInfo } from './lib/game';
import { exportWallet } from './lib/wallet';
import { GROUP_COLORS, SEAT_COLORS, money } from './Board';
import { THEMES, spacesFor } from '../../shared/themes';
import { TableScreen, lastGamePath, navigate, saveName, savedName, tableLabel, useBusy, usdc } from './Table';
import { Rules } from './Rules';

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const update = () => setPath(location.pathname); addEventListener('popstate', update); return () => removeEventListener('popstate', update); }, []);
  return path;
}

/** Two modes share one app: `/demo` is free play (faucet-funded 0.001 USDC entries, no money shown),
 * `/` is the USDC game with the wallet, entries and payouts. The mode lives in the path, invites included. */
export default function App() {
  const path = usePath(), demo = path === '/demo' || path.startsWith('/demo/');
  const match = /^(?:\/demo)?\/play\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(\d+)$/.exec(path), home = demo ? '/demo' : '/';
  const [info, setInfo] = useState<WalletInfo>(), [signer, setSigner] = useState<Keypair>(), [walletOpen, setWalletOpen] = useState(false);
  const refresh = useCallback(() => {
    void getWalletInfo().then(setInfo, error => setInfo({ address: '', play: null, base: null, sol: null, pending: false, status: error instanceof Error ? error.message : String(error) }));
  }, []);
  useEffect(() => { void wallet().then(setSigner); }, []);
  useEffect(() => {
    if (demo) return;
    refresh(); const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [demo, refresh]);
  const openWalletSheet = () => setWalletOpen(true);
  return (
    <>
      <header className={`topbar${match ? ' on-table' : ''}`}>
        <a className="wordmark" href={home} onClick={event => { event.preventDefault(); navigate(home); }}><img className="logo-mark" src="/favicon.svg" alt="" />Bankroll{demo && <span className="demo-tag">Demo</span>}</a>
        {!demo && <button className="wallet-chip" data-testid="wallet-button" onClick={openWalletSheet}>
          <span className="chip-label">Play balance</span>
          <span className="chip-value" data-testid="wallet-play-chip">{info?.play === null || info?.play === undefined ? '…' : `${info.play.toFixed(2)} USDC`}</span>
        </button>}
      </header>
      <main className={match ? 'on-table' : undefined}>
        {match && signer ? <TableScreen key={path} demo={demo} table={match[1]} nonce={Number(match[2])} me={signer.publicKey.toBase58()} signer={signer} refresh={refresh} openWallet={openWalletSheet} />
          : match ? <p className="center-note">Getting your seat ready…</p> : <Home demo={demo} info={info} refresh={refresh} openWallet={openWalletSheet} />}
      </main>
      {walletOpen && !demo && <WalletSheet info={info} signer={signer} refresh={refresh} onClose={() => setWalletOpen(false)} />}
      <footer className={`footer${match ? ' on-table' : ''}`}>{demo ? 'Free demo: play money only.' : 'Devnet test USDC only.'} Every table, roll and move runs live on a MagicBlock ephemeral rollup; there is no game server.</footer>
    </>
  );
}

function WalletSheet({ info, signer, refresh, onClose }: { info?: WalletInfo; signer?: Keypair; refresh: () => void; onClose: () => void }) {
  const { busy, error, run } = useBusy(), [amount, setAmount] = useState(''), [copied, setCopied] = useState(false);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; addEventListener('keydown', close); return () => removeEventListener('keydown', close); }, [onClose]);
  return (
    <div className="backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="sheet wallet" role="dialog" aria-modal="true" aria-labelledby="wallet-title" data-testid="wallet-sheet">
        <header><h2 id="wallet-title">Your wallet</h2><button className="close" onClick={onClose} aria-label="Close wallet" data-testid="wallet-close">×</button></header>
        <p className="quiet">This browser holds your wallet. Export the recovery file before you clear site data or switch devices.</p>
        <button className="address" data-testid="wallet-address" data-address={info?.address ?? ''} onClick={() => info?.address && void navigator.clipboard?.writeText(info.address).then(() => setCopied(true))}>
          {info?.address || 'Opening…'}<small>{copied ? 'Copied' : 'Tap to copy'}</small></button>
        <dl className="balances">
          <div><dt>Play balance</dt><dd className="cash" data-testid="wallet-play" data-value={info?.play ?? ''}>{info?.play?.toFixed(2) ?? '—'} USDC</dd></div>
          <div><dt>In your wallet</dt><dd data-testid="wallet-base" data-value={info?.base ?? ''}>{info?.base?.toFixed(2) ?? '—'} USDC</dd></div>
          <div><dt>SOL</dt><dd data-testid="wallet-sol" data-value={info?.sol ?? ''}>{info?.sol ?? '—'}</dd></div>
        </dl>
        <p className="quiet">Send devnet USDC to the address above, then move it into play. Moving money in or out is sponsored: you never need SOL.
          Each move costs {usdc(RELAY_FEE)} USDC, and a withdrawal needs at least {usdc(WITHDRAW_MINIMUM)} USDC.</p>
        <div className="actions">
          <button className="btn primary" data-testid="deposit-all" disabled={busy || !info?.base || info.base * 1e6 <= RELAY_FEE * 2} onClick={() => void run(async () => { await deposit(); refresh(); })}>
            {busy ? 'Working…' : 'Move all into play'}</button>
        </div>
        <form className="actions" onSubmit={(event: FormEvent) => { event.preventDefault(); void run(async () => { await withdraw(Number(amount)); setAmount(''); refresh(); }); }}>
          <input data-testid="withdraw-amount" placeholder="USDC" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" aria-label="Amount to withdraw" />
          <button className="btn" data-testid="withdraw-submit" disabled={busy || !amount}>Withdraw to wallet</button>
        </form>
        <div className="actions">
          <button className="btn ghost" disabled={!signer} onClick={() => signer && exportWallet(signer)}>Export recovery file</button>
          <button className="btn ghost" data-testid="wallet-refresh" onClick={refresh}>Refresh</button>
        </div>
        {(error || info?.status) && <p className="error" data-testid="wallet-error">{error ?? info?.status}</p>}
      </section>
    </div>
  );
}

function Home({ demo, info, refresh, openWallet }: { demo: boolean; info?: WalletInfo; refresh: () => void; openWallet: () => void }) {
  return (
    <div className="home">
      <section className="hero">
        <h1>Roll, buy, trade.<br />{demo ? 'Beat your friends.' : 'First to the target takes the pot.'}</h1>
        <p>{demo ? 'A board game for 2 to 4 friends. Pick a board, open a table, send the link. Free, nothing to sign up for or install.'
          : 'A board game for 2 to 4 friends playing for devnet USDC. Each player pays the entry, and the pot pays out by rank. No SOL needed, ever.'}</p>
        <a className="mode-switch" href={demo ? '/' : '/demo'} onClick={event => { event.preventDefault(); navigate(demo ? '/' : '/demo'); }}>
          {demo ? 'Play for devnet USDC instead →' : 'Just trying it out? Play the free demo →'}</a>
      </section>
      <Resume />
      <QuickPlay demo={demo} info={info} refresh={refresh} openWallet={openWallet} />
      <div className="home-grid">
        <OpenTableForm demo={demo} info={info} refresh={refresh} openWallet={openWallet} />
        <div className="home-side">
          <OpenTables demo={demo} />
          {!demo && <Payouts />}
        </div>
      </div>
      <section className="panel" id="rules" data-testid="home-rules"><h2>How to play</h2><Rules demo={demo} /></section>
    </div>
  );
}

function Payouts() {
  return (
    <section className="panel">
      <h2>Payouts</h2>
      <table className="payouts" aria-label="Payout by rank">
        <thead><tr><th>Players</th><th>1st</th><th>2nd</th><th>3rd</th></tr></thead>
        <tbody>{[2, 3, 4].map(count => <tr key={count}><td>{count}</td>{[0, 1, 2].map(place => <td key={place}>{SHARES_BPS[count][place] ? `${SHARES_BPS[count][place] / 100}%` : ''}</td>)}</tr>)}</tbody>
      </table>
      <p className="quiet">Shares of the pot. {PROTOCOL_FEE_BPS / 100}% goes to the house.</p>
    </section>
  );
}

/** Each theme card previews the cheapest street, the dearest one and the hot middle. */
const THEME_SHAPES = ['circle', 'square', 'triangle'];
function ThemePicker({ theme, onChange }: { theme: number; onChange: (theme: number) => void }) {
  return (
    <fieldset><legend>Board</legend>
      <div className="themes">{THEMES.map(item => {
        const spaces = spacesFor(item.id);
        return (
          <label key={item.id} className={`theme theme-${item.id}${theme === item.id ? ' on' : ''}`} data-testid={`open-theme-${item.id}`}>
            <input type="radio" name="theme" checked={theme === item.id} onChange={() => onChange(item.id)} />
            <span className={`theme-mark ${THEME_SHAPES[item.id]}`} aria-hidden="true" />
            <b>{item.name}</b>
            <span className="theme-streets">
              {[1, 18, 27].map(index => <span key={index} style={{ borderColor: GROUP_COLORS[spaces[index].group ?? 'Public'] }}>{spaces[index].name}</span>)}
            </span>
          </label>
        );
      })}</div>
    </fieldset>
  );
}

const gamePath = (view: TableView) => `${view.entry === DEMO_ENTRY ? '/demo' : ''}/play/${view.address}/${view.gameNonce}`;

/** Your last game if it is still on, else a table you host that is still in a game. */
function Resume() {
  const [game, setGame] = useState<{ path: string; view: TableView }>();
  useEffect(() => {
    let alive = true;
    void (async () => {
      const path = lastGamePath(), match = path ? /^(?:\/demo)?\/play\/(\w+)\/(\d+)$/.exec(path) : null;
      const last = match ? await readTable(match[1]).catch(() => undefined) : undefined;
      if (path && match && last?.gameNonce === Number(match[2]) && last.phase !== 'free') { if (alive) setGame({ path, view: last }); return; }
      const hosted = await hostedTable().catch(() => undefined);
      if (alive && hosted && hosted.phase !== 'free') setGame({ path: gamePath(hosted), view: hosted });
    })();
    return () => { alive = false; };
  }, []);
  if (!game) return null;
  return (
    <section className="panel resume" data-testid="resume">
      <p>You have a game in progress at {tableLabel(game.view)} ({game.view.phase}).</p>
      <button className="btn primary" onClick={() => navigate(game.path)}>Back to your game</button>
    </section>
  );
}

/** Opening a table while your own is still in a game: a wallet hosts one table at a time. */
function Hosting({ view }: { view: TableView }) {
  return (
    <div className="hosting" data-testid="hosting">
      <p className="quiet">You already host {tableLabel(view)}, and its game is still {view.phase === 'lobby' ? 'waiting for players' : 'going'}. You can host one table at a time.</p>
      <button type="button" className="btn primary" data-testid="hosting-back" onClick={() => navigate(gamePath(view))}>Back to your table</button>
    </div>
  );
}

/** Quick play with no server: everything is read from the rollup. It joins the fullest lobby of
 * that size and entry that still has time left (a seat can go between reading and joining, so it
 * tries the next), and opens a new table on the Classic board when none is waiting. */
function QuickPlay({ demo, info, refresh, openWallet }: { demo: boolean; info?: WalletInfo; refresh: () => void; openWallet: () => void }) {
  const { busy, error, run } = useBusy(), [name, setName] = useState(savedName), [hosting, setHosting] = useState<TableView>();
  const entry = demo ? DEMO_ENTRY : PAID_ENTRIES[0], prefix = demo ? '/demo' : '';
  const play = (players: number) => void run(async () => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Pick a name first.');
    saveName(trimmed); setHosting(undefined);
    const me = (await wallet()).publicKey.toBase58(), soon = Date.now() / 1000 + 30;
    const waiting = (await listLobbies())
      .filter(table => table.entry === entry && table.maxPlayers === players && table.playerCount < players && table.lobbyDeadline > soon && !table.seats.some(seat => seat.wallet === me))
      .sort((a, b) => b.playerCount - a.playerCount || a.lobbyDeadline - b.lobbyDeadline);
    for (const table of waiting) {
      try {
        await joinTable(table.address, table.gameNonce, trimmed, entry);
        if (!demo) refresh();
        navigate(`${prefix}/play/${table.address}/${table.gameNonce}`);
        return;
      } catch { /* Filled or closed since we read it: try the next one. */ }
    }
    const opened = await openTable({ name: trimmed, entry, maxPlayers: players, target: defaultTarget(players), theme: 0, startCash: board.rules.startCash });
    if (opened.hosting) return setHosting(opened.hosting);
    if (!demo) refresh();
    navigate(`${prefix}/play/${opened.table}/${opened.nonce}`);
  });
  const short = !demo && info?.play !== null && info?.play !== undefined && info.play * 1e6 < entry;
  return (
    <section className="panel quick-play" data-testid="quick-play">
      <h2>Quick play</h2>
      <p className="quiet">Jump into a table that is waiting for players, or open one if none is. {demo ? 'Free.' : `${usdc(entry)} USDC entry.`}</p>
      <label>Your name<input data-testid="quick-name" maxLength={16} value={name} onChange={event => setName(event.target.value)} autoComplete="nickname" /></label>
      <div className="quick-modes">{[2, 3, 4].map(players => (
        <button key={players} className="btn primary" data-testid={`quick-${players}`} disabled={busy} onClick={() => play(players)}>
          <b>{players} players</b><small>First to {money(defaultTarget(players))}</small></button>))}</div>
      {busy && <p className="quiet">Finding you a table…</p>}
      {hosting && <Hosting view={hosting} />}
      {short && <p className="quiet">Your play balance is short, so this first moves USDC in from your wallet (0.20 USDC fee, no SOL). <button type="button" className="linkish" onClick={openWallet}>Open wallet</button></p>}
      {error && <p className="error" data-testid="quick-error">{error}</p>}
    </section>
  );
}

function OpenTableForm({ demo, info, refresh, openWallet }: { demo: boolean; info?: WalletInfo; refresh: () => void; openWallet: () => void }) {
  const { busy, error, run } = useBusy(), [hosting, setHosting] = useState<TableView>();
  const [name, setName] = useState(savedName), [players, setPlayers] = useState(2), [theme, setTheme] = useState(0), [startCash, setStartCash] = useState(board.rules.startCash), [paidEntry, setPaidEntry] = useState<number>(PAID_ENTRIES[0]);
  const entry = demo ? DEMO_ENTRY : paidEntry;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      saveName(name.trim()); setHosting(undefined);
      const opened = await openTable({ name: name.trim(), entry, maxPlayers: players, target: defaultTarget(players, startCash), theme, startCash });
      if (opened.hosting) return setHosting(opened.hosting);
      if (!demo) refresh();
      navigate(`${demo ? '/demo' : ''}/play/${opened.table}/${opened.nonce}`);
    });
  };
  const short = !demo && info?.play !== null && info?.play !== undefined && info.play * 1e6 < entry;
  return (
    <form className="panel open-form" onSubmit={submit} data-testid="open-form">
      <h2>Open a table</h2>
      <ThemePicker theme={theme} onChange={setTheme} />
      <label>Your name<input data-testid="open-name" required maxLength={16} value={name} onChange={event => setName(event.target.value)} autoComplete="nickname" /></label>
      {!demo && <fieldset><legend>Entry</legend><div className="segmented">{PAID_ENTRIES.map(value => (
        <label key={value} className={paidEntry === value ? 'on' : ''}><input type="radio" name="entry" data-testid={`open-entry-${value}`} checked={paidEntry === value} onChange={() => setPaidEntry(value)} />{usdc(value)} USDC</label>))}</div></fieldset>}
      <fieldset><legend>Players</legend><div className="segmented">{[2, 3, 4].map(count => (
        <label key={count} className={players === count ? 'on' : ''}><input type="radio" name="players" data-testid={`open-players-${count}`} checked={players === count}
          onChange={() => setPlayers(count)} />{count}</label>))}</div></fieldset>
      <fieldset><legend>Starting money</legend><div className="segmented">{board.rules.startCashOptions.map(value => (
        <label key={value} className={startCash === value ? 'on' : ''}><input type="radio" name="start-cash" data-testid={`open-start-${value}`} checked={startCash === value}
          onChange={() => setStartCash(value)} />{money(value)}</label>))}</div></fieldset>
      <p className="quiet">Everyone starts with {money(startCash)}; first to {money(defaultTarget(players, startCash))} net worth wins. {demo ? 'You get an invite link to share once the table is open.' : 'Opening pays your entry. A lobby that never starts refunds everyone in full.'}</p>
      <button className="btn primary" data-testid="open-submit" disabled={busy}>{busy ? 'Opening…' : demo ? 'Open table' : `Open table for ${usdc(entry)} USDC`}</button>
      {short && <p className="quiet">Your play balance is short, so this first moves USDC in from your wallet (0.20 USDC fee, no SOL). <button type="button" className="linkish" onClick={openWallet}>Open wallet</button></p>}
      {hosting && <Hosting view={hosting} />}
      {error && <p className="error" data-testid="error">{error}</p>}
    </form>
  );
}

function OpenTables({ demo }: { demo: boolean }) {
  const [tables, setTables] = useState<TableView[]>(), [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = () => listLobbies().then(list => { if (alive) { setTables(list.filter(table => (table.entry === DEMO_ENTRY) === demo)); setError(undefined); } },
      failure => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)); });
    void load(); const timer = setInterval(load, 8_000);
    return () => { alive = false; clearInterval(timer); };
  }, [demo]);
  return (
    <section className="panel open-tables" data-testid="open-tables">
      <h2>Tables waiting for players</h2>
      {error && <p className="error">{error}</p>}
      {tables?.length === 0 && <p className="quiet">No open tables right now. Open one and share the link.</p>}
      {!tables && !error && <p className="quiet">Looking…</p>}
      <ul>{tables?.map(table => {
        const href = `${demo ? '/demo' : ''}/play/${table.address}/${table.gameNonce}`;
        return (
          <li key={table.address}>
            <a href={href} data-testid={`open-table-${table.address}`} onClick={event => { event.preventDefault(); navigate(href); }}>
              <span className="seats">{table.seats.map((seat, index) => <i key={seat.wallet} style={{ background: SEAT_COLORS[index] }} />)}{Array.from({ length: table.maxPlayers - table.playerCount }, (_, i) => <i key={`e${i}`} className="empty" />)}</span>
              <span><b>{table.seats[0]?.name}’s table</b><small>{demo ? '' : `${usdc(table.entry)} USDC, `}{THEMES[table.theme]?.name ?? 'Classic'} board, first to {money(table.target)}</small></span>
              <span className="join-word">Join</span>
            </a>
          </li>
        );
      })}</ul>
    </section>
  );
}
