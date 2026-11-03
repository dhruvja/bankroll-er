# Bankroll on the ER

Bankroll is a board game for 2 to 4 players with a devnet USDC pot. Players roll 1d6 around a 24-space board, buy cities and public
properties, build, sell, go to jail, draw Lucky cards and swap properties on the Auction space. The first player whose net worth
reaches the target ($3k, $5k or $7k) wins, or the last player standing. The pot pays out by rank with a 3% fee.

Every table, turn, die roll and payout runs on a MagicBlock public Ephemeral Rollup. There is no game server. The base layer is
used only for the admin's one-time table bootstrap and for the sponsored USDC deposit and withdraw. Players, the host included,
never need SOL.

- Program: `72xAdhJ15tqVXZ95oKKxBYfEbJpJsDThcMCwwtonibEq` (devnet), Anchor 1.2.0, `ephemeral-rollups-sdk` / `ephemeral-vrf-sdk` 0.17.2.
- Rollup: `https://devnet-as.magicblock.app` (validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`), base RPC `https://rpc.magicblock.app/devnet`.
- Pool: the tables `table_v1` 0–3 with per-table custody, listed in `shared/deployment.json`.

## Layout

| Path | What it holds |
| --- | --- |
| `programs/bankroll/src` | `lib.rs` (instructions and accounts), `engine.rs` (rules), `state.rs` (Table layout), `board.rs` (generated from `shared/board.json`), `tests.rs` and `fuzz.rs` |
| `tests/` | LiteSVM suite (`tests/tests/table.rs`) with devnet fixtures of the VRF program and the ER oracle queue |
| `shared/` | IDL, board, the IDL-driven client (`client.ts`, `chain.ts`), sponsored payments with receipt recovery, operator status |
| `scripts/` | Operator scripts: bootstrap/add-tables, status, drain-check, withdraw-fees, smoke, gen-board |
| `web/` | The React app: board, wallet, open tables, invites, trades, results, transaction log |
| `tests/ts/` | Node tests for the client, payments and status |

## Run the web app

```bash
pnpm install --frozen-lockfile
pnpm build                                                    # typecheck + vite build into dist/
pnpm exec vite preview --config web/vite.config.ts --port 4180
```

Open `http://localhost:4180`. The wallet is a key kept in the browser's IndexedDB, encrypted with a non-extractable WebCrypto key,
so the page needs HTTPS or localhost. Each browser profile has its own wallet. Use **Export recovery file** before you clear site
data. To play, send devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) to the address in the wallet sheet, then
press **Move all into play**. Deposits and withdrawals go through the MagicBlock Payments API: 0.20 USDC per move, a 0.50 USDC
minimum withdrawal, no SOL. `VITE_BANKROLL_BASE_RPC` in `.env` overrides the base RPC.

For local development, `pnpm exec vite --config web/vite.config.ts` serves the same app with hot reload.

## Deploy and bootstrap

The program keypair lives outside git at `~/.config/solana/bankroll-er-program-devnet.json`. The admin and upgrade authority is
`~/.config/solana/id.json` (`653bML…`).

```bash
pnpm build:program                       # cargo build-sbf (v1.57 tools) + anchor idl build -> shared/idl/bankroll.json
pnpm drain-check                         # before any layout-changing upgrade (see the trust model)
solana program extend --url https://rpc.magicblock.app/devnet --keypair ~/.config/solana/id.json \
  72xAdhJ15tqVXZ95oKKxBYfEbJpJsDThcMCwwtonibEq 20480      # only when the .so outgrows program data
pnpm deploy:devnet
pnpm add-tables -- --tables 4            # idempotent: creates, delegates and opens custody only for missing tables
```

`add-tables` (also `pnpm bootstrap`) costs the admin about 0.01 SOL of rent per new table and writes `shared/deployment.json`.

## Operator scripts

All scripts read `.env` and `shared/deployment.json`, always use devnet URLs, and write evidence to
`../plans/bankroll/artifacts/$BANKROLL_PHASE` (default `phase-03`).

| Command | What it does |
| --- | --- |
| `pnpm status` | Read-only pool report: occupancy, the client action each table needs (expired lobby, past idle, awaiting settle, refunds pending), custody against liability, treasury. Exits 1 on any custody shortfall. |
| `pnpm add-tables -- --tables N` | Grow the pool to N tables. Run it when `status` shows 0 or 1 free tables at busy times. |
| `pnpm drain-check` | Passes only when every table is Free with zero custody. |
| `pnpm withdraw-fees [-- --amount ATOMS] [--keep-on-er]` | ADMIN: move treasury fees to the admin's rollup account, then withdraw the admin's whole rollup balance to base. Never run it while a smoke is running. |
| `pnpm smoke -- --check` | Read-only devnet readiness: program, tables routed to the validator, custody, VRF queue. |
| `pnpm smoke -- --execute --players 3 --target 3000 [--trades]` | A bot game with disposable zero-SOL wallets from `.env` (`SMOKE_PLAYER_n`, funded by the admin with USDC). It asserts exact payouts, the fee, custody 0, table Free, zero SOL and a landed withdrawal. |
| `pnpm smoke -- --execute --abandon [--resume]` | Three bots stop playing; after the real 60-minute idle deadline, one transaction from a fresh wallet ends, ranks and settles the game (about 65 minutes). |

Stuck tables need no operator. Any seated client's crank expires lobbies, times out stages, retries VRF, settles, idle-settles and
refunds. `status` names the action a table is waiting for.

## Tests

| Gate | Command |
| --- | --- |
| Economy sim | `python3 -I plans/bankroll/artifacts/phase-01/sim.py --check` (from the workspace root) |
| Engine unit | `RUSTC_WRAPPER= cargo test -p bankroll` |
| Engine fuzz | `RUSTC_WRAPPER= cargo test --release -p bankroll fuzz_ -- --ignored --nocapture` |
| SBF build | `pnpm build:program` |
| LiteSVM | `RUSTC_WRAPPER= cargo test --manifest-path tests/Cargo.toml` (after `build:program`) |
| TypeScript | `pnpm typecheck && pnpm test && pnpm build` |
| Devnet | `pnpm smoke -- --check`, then the `--execute` modes above, then `pnpm drain-check` |

`board.rs` is generated: after editing `shared/board.json`, run `pnpm gen-board`. The board's sha256 is pinned in
`shared/board.ts` and checked by the tests.

## Trust and recovery model

- **The rollup ledger is authoritative.** Tables stay delegated to the public validator and are reused game after game. Nothing
  commits game state to base. A table's USDC sits in its own custody account (an ATA plus an ESPL eATA owned by the table PDA), so
  a fault in one table cannot reach another table's pot.
- **No privileged game key.** Each player's browser wallet signs that player's own moves. Rolls come from MagicBlock VRF: the
  callback is authenticated by the program's scoped VRF identity and uses the randomness at once. Randomness is never stored, so
  nobody can read a future roll from public state.
- **Every game ends.** A game ends at the target, with one player left, or 60 minutes after the last player action. After the
  idle deadline every player action is refused, and any client's single `[force_timeout, settle]` ranks and pays the game. A
  player who misses three stage deadlines forfeits.
- **Payouts.** `settle` pays each seat its ranked share and sends the 3% fee plus rounding dust to the treasury. A seat whose play
  balance can't receive money (closed or undelegated account) does not block the others: settle pays the live seats and leaves
  that seat's share in custody. The seat has 30 minutes to restore its play balance (any deposit does it) and collect. After
  that, the share goes to the treasury; it can never go to anyone else. If settle keeps failing, the table switches to an
  emergency refund in which each seat pulls its ranked share directly.
- **Lobbies refund in full.** A lobby that never starts, or a game whose turn order was never drawn, returns every entry with no fee.
- **Small payouts.** A payout under the 0.50 USDC withdraw minimum stays in the play balance for the next entry.
- **Upgrades.** A redeploy that keeps the Table layout is a hotfix and may ship while tables hold funds, so a settle bug delays
  money but cannot freeze it. A layout change first needs `pnpm drain-check` to pass, then bumps the table seed (`table_v2`)
  and bootstraps a new pool.
- **Wallet recovery.** The key is only in this browser profile. Lose the profile without the recovery file and the play balance is
  lost. A sponsored transfer that was signed but not confirmed is kept as a receipt in local storage and reconciled on the next
  load.
