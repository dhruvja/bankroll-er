import { useEffect, useState, type FormEvent } from 'react';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { defaultTarget } from '../../shared/board';
import { ENTRIES } from '../../shared/config';
import type { TableView } from '../../shared/chain';
import { client, listLobbies, openTable, wallet } from './lib/game';
import { GROUP_COLORS, SEAT_COLORS, money } from './Board';
import { THEMES, spacesFor } from '../../shared/themes';
import { TableScreen, lastGamePath, navigate, useBusy } from './Table';

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const update = () => setPath(location.pathname); addEventListener('popstate', update); return () => removeEventListener('popstate', update); }, []);
  return path;
}

export default function App() {
  const path = usePath(), match = /^\/play\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(\d+)$/.exec(path);
  const [signer, setSigner] = useState<Keypair>();
  useEffect(() => { void wallet().then(setSigner); }, []);
  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/" onClick={event => { event.preventDefault(); navigate('/'); }}>Bankroll</a>
      </header>
      <main>
        {match && signer ? <TableScreen key={path} table={match[1]} nonce={Number(match[2])} me={signer.publicKey.toBase58()} signer={signer} />
          : match ? <p className="center-note">Getting your seat ready…</p> : <Home />}
      </main>
      <footer className="footer">Free to play. Every table, roll and move runs live on a MagicBlock ephemeral rollup; there is no game server.</footer>
    </>
  );
}

function Home() {
  return (
    <div className="home">
      <section className="hero">
        <h1>Roll, buy, trade.<br />Beat your friends.</h1>
        <p>A board game for 2 to 4 friends. Pick a board, open a table, send the link. Free, nothing to sign up for or install.</p>
      </section>
      <Resume />
      <div className="home-grid">
        <OpenTableForm />
        <OpenTables />
      </div>
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
              {[1, 19, 23].map(index => <span key={index} style={{ borderColor: GROUP_COLORS[spaces[index].group ?? 'Public'] }}>{spaces[index].name}</span>)}
            </span>
          </label>
        );
      })}</div>
    </fieldset>
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

function OpenTableForm() {
  const { busy, error, run } = useBusy();
  const [name, setName] = useState(''), [players, setPlayers] = useState(2), [theme, setTheme] = useState(0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const opened = await openTable({ name: name.trim(), entry: ENTRIES[0], maxPlayers: players, target: defaultTarget(players), theme });
      navigate(`/play/${opened.table}/${opened.nonce}`);
    });
  };
  return (
    <form className="panel open-form" onSubmit={submit} data-testid="open-form">
      <h2>Open a table</h2>
      <ThemePicker theme={theme} onChange={setTheme} />
      <label>Your name<input data-testid="open-name" required maxLength={16} value={name} onChange={event => setName(event.target.value)} autoComplete="nickname" /></label>
      <fieldset><legend>Players</legend><div className="segmented">{[2, 3, 4].map(count => (
        <label key={count} className={players === count ? 'on' : ''}><input type="radio" name="players" data-testid={`open-players-${count}`} checked={players === count}
          onChange={() => setPlayers(count)} />{count}</label>))}</div></fieldset>
      <p className="quiet">First to {money(defaultTarget(players))} net worth wins. You get an invite link to share once the table is open.</p>
      <button className="btn primary" data-testid="open-submit" disabled={busy}>{busy ? 'Opening…' : 'Open table'}</button>
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
            <span><b>{table.seats[0]?.name}’s table</b><small>{THEMES[table.theme]?.name ?? 'Classic'} board, first to {money(table.target)}</small></span>
            <span className="join-word">Join</span>
          </a>
        </li>))}</ul>
    </section>
  );
}
