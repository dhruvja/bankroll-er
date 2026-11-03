import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ER_RPC, RELAY_FEE, TOKEN_SCALE, WITHDRAW_MINIMUM, invariant } from '../../../shared/config';
import { BankrollClient, ProgramError, startCrank, type SentTransaction } from '../../../shared/client';
import { SponsoredPayments } from '../../../shared/sponsored';
import { depositForEntry } from '../../../shared/funding';
import { PHASE_OFFSET, PROGRAM_ID, decodeTable, idl, type TableView } from '../../../shared/chain';
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

/** Moves base USDC into play when the entry needs it (sponsored, zero SOL). */
async function fundEntry(owner: Keypair, entry: number) {
  await paymentLock(owner.publicKey.toBase58(), async () => {
    invariant(!payments.pending(owner.publicKey.toBase58()), 'A sponsored transfer is still pending. Refresh your wallet first.');
    const balances = await client.walletBalances(owner.publicKey);
    if (balances.er < BigInt(entry)) await payments.execute(owner, 'deposit', depositForEntry(balances.base, balances.er, BigInt(entry)));
  });
}

export async function openTable(options: { name: string; entry: number; maxPlayers: number; target: number }) {
  const host = await wallet();
  await fundEntry(host, options.entry);
  for (const table of await client.findFreeTables()) {
    try {
      const address = new PublicKey(table.address);
      record(await client.openTable(address, host, options));
      return { table: table.address, nonce: (await client.readTable(address)).gameNonce };
    } catch (error) {
      // Another host claimed this table between the read and the send; try the next one.
      if (!(error instanceof ProgramError && error.message.startsWith('InvalidPhase'))) throw error;
    }
  }
  throw new Error('Every table is busy. Try again in a few minutes.');
}

export async function joinTable(table: string, nonce: number, name: string, entry: number) {
  const player = await wallet();
  await fundEntry(player, entry);
  record(await client.joinTable(new PublicKey(table), player, nonce, name));
}

type Action = 'start' | 'roll' | 'buy' | 'pass' | 'bail' | 'cancel';
export async function act(table: string, action: Action) {
  const signer = await wallet(), address = new PublicKey(table);
  const run = { start: client.startGame, roll: client.roll, buy: client.buy, pass: client.pass, bail: client.payBail, cancel: client.cancel }[action];
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
function record(sent: SentTransaction) { sentLabels.set(sent.signature, sent.label); console.debug('bankroll sent', sent.label, sent.signature); return sent; }
export const sentLabel = (signature: string) => sentLabels.get(signature);

/** Tables waiting for players (phase Lobby), read straight from the rollup. */
export async function listLobbies(): Promise<TableView[]> {
  await client.verifyPublicRollup();
  const discriminator = idl.accounts!.find(item => item.name === 'Table')!.discriminator;
  const accounts = await client.er.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters: [
    { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(discriminator)) } },
    { memcmp: { offset: PHASE_OFFSET, bytes: bs58.encode(Buffer.from([1])) } },
  ] });
  const now = Date.now() / 1000, tables: TableView[] = [];
  for (const { pubkey, account } of accounts) {
    try { tables.push(decodeTable(pubkey, account.data)); } catch { /* Not a canonical table. */ }
  }
  return tables.filter(table => table.phase === 'lobby' && table.lobbyDeadline > now && table.playerCount < table.maxPlayers).sort((a, b) => a.index - b.index);
}

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

/** Whether `owner`'s play balance can receive a payout right now (mirrors the program's check). */
export const canReceive = (owner: string) => client.payable(new PublicKey(owner));

/** Plain-language versions of the program errors a player can hit. */
const FRIENDLY: Record<string, string> = {
  IdleDeadlinePassed: 'This game timed out after an hour without a move. It is ending by ranking now.',
  InvalidStage: 'The table moved on before your move landed.',
  TooEarly: 'That can’t happen yet. Wait for the timer.',
  InsufficientCash: 'Not enough cash for that.',
  CannotBuild: 'You need the whole color group and cash for the building.',
  CannotTrade: 'Only properties without buildings can be traded.',
  OffersClosed: 'Offers have closed for this trade.',
  OfferChanged: 'That offer was just replaced. Pick from the current offers.',
  LobbyClosed: 'This lobby has closed.',
  TableFull: 'This table is full.',
  AlreadyJoined: 'You are already at this table.',
  StaleNonce: 'This invite is for an earlier game at this table.',
  NotEnoughPlayers: 'At least two players need to join first.',
  Unauthorized: 'It isn’t your move.',
};
export function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const name = /^([A-Za-z]+) \(\d+\)$/.exec(text)?.[1];
  return name && FRIENDLY[name] ? FRIENDLY[name] : text;
}
