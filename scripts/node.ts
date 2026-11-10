/** Node-only helpers shared by the operator scripts (setup-house, status, smoke, capacity, drain-check). */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { Keypair, Transaction, type PublicKey, type Signer, type TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from '@solana/spl-token';
import { DEVNET_GENESIS, RELAY_FEE, invariant } from '../shared/config';
import { HOUSE_SPACE, houseAddress, mintKey, tokenAddress, treasuryAddress } from '../shared/chain';
import { depositForEntry } from '../shared/funding';
import { BankrollClient } from '../shared/client';
import { houseStatus } from '../shared/status';
import { SponsoredPayments } from '../shared/sponsored';

export const ROOT = resolve(import.meta.dirname, '..');
/** Evidence lands in the current plan phase's artifact folder (`BANKROLL_PHASE=phase-NN` overrides). */
export const ARTIFACTS = resolve(ROOT, '../plans/bankroll-ephemeral-tables/artifacts', process.env.BANKROLL_PHASE ?? 'phase-02');
export const DEPLOYMENT = resolve(ROOT, 'shared/deployment.json');
export const client = new BankrollClient();
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
type Payments = ReturnType<typeof filePayments>['payments'];

export interface Deployment {
  programId: string; validator: string; house: string; vault: string; vaultEata: string; treasury: string;
  /** Lamports the house held when it was delegated: its rent-exempt minimum plus the table rent budget. */
  houseLamports: number; setupAt: string;
}
export function readDeployment(): Deployment {
  invariant(existsSync(DEPLOYMENT), 'shared/deployment.json is missing; run pnpm setup-house first.');
  return JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as Deployment;
}

export const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
export const loadAdmin = () => loadKeypair(resolve(homedir(), '.config/solana/id.json'));

/** Wallets `${prefix}1..count` from `.env` (base58 secret keys), created there if missing. They
 * never receive SOL. Only public keys are ever printed. */
export function loadWallets(prefix: string, count: number): Keypair[] {
  const path = resolve(ROOT, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
  return Array.from({ length: count }, (_, index) => {
    const name = `${prefix}${index + 1}`, secret = process.env[name];
    if (secret) return Keypair.fromSecretKey(bs58.decode(secret));
    const wallet = Keypair.generate();
    appendFileSync(path, `${name}=${bs58.encode(wallet.secretKey)}\n`, { mode: 0o600 });
    process.env[name] = bs58.encode(wallet.secretKey);
    return wallet;
  });
}

/** One ER snapshot of the house, its vault, the treasury and every live table. */
export async function readHouseStatus() {
  const [tables, house, vault, treasury, now, rentExempt] = await Promise.all([client.listTables(), client.readHouse(), client.erTokenBalance(houseAddress()),
    client.erTokenBalance(treasuryAddress()), client.erNow(), client.base.getMinimumBalanceForRentExemption(HOUSE_SPACE)]);
  return houseStatus({ tables, house, rentExempt, vault, treasury, now });
}

/** CLI flags; a bare `--` from `pnpm run x -- --flag` is ignored. */
export function flags() {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const value = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
  return { has: (name: string) => args.includes(`--${name}`), value };
}

export async function requireDevnet() {
  invariant(await client.base.getGenesisHash() === DEVNET_GENESIS, 'Refusing a non-devnet base RPC.');
}

export function saveArtifact(name: string, value: unknown) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const text = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
  writeFileSync(resolve(ARTIFACTS, name), `${text}\n`);
  return text;
}

export async function sendBase(instructions: TransactionInstruction[], signers: Signer[]) {
  const latest = await client.base.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(...instructions);
  transaction.sign(...signers);
  const signature = await client.base.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
  const result = await client.base.confirmTransaction({ signature, ...latest }, 'confirmed');
  invariant(!result.value.err, `Base transaction failed: ${signature} ${JSON.stringify(result.value.err)}`);
  return signature;
}

export async function lamports(owner: PublicKey) {
  return { base: await client.base.getBalance(owner), er: await client.er.getBalance(owner) };
}

/** Funding runs before any game exists and is driven by balances and saved payment receipts, so a
 * transient RPC or Payments API failure is retried a bounded number of times instead of failing
 * the whole run. `needs[i]` is the play balance wallet i must hold; `lanes` wallets fund at once. */
export async function fundPlayers(players: Keypair[], admin: Keypair, payments: Payments, needs: bigint[], base: Record<string, string>, lanes = 1) {
  const lane = (index: number) => players.map((player, at) => ({ player, need: needs[at] })).filter((_, at) => at % lanes === index);
  await Promise.all(Array.from({ length: lanes }, (_, index) => fundLane(lane(index), admin, payments, base)));
}
async function fundLane(wallets: { player: Keypair; need: bigint }[], admin: Keypair, payments: Payments, base: Record<string, string>) {
  for (let attempt = 1; ; attempt++) {
    try { return await fundPlayersOnce(wallets.map(item => item.player), admin, payments, wallets.map(item => item.need), base); } catch (error) {
      if (attempt === 3) throw error;
      console.log(`funding attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); retrying in 15 s`);
      await pause(15_000);
    }
  }
}

/** Zero SOL, always: refuse funded wallets. Then top each play balance up to its need with the
 * sponsored deposit, the admin sending base USDC first when a wallet lacks it. */
async function fundPlayersOnce(players: Keypair[], admin: Keypair, payments: Payments, needs: bigint[], base: Record<string, string>) {
  for (const player of players) {
    const value = await lamports(player.publicKey);
    invariant(value.base === 0 && value.er === 0, `${player.publicKey.toBase58()} holds lamports; smoke wallets must have 0 SOL.`);
  }
  for (const [index, player] of players.entries()) {
    for (let attempt = 0; attempt < 60 && !(await payments.reconcile(player.publicKey, true)); attempt++) await pause(3000);
    let balance = await client.walletBalances(player.publicKey);
    if (balance.er >= needs[index]) continue;
    const needed = depositForEntry(0n, balance.er, needs[index]) + BigInt(RELAY_FEE * 2);
    if (balance.base < needed) {
      base[`fund:${player.publicKey.toBase58()}`] = await sendBase([
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, tokenAddress(player.publicKey), player.publicKey, mintKey),
        createTransferInstruction(tokenAddress(admin.publicKey), tokenAddress(player.publicKey), admin.publicKey, needed - balance.base),
      ], [admin]);
      balance = await client.walletBalances(player.publicKey);
    }
    await payments.execute(player, 'deposit', depositForEntry(balance.base, balance.er, needs[index]));
    invariant((await client.walletBalances(player.publicKey)).er >= needs[index], `Player ${index} play balance did not arrive.`);
  }
}

/** Sponsored payments with receipts persisted as files; `signatures` records each signed payment. */
export function filePayments(directory = resolve(ROOT, 'target/smoke-payments')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = (key: string) => resolve(directory, `${encodeURIComponent(key)}.json`);
  const signatures: { operation: string; owner: string; amount: string; signature: string }[] = [];
  const payments = new SponsoredPayments(client, {
    getItem(key) {
      try { return readFileSync(file(key), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    setItem(key, value) {
      const receipt = JSON.parse(value) as { operation: string; owner: string; amount: string; signature: string };
      if (!signatures.some(item => item.signature === receipt.signature)) signatures.push({ operation: receipt.operation, owner: receipt.owner, amount: receipt.amount, signature: receipt.signature });
      const path = file(key), pending = `${path}.tmp`;
      writeFileSync(pending, value, { mode: 0o600 }); renameSync(pending, path);
    },
    removeItem(key) { unlinkSync(file(key)); },
  });
  return { payments, signatures };
}
