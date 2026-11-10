import bs58 from 'bs58';
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from '@solana/spl-token';
import { DEMO_ENTRY, DEVNET_USDC, ER_RPC, RELAY_FEE, TOKEN_SCALE, WITHDRAW_MINIMUM, invariant } from '../../../shared/config';
import { BankrollClient, startCrank, type SentTransaction } from '../../../shared/client';
import { SponsoredPayments } from '../../../shared/sponsored';
import { depositForEntry } from '../../../shared/funding';
import { CLOSE_GRACE_SECONDS, PROGRAM_ID, decodeTable, tokenAddress, type TableView } from '../../../shared/chain';
import { openWallet } from './wallet';

export const client = new BankrollClient({ baseRpc: import.meta.env.VITE_BANKROLL_BASE_RPC });
const payments = new SponsoredPayments(client, localStorage);
let walletPromise: Promise<Keypair> | undefined;
export const wallet = () => walletPromise ??= openWallet().catch(error => { walletPromise = undefined; throw error; });

export interface WalletInfo { address: string; play: number | null; base: number | null; sol: number | null; pending: boolean; status?: string }

async function paymentLock<T>(owner: string, action: () => Promise<T>) {
  invariant(navigator.locks, 'Use a current browser with Web Locks for sponsored USDC transfers.');
  return navigator.locks.request(`bankroll-payment-${owner}`, action);
}

export async function getWalletInfo(): Promise<WalletInfo> {
  const keypair = await wallet(), address = keypair.publicKey.toBase58();
  let status: string | undefined;
  try {
    if (payments.pending(address)) await navigator.locks.request(`bankroll-payment-${address}`, { ifAvailable: true }, async lock => {
      if (lock) await payments.reconcile(keypair.publicKey, true);
    });
  } catch (error) { status = error instanceof Error ? error.message : 'Unable to check the pending transfer.'; }
  const pending = payments.pending(address);
  try {
    const balances = await client.walletBalances(keypair.publicKey);
    return { address, play: Number(balances.er) / TOKEN_SCALE, base: Number(balances.base) / TOKEN_SCALE, sol: balances.lamports / 1e9, pending,
      status: status ?? (pending ? 'Sponsored transfer pending. Checking its saved receipt…' : undefined) };
  } catch (error) {
    return { address, play: null, base: null, sol: null, pending, status: status ?? (error instanceof Error ? error.message : 'Unable to read balances.') };
  }
}

export async function deposit(amount?: number) {
  const owner = await wallet();
  return paymentLock(owner.publicKey.toBase58(), async () => {
    const balances = await client.walletBalances(owner.publicKey);
    const atoms = amount === undefined ? balances.base - BigInt(RELAY_FEE * 2) : BigInt(Math.round(amount * TOKEN_SCALE));
    await payments.execute(owner, 'deposit', atoms);
  });
}

export async function withdraw(amount: number) {
  invariant(Number.isFinite(amount) && amount * TOKEN_SCALE >= WITHDRAW_MINIMUM && amount <= 1000, 'Enter between 0.50 and 1,000 USDC.');
  const owner = await wallet();
  return paymentLock(owner.publicKey.toBase58(), () => payments.execute(owner, 'withdraw', BigInt(Math.round(amount * TOKEN_SCALE))));
}

/** Devnet play-money faucet. Its key ships in the bundle on purpose, so anyone can drain it; keep it topped up. */
const faucetSecret = import.meta.env.VITE_BANKROLL_FAUCET_SECRET as string | undefined;
const faucet = faucetSecret ? Keypair.fromSecretKey(bs58.decode(faucetSecret)) : undefined;

/** Moves base USDC into play when the entry needs it (sponsored, zero SOL). For a demo entry, a wallet
 * without enough base USDC for that deposit and its two relay fees is first topped up from the faucet;
 * USDC-mode entries are always the player's own money. */
async function fundEntry(owner: Keypair, entry: number) {
  await paymentLock(owner.publicKey.toBase58(), async () => {
    invariant(!payments.pending(owner.publicKey.toBase58()), 'A sponsored transfer is still pending. Refresh your wallet first.');
    let balances = await client.walletBalances(owner.publicKey);
    if (balances.er >= BigInt(entry)) return;
    const shortfall = BigInt(entry) - balances.er, deposit = shortfall > 500_000n ? shortfall : 500_000n;
    const needed = deposit + BigInt(RELAY_FEE * 2);
    if (faucet && entry === DEMO_ENTRY && balances.base < needed) {
      const mint = new PublicKey(DEVNET_USDC), to = tokenAddress(owner.publicKey);
      const topUp = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, to, owner.publicKey, mint),
        createTransferInstruction(tokenAddress(faucet.publicKey), to, faucet.publicKey, needed - balances.base));
      try { await sendAndConfirmTransaction(client.base, topUp, [faucet]); }
      catch { throw new Error('Bankroll can’t seat new players right now. Try again in a few minutes.'); }
      balances = await client.walletBalances(owner.publicKey);
    }
    await payments.execute(owner, 'deposit', depositForEntry(balances.base, balances.er, BigInt(entry)));
  });
}

/** Opens the host's own table: the rollup creates it the first time, and after a game it re-opens in
 * place with a new nonce. A wallet hosts one table at a time, so a table of yours that is still in a
 * game comes back as `hosting` (nothing is paid or sent) for the page to offer a way back to it. If
 * SOL sent to your table address blocks the create, the faucet sweeps it and the open is retried. */
export async function openTable(options: { name: string; entry: number; maxPlayers: number; target: number; theme: number; startCash: number })
  : Promise<{ table: string; nonce: number; hosting?: TableView }> {
  const host = await wallet(), hosted = await client.findTable(host.publicKey);
  if (hosted && hosted.phase !== 'free') return { table: hosted.address, nonce: hosted.gameNonce, hosting: hosted };
  await fundEntry(host, options.entry);
  const opened = record(await client.openTable(host, options, faucet));
  return { table: opened.table.toBase58(), nonce: (await client.readTable(opened.table)).gameNonce };
}

/** Your own table when it exists. One that sits Free past its close grace is closed on the way (its rent
 * goes back to the house); the table page's crank normally does that, but only while someone has it open. */
export async function hostedTable(): Promise<TableView | undefined> {
  const host = await wallet(), hosted = await client.findTable(host.publicKey);
  if (hosted?.phase === 'free' && hosted.held === 0 && hosted.freedAt > 0 && Date.now() / 1000 > hosted.freedAt + CLOSE_GRACE_SECONDS + 5) {
    void client.closeTable(new PublicKey(hosted.address), host).then(record, () => {});
    return undefined;
  }
  return hosted;
}

export async function joinTable(table: string, nonce: number, name: string, entry: number) {
  const player = await wallet();
  await fundEntry(player, entry);
  record(await client.joinTable(new PublicKey(table), player, nonce, name));
}

type Action = 'start' | 'roll' | 'buy' | 'pass' | 'bail' | 'cancel' | 'forfeit';
export async function act(table: string, action: Action) {
  const signer = await wallet(), address = new PublicKey(table);
  const run = { start: client.startGame, roll: client.roll, buy: client.buy, pass: client.pass, bail: client.payBail, cancel: client.cancel, forfeit: client.forfeit }[action];
  return record(await run.call(client, address, signer));
}

/** Build on or sell one of your properties (space index). */
export async function property(table: string, action: 'build' | 'sell', space: number) {
  const signer = await wallet(), address = new PublicKey(table);
  return record(await (action === 'build' ? client.build(address, signer, space) : client.sell(address, signer, space)));
}

/** Auction trade: the lander opens with one of its unbuilt properties; other seats offer one back. */
export async function trade(table: string, action: 'open' | 'offer', space: number) {
  const signer = await wallet(), address = new PublicKey(table);
  return record(await (action === 'open' ? client.openTrade(address, signer, space) : client.offerTrade(address, signer, space)));
}

/** The lander accepts `seat`'s current offer of `space`. */
export async function acceptTrade(table: string, seat: number, space: number) {
  return record(await client.acceptTrade(new PublicKey(table), await wallet(), seat, space));
}

export const subscribeTable = (table: string, onTable: (view: TableView) => void, onError: (error: Error) => void) =>
  client.subscribeTable(new PublicKey(table), onTable, onError);

/** Liveness for every participant tab: timeouts, VRF retries, settle, expiry and refunds. */
export function runCrank(table: string, signer: Keypair) {
  return startCrank(client, new PublicKey(table), signer, record);
}

/** Signatures this tab sent, with what they did, so the transaction log can name them. */
const sentLabels = new Map<string, string>();
function record<T extends SentTransaction>(sent: T): T { sentLabels.set(sent.signature, sent.label); console.debug('bankroll sent', sent.label, sent.signature); return sent; }
export const sentLabel = (signature: string) => sentLabels.get(signature);

/** Tables waiting for players (phase Lobby), read straight from the rollup, soonest deadline first. */
export const listLobbies = (): Promise<TableView[]> => client.listLobbies(Date.now() / 1000);

/** The table, or undefined once it is gone: closed after its grace, or an account that is not an
 * ephemeral table at all (a link to the retired table pool). */
export async function readTable(table: string): Promise<TableView | undefined> {
  const address = new PublicKey(table), account = await client.er.getAccountInfo(address, 'confirmed');
  if (!account?.owner.equals(PROGRAM_ID)) return undefined;
  try { return decodeTable(address, account.data); } catch { return undefined; }
}

/** Whether `owner`'s play balance can receive a payout right now (mirrors the program's check). */
export const canReceive = (owner: string) => client.payable(new PublicKey(owner));

export interface TableTransaction { signature: string; err: boolean; time: number | null; label?: string; explorer: string }
const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(ER_RPC)}`;

/** The latest rollup transactions that touched the table (every player's, plus VRF callbacks). */
export async function tableTransactions(table: string, limit = 40): Promise<TableTransaction[]> {
  const entries = await client.er.getSignaturesForAddress(new PublicKey(table), { limit }, 'confirmed');
  return entries.map(entry => ({ signature: entry.signature, err: entry.err !== null, time: entry.blockTime ?? null, label: sentLabel(entry.signature), explorer: explorer(entry.signature) }));
}
/** Live push of table transactions as they confirm. */
export function watchTableTransactions(table: string, onTransaction: (transaction: TableTransaction) => void) {
  const id = client.er.onLogs(new PublicKey(table), logs => onTransaction({ signature: logs.signature, err: logs.err !== null, time: Date.now() / 1000,
    label: sentLabel(logs.signature), explorer: explorer(logs.signature) }), 'confirmed');
  return () => { void client.er.removeOnLogsListener(id).catch(() => {}); };
}

/** Plain-language versions of the program errors a player can hit. */
const FRIENDLY: Record<string, string> = {
  IdleDeadlinePassed: 'This game timed out after an hour without a move. It is ending by ranking now.',
  InvalidStage: 'The table moved on before your move landed.',
  TooEarly: 'That can’t happen yet. Wait for the timer.',
  InsufficientCash: 'Not enough cash for that.',
  CannotBuild: 'You need the whole color group, cash for the building, and no hotel there yet.',
  CannotTrade: 'Only properties without buildings can be traded.',
  OffersClosed: 'Offers have closed for this trade.',
  OfferChanged: 'That offer was just replaced. Pick from the current offers.',
  LobbyClosed: 'This lobby has closed.',
  TableFull: 'This table is full.',
  AlreadyJoined: 'You are already at this table.',
  StaleNonce: 'This invite is for an earlier game at this table.',
  NotEnoughPlayers: 'At least two players need to join first.',
  HouseOutOfRent: 'Bankroll can’t open new tables right now. Try again in a few minutes.',
  Unauthorized: 'It isn’t your move.',
};
export function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const name = /^([A-Za-z]+) \(\d+\)$/.exec(text)?.[1];
  return name && FRIENDLY[name] ? FRIENDLY[name] : text;
}
