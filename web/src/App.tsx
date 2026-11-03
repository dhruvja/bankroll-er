import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { board, defaultTarget } from '../../shared/board';
import { ENTRIES, PROTOCOL_FEE_BPS, RELAY_FEE, SHARES_BPS, WITHDRAW_MINIMUM } from '../../shared/config';
import type { TableView } from '../../shared/chain';
import { client, deposit, getWalletInfo, listLobbies, openTable, wallet, withdraw, type WalletInfo } from './lib/game';
import { exportWallet } from './lib/wallet';
import { SEAT_COLORS, money } from './Board';
import { TableScreen, lastGamePath, navigate, useBusy, usdc } from './Table';

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const update = () => setPath(location.pathname); addEventListener('popstate', update); return () => removeEventListener('popstate', update); }, []);
  return path;
}

export default function App() {
  const path = usePath(), match = /^\/play\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(\d+)$/.exec(path);
  const [info, setInfo] = useState<WalletInfo>(), [signer, setSigner] = useState<Keypair>(), [walletOpen, setWalletOpen] = useState(false);
  const refresh = useCallback(() => { void getWalletInfo().then(setInfo, error => setInfo({ address: '', play: null, base: null, sol: null, pending: false, status: error instanceof Error ? error.message : String(error) })); }, []);
  useEffect(() => { void wallet().then(setSigner); refresh(); const timer = setInterval(refresh, 15_000); return () => clearInterval(timer); }, [refresh]);
  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/" onClick={event => { event.preventDefault(); navigate('/'); }}>Bankroll</a>
        <button className="wallet-chip" data-testid="wallet-button" onClick={() => setWalletOpen(true)}>
          <span className="chip-label">Play balance</span>
          <span className="chip-value" data-testid="wallet-play-chip">{info?.play === null || info?.play === undefined ? '…' : `${info.play.toFixed(2)} USDC`}</span>
        </button>
      </header>
      <main>
        {match && signer ? <TableScreen key={path} table={match[1]} nonce={Number(match[2])} me={signer.publicKey.toBase58()} signer={signer} refresh={refresh} openWallet={() => setWalletOpen(true)} />
          : match ? <p className="center-note">Opening your wallet…</p> : <Home info={info} refresh={refresh} openWallet={() => setWalletOpen(true)} />}
      </main>
      {walletOpen && <WalletSheet info={info} signer={signer} refresh={refresh} onClose={() => setWalletOpen(false)} />}
      <footer className="footer">Devnet test USDC only. Every table, roll and payout runs on a MagicBlock rollup; there is no game server.</footer>
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

function Home({ info, refresh, openWallet }: { info?: WalletInfo; refresh: () => void; openWallet: () => void }) {
  return (
    <div className="home">
      <section className="hero">
        <div>
          <h1>Roll, buy, trade.<br />First to the target takes the pot.</h1>
          <p>A board game for 2 to 4 friends playing for devnet USDC. Each player pays the entry, and the pot pays out by rank.
            No SOL needed, ever.</p>
        </div>
        <div className="seal"><Payouts /></div>
      </section>
      <Resume />
      <div className="home-grid">
        <OpenTableForm info={info} refresh={refresh} openWallet={openWallet} />
        <OpenTables />
      </div>
    </div>
  );
}

function Payouts() {
  return (
    <table className="payouts" aria-label="Payout by rank">
      <thead><tr><th>Players</th><th>1st</th><th>2nd</th><th>3rd</th></tr></thead>
      <tbody>{[2, 3, 4].map(count => <tr key={count}><td>{count}</td>{[0, 1, 2].map(place => <td key={place}>{SHARES_BPS[count][place] ? `${SHARES_BPS[count][place] / 100}%` : ''}</td>)}</tr>)}</tbody>
      <tfoot><tr><td colSpan={4}>{PROTOCOL_FEE_BPS / 100}% goes to the house.</td></tr></tfoot>
    </table>
  );
}

function Resume() {
  const [game, setGame] = useState<{ path: string; view: TableView }>();
  useEffect(() => {
    const path = lastGamePath(), match = path && /^\/play\/(\w+)\/(\d+)$/.exec(path);
    if (!match) return;
    void client.readTable(new PublicKey(match[1])).then(view => { if (view.gameNonce === Number(match[2]) && view.phase !== 'free') setGame({ path: path!, view }); }, () => {});
  }, []);
  if (!game) return null;
  return (
    <section className="panel resume" data-testid="resume">
      <p>You have a game in progress at table {game.view.index + 1} ({game.view.phase}).</p>
      <button className="btn primary" onClick={() => navigate(game.path)}>Back to your game</button>
    </section>
  );
}

function OpenTableForm({ info, refresh, openWallet }: { info?: WalletInfo; refresh: () => void; openWallet: () => void }) {
  const { busy, error, run } = useBusy();
  const [name, setName] = useState(''), [entry, setEntry] = useState<number>(ENTRIES[0]), [players, setPlayers] = useState(2), [target, setTarget] = useState(defaultTarget(2));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => { const opened = await openTable({ name: name.trim(), entry, maxPlayers: players, target }); refresh(); navigate(`/play/${opened.table}/${opened.nonce}`); });
  };
  const short = info?.play !== null && info?.play !== undefined && info.play * 1e6 < entry;
  return (
    <form className="panel open-form" onSubmit={submit} data-testid="open-form">
      <h2>Open a table</h2>
      <label>Your name<input data-testid="open-name" required maxLength={16} value={name} onChange={event => setName(event.target.value)} autoComplete="nickname" /></label>
      <fieldset><legend>Entry</legend><div className="segmented">{ENTRIES.map(value => (
        <label key={value} className={entry === value ? 'on' : ''}><input type="radio" name="entry" data-testid={`open-entry-${value}`} checked={entry === value} onChange={() => setEntry(value)} />{usdc(value)} USDC</label>))}</div></fieldset>
      <fieldset><legend>Players</legend><div className="segmented">{[2, 3, 4].map(count => (
        <label key={count} className={players === count ? 'on' : ''}><input type="radio" name="players" data-testid={`open-players-${count}`} checked={players === count}
          onChange={() => { setPlayers(count); setTarget(defaultTarget(count)); }} />{count}</label>))}</div></fieldset>
      <fieldset><legend>First to this net worth wins</legend><div className="segmented">{board.rules.targets.map(value => (
        <label key={value} className={target === value ? 'on' : ''}><input type="radio" name="target" data-testid={`open-target-${value}`} checked={target === value} onChange={() => setTarget(value)} />{money(value)}</label>))}</div></fieldset>
      <p className="quiet">Opening pays your entry. A lobby that never starts refunds everyone in full. Longer targets make longer games: about 5 minutes for 2 players at $3k, 25 for 4 at $7k.</p>
      <button className="btn primary" data-testid="open-submit" disabled={busy}>{busy ? 'Opening…' : `Open table for ${usdc(entry)} USDC`}</button>
      {short && <p className="quiet">Your play balance is short, so this first moves USDC in from your wallet. <button type="button" className="linkish" onClick={openWallet}>Open wallet</button></p>}
      {error && <p className="error" data-testid="error">{error}</p>}
    </form>
  );
}

function OpenTables() {
  const [tables, setTables] = useState<TableView[]>(), [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = () => listLobbies().then(list => { if (alive) { setTables(list); setError(undefined); } }, failure => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)); });
    void load(); const timer = setInterval(load, 8_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return (
    <section className="panel open-tables" data-testid="open-tables">
      <h2>Tables waiting for players</h2>
      {error && <p className="error">{error}</p>}
      {tables?.length === 0 && <p className="quiet">No open tables right now. Open one and share the link.</p>}
      {!tables && !error && <p className="quiet">Looking…</p>}
      <ul>{tables?.map(table => (
        <li key={table.address}>
          <a href={`/play/${table.address}/${table.gameNonce}`} data-testid={`open-table-${table.index}`} onClick={event => { event.preventDefault(); navigate(`/play/${table.address}/${table.gameNonce}`); }}>
            <span className="seats">{table.seats.map((seat, index) => <i key={seat.wallet} style={{ background: SEAT_COLORS[index] }} />)}{Array.from({ length: table.maxPlayers - table.playerCount }, (_, i) => <i key={`e${i}`} className="empty" />)}</span>
            <span><b>{table.seats[0]?.name}’s table</b><small>{usdc(table.entry)} USDC, first to {money(table.target)}</small></span>
            <span className="join-word">Join</span>
          </a>
        </li>))}</ul>
    </section>
  );
}
