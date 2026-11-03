import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { RELAY_FEE, invariant } from './config';
import { buildPayment, validatePayment, type PaymentBuild, type PaymentOperation } from './payments';
import { hasPaymentCompletion } from './payment-recovery';
import type { DirectChainClient } from './client';

interface Receipt {
  owner: string; operation: PaymentOperation; amount: string; signature: string;
  build: PaymentBuild; beforeErSlot: number; baseConfirmed?: boolean;
}
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const receiptKey = (owner: string) => `bomberman.payment.v2.${owner}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A signed payment is saved before submission and never replaced while its outcome is unknown. */
export class SponsoredPayments {
  constructor(private client: DirectChainClient, private storage: Store) {}
  pending(owner: string) { return this.storage.getItem(receiptKey(owner)) !== null; }
  private clear(receipt: Receipt) {
    const current = this.storage.getItem(receiptKey(receipt.owner));
    if (current && JSON.parse(current).signature === receipt.signature) this.storage.removeItem(receiptKey(receipt.owner));
  }
  async reconcile(owner: PublicKey, resubmit = false): Promise<boolean> {
    const saved = this.storage.getItem(receiptKey(owner.toBase58()));
    if (!saved) return true;
    const receipt = JSON.parse(saved) as Receipt;
    invariant(receipt.owner === owner.toBase58() && ['deposit', 'withdraw'].includes(receipt.operation)
      && /^\d+$/.test(receipt.amount) && Number.isSafeInteger(receipt.beforeErSlot) && receipt.beforeErSlot >= 0, 'Invalid saved payment receipt.');
    const signed = await validatePayment(receipt.build, owner, receipt.operation, BigInt(receipt.amount));
    invariant(signed.verifySignatures() && signed.signature && bs58.encode(signed.signature) === receipt.signature, 'Invalid saved payment signature.');
    const { base, er } = this.client;
    const status = (await base.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) {
      if (!receipt.baseConfirmed) this.clear(receipt);
      throw new Error('The payment failed on Solana. No replacement was submitted.');
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      receipt.baseConfirmed = true;
      this.storage.setItem(receiptKey(receipt.owner), JSON.stringify(receipt));
    }
    if (receipt.baseConfirmed) {
      if (await hasPaymentCompletion(base, er, signed, receipt.operation, owner, BigInt(receipt.amount), receipt.beforeErSlot)) {
        this.clear(receipt); return true;
      }
    } else if (!status) {
      const expired = await base.getBlockHeight('finalized') > receipt.build.lastValidBlockHeight
        && !(await base.isBlockhashValid(signed.recentBlockhash!, { commitment: 'finalized' })).value;
      if (expired && !(await base.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true })).value[0]) {
        this.clear(receipt); throw new Error('The payment expired without landing. No replacement was submitted; you can try again.');
      }
      if (!expired && resubmit) {
        try { await base.sendRawTransaction(signed.serialize(), { maxRetries: 0 }); }
        catch { /* Reconcile the exact saved signature on the next check. */ }
      }
    }
    return false;
  }
  async execute(owner: Keypair, operation: PaymentOperation, amount: bigint, onPrepared?: () => void) {
    invariant(!this.pending(owner.publicKey.toBase58()), 'A payment is still pending. Refresh your wallet to check it before transferring again.');
    // Both apps share a wallet; do not overlap a payment started in Trivial on this origin.
    invariant(!this.storage.getItem(`trivial.payment.${owner.publicKey.toBase58()}`), 'A Trivial payment is pending. Finish it there before funding Bomberman.');
    invariant(amount >= 500_000n && amount <= 1_000_000_000n, 'Sponsored transfers must be between 0.50 and 1,000 USDC.');
    const balances = await this.client.walletBalances(owner.publicKey);
    invariant(balances.base >= (operation === 'deposit' ? amount + BigInt(RELAY_FEE * 2) : BigInt(RELAY_FEE)),
      operation === 'deposit' ? 'Keep enough base USDC for the deposit, its 0.20 fee and a 0.20 withdrawal reserve.' : 'A withdrawal needs 0.20 USDC on Solana for sponsorship.');
    invariant(operation !== 'withdraw' || balances.er >= amount, 'Your play balance is too low for this withdrawal.');
    // This checkpoint is on the destination ER, before the owner signs anything. It
    // excludes historical completions if the service reuses a shuttle identifier.
    const beforeErSlot = await this.client.er.getSlot('confirmed');
    const build = await buildPayment(owner.publicKey, operation, amount);
    const transaction = await validatePayment(build, owner.publicKey, operation, amount);
    const message = transaction.serializeMessage();
    transaction.partialSign(owner);
    invariant(transaction.serializeMessage().equals(message) && transaction.verifySignatures(), 'Payment signing changed the message or lost its sponsor signature.');
    const raw = transaction.serialize();
    const receipt: Receipt = { owner: owner.publicKey.toBase58(), operation, amount: String(amount), beforeErSlot,
      signature: bs58.encode(transaction.signature!), build: { ...build, transactionBase64: raw.toString('base64') } };
    this.storage.setItem(receiptKey(receipt.owner), JSON.stringify(receipt));
    onPrepared?.();
    try { await this.client.base.sendRawTransaction(raw, { maxRetries: 0 }); }
    catch { /* A dropped response does not authorize another charge. */ }
    for (let attempt = 0; attempt < 25; attempt++) {
      if (await this.reconcile(owner.publicKey, attempt % 10 === 0)) return;
      await pause(1000);
    }
    throw new Error('Your sponsored transfer is still pending. Its receipt is saved. Refresh your wallet; do not deposit again.');
  }
}
