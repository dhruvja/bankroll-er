/** Node-only helpers shared by the operator scripts (bootstrap, smoke, drain-check). */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Keypair, Transaction, type Signer, type TransactionInstruction } from '@solana/web3.js';
import { DEVNET_GENESIS, invariant } from '../shared/config';
import { BankrollClient } from '../shared/client';
import { SponsoredPayments } from '../shared/sponsored';

export const ROOT = resolve(import.meta.dirname, '..');
/** Evidence lands in the current plan phase's artifact folder (`BANKROLL_PHASE=phase-NN` overrides). */
export const ARTIFACTS = resolve(ROOT, '../plans/bankroll/artifacts', process.env.BANKROLL_PHASE ?? 'phase-03');
export const DEPLOYMENT = resolve(ROOT, 'shared/deployment.json');
export const client = new BankrollClient();

export interface Deployment { programId: string; validator: string; tables: number; treasury: string; bootstrappedAt: string }
export function readDeployment(): Deployment {
  invariant(existsSync(DEPLOYMENT), 'shared/deployment.json is missing; run pnpm bootstrap first.');
  return JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as Deployment;
}

export const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
export const loadAdmin = () => loadKeypair(resolve(homedir(), '.config/solana/id.json'));

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
