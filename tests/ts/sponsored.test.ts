import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction, type ParsedTransactionWithMeta, type SignatureStatus } from '@solana/web3.js';
import { createTransferInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { delegateSpl, deriveShuttleEphemeralAta, deriveShuttleWalletAta, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import bs58 from 'bs58';
import { DEVNET_USDC, PAYMENTS_API, PUBLIC_VALIDATOR, RELAY_FEE } from '../../shared/config';
import type { PaymentBuild } from '../../shared/payments';
import { SponsoredPayments, type PaymentClient } from '../../shared/sponsored';

async function fixture(context: TestContext) {
  const owner = Keypair.generate(), sponsor = Keypair.generate(), mint = new PublicKey(DEVNET_USDC), amount = 1_000_000n;
  const address = owner.publicKey.toBase58(), key = `bankroll.payment.v1.${address}`;
  const ownerToken = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const [shuttle] = deriveShuttleEphemeralAta(owner.publicKey, mint, 7), shuttleToken = deriveShuttleWalletAta(mint, shuttle);
  const instructions = await delegateSpl(owner.publicKey, mint, amount, {
    payer: sponsor.publicKey, validator: new PublicKey(PUBLIC_VALIDATOR), shuttleId: 7, escrowIndex: 0,
    initIfMissing: true, initAtasIfMissing: true, idempotent: true, private: false, initVaultIfMissing: true,
  });
  let build: PaymentBuild;
  function newBuild() {
    const transaction = new Transaction({ feePayer: sponsor.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(
      createTransferInstruction(ownerToken, getAssociatedTokenAddressSync(mint, sponsor.publicKey), owner.publicKey, BigInt(RELAY_FEE)), ...instructions,
    );
    transaction.partialSign(sponsor);
    build = { kind: 'deposit', version: 'legacy', sendTo: 'base', validator: PUBLIC_VALIDATOR,
      transactionBase64: transaction.serialize({ requireAllSignatures: false }).toString('base64'),
      recentBlockhash: transaction.recentBlockhash!, lastValidBlockHeight: 100,
      requiredSigners: [sponsor.publicKey.toBase58(), address], instructionCount: transaction.instructions.length,
      fees: { tokens: String(RELAY_FEE), lamports: '0' } };
  }
  newBuild();
  const records = new Map<string, string>();
  const storage = { getItem: (name: string) => records.get(name) ?? null, setItem: (name: string, value: string) => { records.set(name, value); }, removeItem: (name: string) => { records.delete(name); } };
  const calls = { builds: 0, balances: 0, statuses: 0, blockHeights: 0, sends: [] as Buffer[] };
  const state = { status: { slot: 20, confirmations: 1, err: null, confirmationStatus: 'confirmed' } as SignatureStatus | null,
    statusError: undefined as Error | undefined, sendError: undefined as Error | undefined,
    settlementAvailable: true, omitErTokenBalances: false, blockHeight: 90, blockhashValid: true };
  const tokenBalance = (value: bigint, accountIndex: number, wallet: PublicKey) => ({ accountIndex, mint: DEVNET_USDC,
    owner: wallet.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: String(value), decimals: 6, uiAmount: Number(value) / 1_000_000 } });
  function parsed(signature: string, settlement = false): ParsedTransactionWithMeta {
    return { slot: settlement ? 101 : 20, blockTime: 1000,
      transaction: { signatures: [signature], message: { recentBlockhash: build.recentBlockhash,
        accountKeys: [ownerToken, shuttleToken].map(pubkey => ({ pubkey, signer: false, writable: true })),
        instructions: settlement ? [{ programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID, data: bs58.encode(Buffer.from([15])), accounts: [owner.publicKey, ownerToken, shuttle, shuttleToken, mint, TOKEN_PROGRAM_ID] }] : [] } },
      meta: { err: null, fee: 0, preBalances: [0, 0], postBalances: [0, 0],
        preTokenBalances: [tokenBalance(0n, 0, owner.publicKey), tokenBalance(amount, 1, shuttle)],
        postTokenBalances: [tokenBalance(amount, 0, owner.publicKey), tokenBalance(0n, 1, shuttle)],
        innerInstructions: settlement ? [{ index: 0, instructions: [{ programId: TOKEN_PROGRAM_ID, program: 'spl-token', parsed: { type: 'transferChecked', info: {
          source: shuttleToken.toBase58(), destination: ownerToken.toBase58(), authority: shuttle.toBase58(), mint: DEVNET_USDC,
          tokenAmount: { amount: String(amount), decimals: 6, uiAmount: 1 },
        } } }] }] : [] },
    };
  }
  const base = {
    async sendRawTransaction(raw: Uint8Array) {
      calls.sends.push(Buffer.from(raw));
      if (state.sendError) throw state.sendError;
      return bs58.encode(Transaction.from(raw).signature!);
    },
    async getSignatureStatuses() { calls.statuses++; if (state.statusError) throw state.statusError; return { value: [state.status] }; },
    async getParsedTransaction(signature: string) { return parsed(signature); },
    async getBlockHeight() { calls.blockHeights++; return state.blockHeight; },
    async isBlockhashValid() { return { value: state.blockhashValid }; },
  };
  const er = {
    async getSlot() { return 100; },
    async getSignaturesForAddress(account: PublicKey) {
      assert.ok(account.equals(shuttleToken));
      return state.settlementAvailable ? [{ signature: 'settlement', err: null }] : [];
    },
    async getParsedTransaction(signature: string) {
      const transaction = parsed(signature, true);
      if (state.omitErTokenBalances) {
        delete transaction.meta!.preTokenBalances; delete transaction.meta!.postTokenBalances;
      }
      return transaction;
    },
  };
  const client = { base, er, async walletBalances(wallet: PublicKey) {
    assert.ok(wallet.equals(owner.publicKey)); calls.balances++;
    return { base: 10_000_000n, er: 0n, lamports: 0 };
  } };
  context.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, `${PAYMENTS_API}/v1/spl/deposit`); calls.builds++;
    const request = JSON.parse(init!.body as string);
    assert.equal(request.owner, address); assert.equal(request.amount, Number(amount));
    assert.equal(request.private, false); assert.equal(request.gasless, true); assert.equal(request.validator, PUBLIC_VALIDATOR);
    return Response.json(build);
  });
  const payments = new SponsoredPayments(client as unknown as PaymentClient, storage);
  function saveReceipt() {
    const signed = Transaction.from(Buffer.from(build.transactionBase64, 'base64')); signed.partialSign(owner);
    const receipt = { owner: address, operation: 'deposit', amount: String(amount), signature: bs58.encode(signed.signature!), beforeErSlot: 100,
      build: { ...build, transactionBase64: signed.serialize().toString('base64') } };
    storage.setItem(key, JSON.stringify(receipt)); return receipt;
  }
  return { owner, address, amount, key, storage, calls, state, base, payments, saveReceipt, newBuild,
    execute: (onPrepared?: () => void) => payments.execute(owner, 'deposit', amount, onPrepared) };
}

test('a zero-SOL deposit saves its signed receipt before the preparation callback and broadcast', async context => {
  const f = await fixture(context); let prepared = false;
  const send = f.base.sendRawTransaction;
  context.mock.method(f.base, 'sendRawTransaction', async (raw: Uint8Array) => {
    assert.equal(prepared, true);
    const receipt = JSON.parse(f.storage.getItem(f.key)!);
    assert.deepEqual(Buffer.from(receipt.build.transactionBase64, 'base64'), Buffer.from(raw));
    return send(raw);
  });
  await f.execute(() => {
    const receipt = JSON.parse(f.storage.getItem(f.key)!);
    assert.equal(Transaction.from(Buffer.from(receipt.build.transactionBase64, 'base64')).verifySignatures(), true);
    prepared = true;
  });
  assert.equal(prepared, true); assert.equal(f.calls.builds, 1); assert.equal(f.calls.sends.length, 1);
  assert.equal(f.payments.pending(f.address), false);
});

test('ambiguous submission retains the exact signed payment and rejects a replacement', async context => {
  const f = await fixture(context);
  f.state.sendError = new Error('Submission response lost'); f.state.statusError = new Error('Status RPC unavailable');
  await assert.rejects(f.execute(), /Status RPC unavailable/);
  assert.equal(f.payments.pending(f.address), true);
  const saved = f.storage.getItem(f.key)!;
  const signed = Buffer.from(JSON.parse(saved).build.transactionBase64, 'base64');
  assert.equal(Transaction.from(signed).verifySignatures(), true); assert.deepEqual(f.calls.sends[0], signed);
  await assert.rejects(f.execute(), /still pending/);
  assert.equal(f.calls.builds, 1); assert.equal(f.calls.balances, 1); assert.equal(f.storage.getItem(f.key), saved);
  f.state.statusError = undefined; f.state.status = null;
  assert.equal(await f.payments.reconcile(f.owner.publicKey, true), false);
  assert.equal(f.calls.sends.length, 2); assert.deepEqual(f.calls.sends[1], signed);
  assert.equal(f.storage.getItem(f.key), saved, 'retrying the same signature must not replace its receipt');
});

test('an observed confirmed origin stays pending if history later disappears after blockhash expiry', async context => {
  const f = await fixture(context); f.saveReceipt(); f.state.settlementAvailable = false;
  assert.equal(await f.payments.reconcile(f.owner.publicKey), false);
  assert.equal(JSON.parse(f.storage.getItem(f.key)!).baseConfirmed, true);
  f.state.status = null; f.state.blockHeight = 101; f.state.blockhashValid = false;
  assert.equal(await f.payments.reconcile(f.owner.publicKey, true), false);
  assert.equal(f.payments.pending(f.address), true); assert.equal(f.calls.blockHeights, 0);
  assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.builds, 0);
  f.state.settlementAvailable = true;
  assert.equal(await f.payments.reconcile(f.owner.publicKey), true);
  assert.equal(f.payments.pending(f.address), false);
});

test('an existing saved deposit clears from successful ER history without token-balance metadata or another charge', async context => {
  const f = await fixture(context);
  f.saveReceipt(); f.state.omitErTokenBalances = true;
  assert.equal(f.payments.pending(f.address), true);
  assert.equal(await f.payments.reconcile(f.owner.publicKey, true), true);
  assert.equal(f.payments.pending(f.address), false);
  assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.builds, 0);
});

test('a definitive failed origin clears the receipt without automatically charging again', async context => {
  const f = await fixture(context); const receipt = f.saveReceipt();
  f.state.status = { slot: 20, confirmations: null, confirmationStatus: 'finalized', err: { InstructionError: [0, 'InvalidArgument'] } };
  await assert.rejects(f.payments.reconcile(f.owner.publicKey, true), /payment failed/);
  assert.equal(f.payments.pending(f.address), false); assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.builds, 0);
  f.state.status = { slot: 21, confirmations: 1, confirmationStatus: 'confirmed', err: null }; f.newBuild();
  await f.execute();
  assert.equal(f.calls.sends.length, 1); assert.notEqual(bs58.encode(Transaction.from(f.calls.sends[0]).signature!), receipt.signature);
});

test('a never-observed expired payment allows an explicit retry without an automatic replacement', async context => {
  const f = await fixture(context); const receipt = f.saveReceipt();
  f.state.status = null; f.state.blockHeight = 101; f.state.blockhashValid = false;
  await assert.rejects(f.payments.reconcile(f.owner.publicKey, true), /expired without landing/);
  assert.equal(f.payments.pending(f.address), false); assert.equal(f.calls.statuses, 2);
  assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.builds, 0);
  f.state.status = { slot: 21, confirmations: 1, confirmationStatus: 'confirmed', err: null }; f.newBuild();
  await f.execute();
  assert.equal(f.calls.sends.length, 1); assert.notEqual(bs58.encode(Transaction.from(f.calls.sends[0]).signature!), receipt.signature);
});

test('corrupted receipts or signed messages fail closed before any RPC or broadcast', async context => {
  for (const kind of ['owner', 'receipt signature', 'signed message']) {
    const f = await fixture(context); const receipt = f.saveReceipt();
    if (kind === 'owner') receipt.owner = Keypair.generate().publicKey.toBase58();
    else if (kind === 'receipt signature') receipt.signature = bs58.encode(new Uint8Array(64));
    else {
      const transaction = Transaction.from(Buffer.from(receipt.build.transactionBase64, 'base64'));
      transaction.instructions.at(-1)!.data[5] ^= 1;
      receipt.build.transactionBase64 = transaction.serialize({ verifySignatures: false }).toString('base64');
    }
    f.storage.setItem(f.key, JSON.stringify(receipt));
    await assert.rejects(f.payments.reconcile(f.owner.publicKey, true), /Invalid saved payment|Invalid sponsor signature/);
    assert.equal(f.payments.pending(f.address), true, kind);
    assert.equal(f.calls.statuses, 0); assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.builds, 0);
  }
});
