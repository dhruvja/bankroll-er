import { Keypair, PublicKey } from '@solana/web3.js';
import { RELAY_FEE, TOKEN_SCALE, WITHDRAW_MINIMUM, invariant } from '../../../shared/config';
import { BankrollClient, ProgramError, startCrank } from '../../../shared/client';
import { SponsoredPayments } from '../../../shared/sponsored';
import { depositForEntry } from '../../../shared/funding';
import type { TableView } from '../../../shared/chain';
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
      await client.openTable(address, host, options);
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
  await client.joinTable(new PublicKey(table), player, nonce, name);
}

type Action = 'start' | 'roll' | 'buy' | 'pass' | 'bail' | 'cancel';
export async function act(table: string, action: Action) {
  const signer = await wallet(), address = new PublicKey(table);
  const run = { start: client.startGame, roll: client.roll, buy: client.buy, pass: client.pass, bail: client.payBail, cancel: client.cancel }[action];
  await run.call(client, address, signer);
}

/** Build on or sell one of your properties (space index). */
export async function property(table: string, action: 'build' | 'sell', space: number) {
  const signer = await wallet(), address = new PublicKey(table);
  await (action === 'build' ? client.build(address, signer, space) : client.sell(address, signer, space));
}

export const subscribeTable = (table: string, onTable: (view: TableView) => void, onError: (error: Error) => void) =>
  client.subscribeTable(new PublicKey(table), onTable, onError);

/** Liveness for every participant tab: timeouts, VRF retries, settle, expiry and refunds. */
export function runCrank(table: string, signer: Keypair) {
  return startCrank(client, new PublicKey(table), signer);
}
