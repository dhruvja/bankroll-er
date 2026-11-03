import { PublicKey, Transaction } from '@solana/web3.js';
import { createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { delegateSpl, withdrawSpl } from '@magicblock-labs/ephemeral-rollups-sdk';
import { DEVNET_USDC, PAYMENTS_API, PAYMENT_CLUSTER, PUBLIC_VALIDATOR, RELAY_FEE, invariant } from './config';

export type PaymentOperation = 'deposit' | 'withdraw';
export interface PaymentBuild {
  kind: PaymentOperation;
  version: string;
  sendTo: string;
  validator: string;
  transactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  requiredSigners: string[];
  instructionCount: number;
  fees?: { tokens: string; lamports: string };
}

export async function paymentsRequest<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${PAYMENTS_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json();
  invariant(response.ok, result.error?.message || `Payments service returned ${response.status}.`);
  return result as T;
}

export async function buildPayment(owner: PublicKey, operation: PaymentOperation, amount: bigint) {
  invariant(amount >= 500_000n && amount <= 1_000_000_000n, 'Sponsored payments must be between 0.5 and 1,000 USDC.');
  return paymentsRequest<PaymentBuild>(`/v1/spl/${operation}`, {
    owner: owner.toBase58(), cluster: PAYMENT_CLUSTER, mint: DEVNET_USDC,
    amount: Number(amount), gasless: true, validator: PUBLIC_VALIDATOR,
    initIfMissing: true, initAtasIfMissing: true, idempotent: true,
    ...(operation === 'deposit' ? { private: false, initVaultIfMissing: true } : { escrowIndex: 0 }),
  });
}

// Rebuild the entire transaction locally before the embedded wallet signs it.
export async function validatePayment(build: PaymentBuild, owner: PublicKey, operation: PaymentOperation, amount: bigint) {
  invariant(build.kind === operation && build.version === 'legacy' && build.sendTo === 'base', 'Unexpected payment routing.');
  invariant(build.validator === PUBLIC_VALIDATOR && build.fees?.tokens === String(RELAY_FEE), 'Unexpected payment validator or fee.');
  const transaction = Transaction.from(Buffer.from(build.transactionBase64, 'base64'));
  const sponsor = transaction.feePayer;
  invariant(sponsor && !sponsor.equals(owner), 'The payment has no sponsor.');
  invariant(transaction.recentBlockhash === build.recentBlockhash && Number.isSafeInteger(build.lastValidBlockHeight) && build.lastValidBlockHeight > 0, 'Invalid payment lifetime.');
  invariant(transaction.signatures.length === 2 && transaction.signatures.some(item => item.publicKey.equals(owner))
    && transaction.signatures.find(item => item.publicKey.equals(sponsor))?.signature && transaction.verifySignatures(false), 'Invalid sponsor signature.');
  invariant(build.requiredSigners.length === 2 && build.requiredSigners.includes(owner.toBase58()) && build.requiredSigners.includes(sponsor.toBase58()), 'Unexpected payment signers.');
  const shuttle = transaction.instructions.at(-1);
  invariant(shuttle && shuttle.data.length === 45 && shuttle.data[0] === (operation === 'deposit' ? 24 : 26), 'Unsupported payment instruction.');
  const mint = new PublicKey(DEVNET_USDC);
  const options = { payer: sponsor, validator: new PublicKey(PUBLIC_VALIDATOR), shuttleId: shuttle.data.readUInt32LE(1), escrowIndex: 0, initIfMissing: true, initAtasIfMissing: true, idempotent: true };
  const instructions = operation === 'deposit'
    ? await delegateSpl(owner, mint, amount, { ...options, private: false, initVaultIfMissing: true })
    : await withdrawSpl(owner, mint, amount, options);
  const expected = new Transaction({ feePayer: sponsor, recentBlockhash: build.recentBlockhash }).add(
    createTransferInstruction(getAssociatedTokenAddressSync(mint, owner), getAssociatedTokenAddressSync(mint, sponsor), owner, BigInt(RELAY_FEE)),
    ...instructions,
  );
  invariant(transaction.instructions.length === build.instructionCount && transaction.serializeMessage().equals(expected.serializeMessage()), 'Payment differs from your requested amount or recipient. Nothing was signed.');
  return transaction;
}
