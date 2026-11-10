import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Keypair } from '@solana/web3.js';
import { board, defaultTarget } from '../../shared/board';
import { DEMO_ENTRY, PAID_ENTRIES, RELAY_FEE, WITHDRAW_MINIMUM } from '../../shared/config';
import type { TableView } from '../../shared/chain';
import { act, addBot, deposit, getWalletInfo, hostedTable, listLobbies, openTable, readTable, wallet, withdraw, type WalletInfo } from './lib/game';
import { exportWallet } from './lib/wallet';
import { GROUP_COLORS, SEAT_COLORS, money } from './Board';
import { THEMES, spacesFor } from '../../shared/themes';
import { TableScreen, lastGamePath, navigate, saveName, savedName, tableLabel, useBusy, usdc } from './Table';
import { RulesSheet } from './Rules';

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
      <footer className={`footer${match ? ' on-table' : ''}`}>{demo ? 'Play money only.' : 'Devnet USDC only.'} Runs live on a MagicBlock ephemeral rollup.</footer>
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
  const [rulesOpen, setRulesOpen] = useState(false);
  return (
    <div className="home">
      <section className="hero">
        <h1>Roll, buy, trade.</h1>
        <p>{demo ? 'A quick board game. Free, no sign-up.' : 'A board game for devnet USDC. The pot pays out by rank. No SOL needed.'}</p>
      </section>
      <Resume />
      <PlayPanel demo={demo} info={info} refresh={refresh} openWallet={openWallet} />
      <OpenTables demo={demo} />
      <p className="home-links">
        <button type="button" className="linkish" data-testid="home-rules" onClick={() => setRulesOpen(true)}>How to play</button>
        <a href={demo ? '/' : '/demo'} onClick={event => { event.preventDefault(); navigate(demo ? '/' : '/demo'); }}>{demo ? 'Play for devnet USDC' : 'Play free'}</a>
      </p>
      {rulesOpen && <RulesSheet demo={demo} onClose={() => setRulesOpen(false)} />}
    </div>
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

/** The home page's one form: your name, then a game against this browser's bot (demo only) or a
 * table to share with friends. Board, starting money and entry sit under More options. */
function PlayPanel({ demo, info, refresh, openWallet }: { demo: boolean; info?: WalletInfo; refresh: () => void; openWallet: () => void }) {
  const { busy, error, run } = useBusy(), [hosting, setHosting] = useState<TableView>(), [pending, setPending] = useState<'bot' | 'friends'>();
  const [name, setName] = useState(savedName), [players, setPlayers] = useState(2), [theme, setTheme] = useState(0);
  const [startCash, setStartCash] = useState(board.rules.startCash), [paidEntry, setPaidEntry] = useState<number>(PAID_ENTRIES[0]);
  const entry = demo ? DEMO_ENTRY : paidEntry;
  const open = (bot: boolean) => void run(async () => {
    const trimmed = name.trim() || 'Player', count = bot ? 2 : players;
    saveName(trimmed); setHosting(undefined); setPending(bot ? 'bot' : 'friends');
    try {
      const opened = await openTable({ name: trimmed, entry, maxPlayers: count, target: defaultTarget(count, startCash), theme, startCash });
      if (opened.hosting) return setHosting(opened.hosting);
      if (!demo) refresh();
      const path = `${demo ? '/demo' : ''}/play/${opened.table}/${opened.nonce}`;
      if (!bot) return navigate(path);
      // Lands in the lobby either way: if the bot can't be seated, it has an Add a bot button to retry.
      try {
        const view = await readTable(opened.table);
        if (view) { await addBot(view); await act(opened.table, 'start'); }
      } finally { navigate(path); }
    } finally { setPending(undefined); }
  });
  const short = !demo && info?.play !== null && info?.play !== undefined && info.play * 1e6 < entry;
  return (
    <section className="panel play" data-testid="home-play">
      <label>Your name<input data-testid="play-name" maxLength={16} placeholder="Player" value={name} onChange={event => setName(event.target.value)} autoComplete="nickname" /></label>
      {demo && <button className="btn primary big" data-testid="play-bot" disabled={busy} onClick={() => open(true)}>{pending === 'bot' ? 'Setting up your game…' : 'Play against a bot'}</button>}
      <div className="friends">
        <div className="segmented" role="radiogroup" aria-label="Players">{[2, 3, 4].map(count => (
          <label key={count} className={players === count ? 'on' : ''}><input type="radio" name="players" data-testid={`open-players-${count}`} checked={players === count}
            onChange={() => setPlayers(count)} />{count} players</label>))}</div>
        <button className={`btn${demo ? '' : ' primary'}`} data-testid="open-submit" disabled={busy} onClick={() => open(false)}>
          {pending === 'friends' ? 'Opening…' : demo ? 'Play with friends' : `Open a table for ${usdc(entry)} USDC`}</button>
      </div>
      <details className="more-options">
        <summary>More options</summary>
        <ThemePicker theme={theme} onChange={setTheme} />
        {!demo && <fieldset><legend>Entry</legend><div className="segmented">{PAID_ENTRIES.map(value => (
          <label key={value} className={paidEntry === value ? 'on' : ''}><input type="radio" name="entry" data-testid={`open-entry-${value}`} checked={paidEntry === value} onChange={() => setPaidEntry(value)} />{usdc(value)} USDC</label>))}</div></fieldset>}
        <fieldset><legend>Starting money</legend><div className="segmented">{board.rules.startCashOptions.map(value => (
          <label key={value} className={startCash === value ? 'on' : ''}><input type="radio" name="start-cash" data-testid={`open-start-${value}`} checked={startCash === value}
            onChange={() => setStartCash(value)} />{money(value)}</label>))}</div></fieldset>
      </details>
      {short && <p className="quiet">Your play balance is short. <button type="button" className="linkish" onClick={openWallet}>Open wallet</button></p>}
      {hosting && <Hosting view={hosting} />}
      {error && <p className="error" data-testid="error">{error}</p>}
    </section>
  );
}

function OpenTables({ demo }: { demo: boolean }) {
  const [tables, setTables] = useState<TableView[]>();
  useEffect(() => {
    let alive = true;
    const load = () => listLobbies().then(list => { if (alive) setTables(list.filter(table => (table.entry === DEMO_ENTRY) === demo)); }, () => {});
    void load(); const timer = setInterval(load, 8_000);
    return () => { alive = false; clearInterval(timer); };
  }, [demo]);
  if (!tables?.length) return null;
  return (
    <section className="panel open-tables" data-testid="open-tables">
      <h2>Join a table</h2>
      <ul>{tables?.map(table => {
        const href = `${demo ? '/demo' : ''}/play/${table.address}/${table.gameNonce}`;
        return (
          <li key={table.address}>
            <a href={href} data-testid={`open-table-${table.address}`} onClick={event => { event.preventDefault(); navigate(href); }}>
              <span className="seats">{table.seats.map((seat, index) => <i key={seat.wallet} style={{ background: SEAT_COLORS[index] }} />)}{Array.from({ length: table.maxPlayers - table.playerCount }, (_, i) => <i key={`e${i}`} className="empty" />)}</span>
              <span><b>{table.seats[0]?.name}’s table</b><small>{table.playerCount} of {table.maxPlayers} seated{demo ? '' : `, ${usdc(table.entry)} USDC`}</small></span>
              <span className="join-word">Join</span>
            </a>
          </li>
        );
      })}</ul>
    </section>
  );
}
