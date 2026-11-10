/**
 * G12 capacity smoke: `--tables N` (default 25) zero-SOL hosts open their own tables at once and one
 * zero-SOL joiner takes a seat at every table, so N two-player games run concurrently on the ER for
 * the demo entry. Every seat rolls at least 3 times (each VRF callback observed), then a forfeit
 * ends each game (the joiner forfeits at even tables, the host at odd ones), it settles exactly,
 * and after the real 10-minute close grace a fresh zero-SOL wallet closes every table. The house
 * rent, liability and vault must return to where they started, every wallet's play balance must
 * move by exactly its payouts less its entries, and every wallet must still hold 0 SOL.
 * Wallets come from `.env` (CAPACITY_HOST_<n>, CAPACITY_JOINER_1) and are created there if missing.
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { DEMO_ENTRY, invariant } from '../shared/config';
import { CLOSE_GRACE_SECONDS, PROGRAM_ID, TABLE_RENT, currentSeat, expectedPayouts, houseAddress, tableAddress, treasuryAddress, type TableView } from '../shared/chain';
import { board } from '../shared/board';
import { ProgramError, type SentTransaction } from '../shared/client';
import { client, filePayments, flags, fundPlayers, lamports, loadAdmin, loadWallets, readDeployment, readHouseStatus, requireDevnet, saveArtifact } from './node';

const args = flags();
const count = Number(args.value('tables') ?? 25), rollsPerSeat = Number(args.value('rolls') ?? 3), entry = DEMO_ENTRY, entryAtoms = BigInt(entry);
invariant(Number.isInteger(count) && count >= 1 && count <= 50 && Number.isInteger(rollsPerSeat) && rollsPerSeat >= 1, 'Use --tables 1-50 and --rolls >= 1.');
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
const RACE = /^(InvalidStage|TooEarly|InvalidPhase|Unauthorized) /;

await requireDevnet();
readDeployment();
const runStart = Date.now();
const admin = loadAdmin(), hosts = loadWallets('CAPACITY_HOST_', count), [joiner] = loadWallets('CAPACITY_JOINER_', 1), closer = Keypair.generate();
const wallets = [...hosts, joiner], tables = hosts.map(host => tableAddress(host.publicKey));
const { payments, signatures: paymentSignatures } = filePayments();
const base: Record<string, string> = {};
const adminBefore = { lamports: await client.base.getBalance(admin.publicKey), usdc: (await client.walletBalances(admin.publicKey)).base };
const fundingStart = Date.now();
await fundPlayers(wallets, admin, payments, [...hosts.map(() => entryAtoms), entryAtoms * BigInt(count)], base, 6);
const fundingMs = Date.now() - fundingStart;
for (const table of tables) invariant(!(await client.er.getAccountInfo(table)), `${table.toBase58()} already exists; wait for its close grace and close it first.`);

const ledger = async () => {
  const [balances, treasury, vault, house] = await Promise.all([Promise.all(wallets.map(wallet => client.erTokenBalance(wallet.publicKey))),
    client.erTokenBalance(treasuryAddress()), client.erTokenBalance(houseAddress()), client.readHouse()]);
  return { balances, treasury, vault, house };
};
const startStatus = await readHouseStatus();
invariant(startStatus.ok, `House status before the run: ${json(startStatus)}`);
invariant(startStatus.house.capacity >= count, `The house can sponsor only ${startStatus.house.capacity} more tables.`);
const start = await ledger();

/** Latency samples per step, in ms. */
const samples: Record<string, number[]> = { open: [], join: [], start: [], orderCallback: [], roll: [], rollToCallback: [], forfeit: [], settle: [], close: [] };
const retries: { table: number; label: string; error: string }[] = [];
const sent: SentTransaction[] = [];
const timed = async (step: string, run: () => Promise<SentTransaction>) => {
  const tx = await run();
  sent.push(tx); samples[step].push(tx.confirmedAt - tx.sentAt);
  return tx;
};
/** Retries an action that lost a race with the chain or hit a transient RPC error; anything else fails. */
async function act(table: number, label: string, step: string, run: () => Promise<SentTransaction>): Promise<SentTransaction | undefined> {
  try { return await timed(step, run); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProgramError && !RACE.test(message)) throw new Error(`table ${table} ${label}: ${message} (${error.signature})`);
    retries.push({ table, label, error: message.slice(0, 200) });
    await pause(400 + Math.random() * 600);
    return undefined;
  }
}
const readTable = async (address: PublicKey) => {
  for (let attempt = 0; ; attempt++) {
    try { return await client.readTable(address); } catch (error) { if (attempt === 5) throw error; await pause(500); }
  }
};

// 1. Open every table at once: the house creates each one and pays its rent.
const phaseMs: Record<string, number> = {};
let mark = Date.now();
await Promise.all(hosts.map((host, index) => timed('open', () => client.openTable(host, { name: `Host ${index + 1}`, entry, maxPlayers: 2, target: 2500 }))));
phaseMs.open = Date.now() - mark;
const opened = await Promise.all(tables.map(readTable));
const afterOpen = await client.readHouse();
const nonces = opened.map(view => view.gameNonce);

// 2. The joiner takes a seat at every table; 3. every host starts its game.
mark = Date.now();
await Promise.all(tables.map((table, index) => timed('join', () => client.joinTable(table, joiner, nonces[index], 'Joiner'))));
phaseMs.join = Date.now() - mark;
const inGame = await ledger();

interface TableRun { index: number; address: string; vrfRolls: number[]; jailRolls: number; forfeiter: 'host' | 'joiner'; finished: TableView; settle: string; ms: number }
async function play(index: number): Promise<TableRun> {
  const address = tables[index], seats = [hosts[index], joiner], forfeiterSeat = index % 2 === 0 ? 1 : 0, began = Date.now();
  const vrfRolls = [0, 0];
  let jailRolls = 0, forfeited = false;
  const started = await timed('start', () => client.startGame(address, hosts[index]));
  let view = await readTable(address);
  // Turn order: wait for the callback that leaves Ordering.
  while (view.phase === 'playing' && view.stage === 'ordering') {
    if (Date.now() / 1000 > view.vrfRequestedAt + board.rules.deadlinesSec.vrfRetry + 1) await act(index, 'retry-start', 'start', () => client.startGame(address, hosts[index]));
    else await pause(150);
    view = await readTable(address);
  }
  samples.orderCallback.push(Date.now() - started.sentAt);
  invariant(view.phase === 'playing', `table ${index} did not start: ${view.phase}`);
  while (view.phase === 'playing') {
    invariant(Date.now() - began < 20 * 60_000, `table ${index} did not finish within 20 minutes`);
    const seat = currentSeat(view), actor = seats[seat];
    if (view.stage === 'preroll' && !forfeited && vrfRolls.every(rolls => rolls >= rollsPerSeat)) {
      forfeited = !!(await act(index, 'forfeit', 'forfeit', () => client.forfeit(address, seats[forfeiterSeat])));
    } else if (view.stage === 'preroll') {
      const jailed = view.seats[seat].jailTurns > 0, before = view.vrfNonce;
      const rolled = await act(index, 'roll', 'roll', () => client.roll(address, actor));
      if (rolled && jailed) jailRolls++;
      if (rolled && !jailed) {
        // The roll asked for randomness: wait for the callback that consumes it.
        for (view = await readTable(address); view.vrfNonce === before || view.stage === 'rolling'; view = await readTable(address)) {
          if (Date.now() / 1000 > view.vrfRequestedAt + board.rules.deadlinesSec.vrfRetry + 1 && view.stage === 'rolling') {
            await act(index, 'retry-roll', 'roll', () => client.roll(address, actor));
          } else await pause(150);
        }
        samples.rollToCallback.push(Date.now() - rolled.sentAt);
        vrfRolls[seat]++;
        continue;
      }
    } else if (view.stage === 'rolling' || view.stage === 'ordering') await pause(150);
    else if (view.stage === 'buydecision' || view.stage === 'tradeopen') await act(index, view.stage, 'roll', () => client.pass(address, actor));
    else if (view.stage === 'tradeoffers' && Date.now() / 1000 > view.stageDeadline + 1) await act(index, 'timeout', 'roll', () => client.forceTimeout(address, seats[(seat + 1) % 2]));
    else await pause(300);
    view = await readTable(address);
  }
  invariant(view.phase === 'finished', `table ${index} ended in ${view.phase}`);
  const finished = view;
  let settle: SentTransaction | undefined;
  while (!settle) settle = await act(index, 'settle', 'settle', () => client.settle(address, hosts[index], finished));
  return { index, address: address.toBase58(), vrfRolls, jailRolls, forfeiter: forfeiterSeat === 0 ? 'host' : 'joiner', finished, settle: settle.signature, ms: Date.now() - began };
}

mark = Date.now();
const runs = await Promise.all(tables.map((_, index) => play(index)));
phaseMs.play = Date.now() - mark;

// Settlement is exact at every table, and the vault paid out everything it took in.
const expected = runs.map(run => expectedPayouts(run.finished));
const feeTotal = expected.reduce((sum, item) => sum + BigInt(item.treasury), 0n);
let afterSettle = await ledger(), views = await Promise.all(tables.map(readTable));
const settleAssertions = () => ({
  everyTableStarted: runs.length === count, // play() asserts each table left Ordering into Playing
  everySeatRolled: runs.every(run => run.vrfRolls.every(rolls => rolls >= rollsPerSeat)),
  endedByForfeit: runs.every(run => run.finished.seats.filter(seat => seat.eliminatedAt > 0).length === 1),
  tablesFree: views.every(view => view.phase === 'free' && view.held === 0 && view.freedAt > 0),
  payoutsRecorded: views.every((view, index) => view.seats.every((seat, at) => seat.payout === expected[index].payouts[at])),
  liabilityBack: afterSettle.house.liability === start.house.liability,
  vaultBack: afterSettle.vault === start.vault,
  treasuryExact: afterSettle.treasury - start.treasury === feeTotal,
});
for (let poll = 0; poll < 40 && !Object.values(settleAssertions()).every(Boolean); poll++) {
  await pause(500);
  [afterSettle, views] = await Promise.all([ledger(), Promise.all(tables.map(readTable))]);
}
const settled = settleAssertions();
invariant(Object.values(settled).every(Boolean), `Settlement mismatch: ${json({ settled, expected, afterSettle, views })}`);

// Close every table after the real grace, from a wallet that never played and holds no SOL.
let earlyClose: string | undefined;
try { await client.closeTable(tables[0], closer); } catch (error) {
  invariant(error instanceof ProgramError && /^TooEarly /.test(error.message), `Unexpected early-close error: ${String(error)}`);
  earlyClose = error.message;
}
invariant(earlyClose, 'A table closed inside its grace.');
const closableAt = Math.max(...views.map(view => view.freedAt)) + CLOSE_GRACE_SECONDS;
for (let erNow = await client.erNow(); erNow < closableAt + 1; erNow = await client.erNow()) {
  console.log(`waiting ${closableAt + 1 - erNow} s for the close grace`);
  await pause(Math.min(30_000, Math.max(1_000, (closableAt + 1 - erNow) * 1000)));
}
mark = Date.now();
await Promise.all(tables.map(async (table, index) => {
  for (let attempt = 0; !(await act(index, 'close', 'close', () => client.closeTable(table, closer))); attempt++) invariant(attempt < 5, `table ${index} did not close`);
}));
phaseMs.close = Date.now() - mark;

let end = await ledger(), accounts = await client.er.getMultipleAccountsInfo(tables, 'confirmed');
const payoutOf = (wallet: number) => wallet < count ? BigInt(expected[wallet].payouts[0]) - entryAtoms
  : expected.reduce((sum, item) => sum + BigInt(item.payouts[1]) - entryAtoms, 0n);
const endAssertions = () => ({
  tablesClosed: accounts.every(account => !account || !account.owner.equals(PROGRAM_ID)),
  houseRentRestored: end.house.lamports === start.house.lamports,
  rentChargedPerTable: start.house.lamports - afterOpen.lamports === count * TABLE_RENT,
  tablesCreated: end.house.tablesCreated === start.house.tablesCreated + BigInt(count),
  liabilityBack: end.house.liability === start.house.liability,
  vaultBack: end.vault === start.vault,
  balancesExact: wallets.every((_, wallet) => end.balances[wallet] - start.balances[wallet] === payoutOf(wallet)),
});
for (let poll = 0; poll < 40 && !Object.values(endAssertions()).every(Boolean); poll++) {
  await pause(500);
  [end, accounts] = await Promise.all([ledger(), client.er.getMultipleAccountsInfo(tables, 'confirmed')]);
}
const closed = endAssertions();
const lamportsAfter = await Promise.all([...wallets, closer].map(wallet => lamports(wallet.publicKey)));
const zeroSol = lamportsAfter.every(value => value.base === 0 && value.er === 0);
const endStatus = await readHouseStatus();
const ok = Object.values(settled).every(Boolean) && Object.values(closed).every(Boolean) && zeroSol && endStatus.ok;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return sorted.length ? { n: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] } : { n: 0 };
};
console.log(saveArtifact('capacity.json', {
  ok, at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), tables: count, seats: count * 2, rollsPerSeat, entry, wallets: wallets.length,
  assertions: { ...settled, ...closed, zeroSol, statusOk: endStatus.ok, earlyCloseRefused: true },
  latencyMs: Object.fromEntries(Object.entries(samples).map(([step, values]) => [step, stats(values)])),
  phaseMs: { funding: fundingMs, ...phaseMs, total: Date.now() - runStart }, retries,
  house: { start: start.house, afterOpen, end: end.house, liabilityEnd: end.house.liability }, vault: { start: start.vault, inGame: inGame.vault, end: end.vault },
  treasury: { start: start.treasury, end: end.treasury, fees: feeTotal },
  perTable: runs.map(run => ({ index: run.index, address: run.address, vrfRolls: run.vrfRolls, jailRolls: run.jailRolls, rounds: run.finished.round,
    forfeiter: run.forfeiter, payouts: expected[run.index].payouts, settle: run.settle, ms: run.ms })),
  walletsDetail: wallets.map((wallet, index) => ({ wallet: wallet.publicKey.toBase58(), role: index < count ? `host ${index + 1}` : 'joiner',
    erStart: start.balances[index], erEnd: end.balances[index], lamports: lamportsAfter[index] })),
  closer: closer.publicKey.toBase58(), closableAt, earlyClose,
  signatures: { base, payments: paymentSignatures, er: sent.length },
  admin: { lamportsSpent: adminBefore.lamports - await client.base.getBalance(admin.publicKey), usdcSpent: adminBefore.usdc - (await client.walletBalances(admin.publicKey)).base },
}));
if (!ok) process.exit(1);
