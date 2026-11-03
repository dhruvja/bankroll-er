import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, Transaction, type Connection, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction, type ParsedInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { delegateSpl, withdrawSpl, deriveShuttleEphemeralAta, deriveShuttleAta, deriveShuttleWalletAta, deriveVault, deriveVaultAta, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import bs58 from 'bs58';
import { DEVNET_USDC, PUBLIC_VALIDATOR } from '../../shared/config.ts';
import { hasPaymentCompletion } from '../../shared/payment-recovery.ts';
import type { PaymentOperation } from '../../shared/payments.ts';

type History = Pick<Connection, 'getSignaturesForAddress' | 'getParsedTransaction'>;
type Instruction = (ParsedInstruction | PartiallyDecodedInstruction) & { stackHeight?: number };

async function fixture(operation: PaymentOperation) {
  const wallet = Keypair.generate();
  const sponsor = Keypair.generate();
  const owner = wallet.publicKey;
  const mint = new PublicKey(DEVNET_USDC);
  const amount = 1_000_000n;
  const ownerToken = getAssociatedTokenAddressSync(mint, owner);
  const options = { payer: sponsor.publicKey, shuttleId: 7, validator: new PublicKey(PUBLIC_VALIDATOR), initIfMissing: true, initAtasIfMissing: true, idempotent: true };
  const instructions = operation === 'deposit' ? await delegateSpl(owner, mint, amount, { ...options, private: false, initVaultIfMissing: true }) : await withdrawSpl(owner, mint, amount, options);
  const signed = new Transaction({ feePayer: sponsor.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(...instructions);
  signed.sign(wallet, sponsor);
  const signature = bs58.encode(signed.signature!);
  const [shuttle] = deriveShuttleEphemeralAta(owner, mint, 7);
  const [backing] = deriveShuttleAta(shuttle, mint);
  const shuttleToken = deriveShuttleWalletAta(mint, shuttle);
  const [vault] = deriveVault(mint);
  const vaultToken = deriveVaultAta(mint, vault);
  const protocol = (opcode: number): PartiallyDecodedInstruction => ({
    programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID, data: bs58.encode(Buffer.from([opcode])),
    accounts: opcode === 15 ? [owner, ownerToken, shuttle, shuttleToken, mint, TOKEN_PROGRAM_ID]
      : [sponsor.publicKey, shuttle, backing, shuttleToken, ownerToken, mint, vault, vaultToken, TOKEN_PROGRAM_ID],
  });
  const transfer = (source = operation === 'deposit' ? shuttleToken : vaultToken, value = amount): ParsedInstruction => ({
    program: 'spl-token', programId: TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: {
      source: source.toBase58(), destination: ownerToken.toBase58(), authority: (source.equals(shuttleToken) ? shuttle : vault).toBase58(),
      mint: DEVNET_USDC, tokenAmount: { amount: value.toString(), decimals: 6, uiAmount: Number(value) / 1_000_000 },
    } },
  });
  const tokenBalance = (value: bigint, accountIndex = 0, authority = owner) => ({ accountIndex, mint: DEVNET_USDC, owner: authority.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: value.toString(), decimals: 6, uiAmount: Number(value) / 1_000_000 } });
  const parsed = (id: string, outer: Instruction[] = [], inner: Instruction[] = []): ParsedTransactionWithMeta => ({
    slot: id === signature ? 100 : 105, blockTime: id === signature ? 1000 : 1001,
    transaction: { signatures: [id], message: { accountKeys: [ownerToken, shuttleToken].map(pubkey => ({ pubkey, signer: false, writable: true })), recentBlockhash: signed.recentBlockhash!, instructions: outer } },
    meta: { err: null, fee: 0, preBalances: [0, 0], postBalances: [0, 0], preTokenBalances: [tokenBalance(10_000_000n), tokenBalance(amount, 1, shuttle)], postTokenBalances: [tokenBalance(10_000_000n + amount), tokenBalance(0n, 1, shuttle)], innerInstructions: [{ index: 0, instructions: inner }] },
  });
  let origin: ParsedTransactionWithMeta | null = parsed(signature);
  let candidate: ParsedTransactionWithMeta | null = parsed('settlement', [protocol(operation === 'deposit' ? 15 : 201)], [transfer()]);
  let queried = 0;
  let historyLength = 1;
  let unsupported = false;
  const provider = (expected: 'base' | 'per'): History => ({
    async getParsedTransaction(id) {
      if (id === signature) return origin;
      queried++;
      return candidate;
    },
    async getSignaturesForAddress(address, options) {
      assert.equal(options?.limit, 10);
      assert.equal(expected, operation === 'deposit' ? 'per' : 'base');
      assert.ok(address.equals(operation === 'deposit' ? shuttleToken : shuttle));
      if (unsupported) throw new Error('History unsupported');
      return Array.from({ length: historyLength }, () => ({ signature: 'settlement', slot: 105, err: null, memo: null, blockTime: 1001, confirmationStatus: 'confirmed' as const }));
    },
  });
  const base = provider('base');
  const per = provider('per');
  return { signed, owner, amount, shuttle, backing, shuttleToken, vaultToken, ownerToken, mint, protocol, transfer, parsed, base, per,
    check: () => hasPaymentCompletion(base, per, signed, operation, owner, amount),
    get candidate(): ParsedTransactionWithMeta { return candidate!; }, set candidate(value: ParsedTransactionWithMeta | null) { candidate = value; },
    setOrigin(value: ParsedTransactionWithMeta | null) { origin = value; },
    unsupported() { unsupported = true; }, boundedHistory() { historyLength = 15; }, get queried() { return queried; },
  };
}

test('deposit completion requires the exact public shuttle merge and token movement', async () => {
  const f = await fixture('deposit');
  assert.equal(await f.check(), true);
  f.candidate.meta!.innerInstructions![0].instructions = [f.transfer(Keypair.generate().publicKey)];
  assert.equal(await f.check(), false, 'unrelated credit is not a deposit');
});

test('deposit cancellation/refund, even with an exact owner credit, is not completion', async () => {
  const f = await fixture('deposit');
  f.candidate.transaction.message.instructions = [f.protocol(32)];
  assert.equal(await f.check(), false);
});

test('caught failed merge CPI cannot claim completion from instruction metadata alone', async () => {
  const f = await fixture('deposit');
  // Overall transaction succeeded, but a wrapper caught the CPI failure.
  f.candidate.meta!.postTokenBalances = f.candidate.meta!.preTokenBalances;
  assert.equal(await f.check(), false);
  // An unrelated exact owner credit still does not show the shuttle was debited.
  f.candidate.meta!.postTokenBalances = f.candidate.meta!.preTokenBalances!.map(value => ({ ...value, uiTokenAmount: { ...value.uiTokenAmount } }));
  f.candidate.meta!.postTokenBalances[0].uiTokenAmount.amount = '11000000';
  assert.equal(await f.check(), false);
});

test('deposit rejects wrong transfer amounts, destinations, authorities, and mints', async () => {
  for (const field of ['amount', 'destination', 'authority', 'mint']) {
    const f = await fixture('deposit');
    const transfer = f.transfer();
    if (field === 'amount') transfer.parsed.info.tokenAmount.amount = '999999';
    else transfer.parsed.info[field] = Keypair.generate().publicKey.toBase58();
    f.candidate.meta!.innerInstructions![0].instructions = [transfer];
    assert.equal(await f.check(), false, field);
  }
});

test('withdrawal uses the specific successful close and its transaction-local credit', async () => {
  const f = await fixture('withdraw');
  assert.equal(await f.check(), true);
  // Recovery uses the same exact settlement accounts and delivery semantics.
  f.candidate.transaction.message.instructions = [f.protocol(32)];
  assert.equal(await f.check(), true);
  f.candidate.meta!.postTokenBalances![0].uiTokenAmount.amount = '11000001';
  assert.equal(await f.check(), false, 'aggregate or unrelated credits must not masquerade as this payment');
});

test('withdrawal rejects empty cleanup combined with an unrelated equal-sized credit', async () => {
  const f = await fixture('withdraw');
  f.candidate.meta!.innerInstructions![0].instructions = [f.transfer(Keypair.generate().publicKey)];
  assert.equal(await f.check(), false);
  f.candidate.meta!.innerInstructions![0].instructions = [f.transfer(f.vaultToken, 999999n)];
  assert.equal(await f.check(), false);
});

test('withdrawal close must bind this shuttle, backing, owner ATA, mint, and vault', async () => {
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const f = await fixture('withdraw');
    const close = f.protocol(201);
    close.accounts[index] = Keypair.generate().publicKey;
    f.candidate.transaction.message.instructions = [close];
    assert.equal(await f.check(), false, `account ${index}`);
  }
});

test('nested Magic action accepts only descendants, with explicit stack-height boundaries', async () => {
  const f = await fixture('withdraw');
  const wrapper: PartiallyDecodedInstruction = { programId: Keypair.generate().publicKey, data: '', accounts: [] };
  f.candidate = f.parsed('settlement', [wrapper], [{ ...f.protocol(201), stackHeight: 2 }, { ...f.transfer(), stackHeight: 3 }]);
  assert.equal(await f.check(), true);
  const siblings: Instruction[] = [{ ...f.protocol(201), stackHeight: 2 }, { ...f.transfer(), stackHeight: 2 }];
  f.candidate.meta!.innerInstructions![0].instructions = siblings;
  assert.equal(await f.check(), false, 'sibling credit is not produced by the close');
  f.candidate.meta!.innerInstructions![0].instructions = [f.protocol(201), f.transfer()];
  assert.equal(await f.check(), false, 'ambiguous nesting stays pending');
});

test('failed transactions, missing history, and unsupported RPCs never claim completion', async () => {
  const f = await fixture('deposit');
  f.candidate.meta!.err = { InstructionError: [0, 'InvalidAccountData'] };
  assert.equal(await f.check(), false);
  f.candidate = null;
  assert.equal(await f.check(), false);
  f.unsupported();
  assert.equal(await f.check(), false);
});

test('completion requires the originating signed transaction to have landed successfully', async () => {
  const f = await fixture('deposit');
  f.setOrigin(null);
  assert.equal(await f.check(), false);
  assert.equal(f.queried, 0);
});

test('old reused-shuttle history is not attributed to this payment', async () => {
  const deposit = await fixture('deposit');
  deposit.candidate.blockTime = 999;
  assert.equal(await deposit.check(), false);
  deposit.candidate.blockTime = 1000;
  assert.equal(await deposit.check(), false, 'same-second histories remain ambiguous');
  deposit.candidate.blockTime = null;
  assert.equal(await deposit.check(), false);
  const withdrawal = await fixture('withdraw');
  withdrawal.candidate.slot = 100;
  assert.equal(await withdrawal.check(), false);
});

test('saved transaction must be signed and bind the requested owner, operation, and amount', async () => {
  const f = await fixture('deposit');
  assert.equal(await hasPaymentCompletion(f.base, f.per, f.signed, 'deposit', f.owner, f.amount + 1n), false);
  assert.equal(await hasPaymentCompletion(f.base, f.per, f.signed, 'withdraw', f.owner, f.amount), false);
  assert.equal(await hasPaymentCompletion(f.base, f.per, f.signed, 'deposit', Keypair.generate().publicKey, f.amount), false);
  f.signed.instructions.at(-1)!.data[5] ^= 1;
  assert.equal(await f.check(), false);
});

test('history lookup is bounded to ten parsed candidates even if an RPC ignores limit', async () => {
  const f = await fixture('deposit');
  f.boundedHistory();
  f.candidate.meta!.innerInstructions = [];
  assert.equal(await f.check(), false);
  assert.equal(f.queried, 10);
});

test('pre-signing ER slot checkpoint proves same-second completion without accepting prior shuttle history', async () => {
  const f = await fixture('deposit');
  f.candidate.blockTime = 1000;
  assert.equal(await hasPaymentCompletion(f.base, f.per, f.signed, 'deposit', f.owner, f.amount, 104), true);
  assert.equal(await hasPaymentCompletion(f.base, f.per, f.signed, 'deposit', f.owner, f.amount, 105), false);
});

const magic = new PublicKey('Magic11111111111111111111111111111111111111');
const postAct = new PublicKey('PostAct111111111111111111111111111111111111');
function missingBalances(transaction: ParsedTransactionWithMeta) {
  transaction.meta!.preTokenBalances = undefined; transaction.meta!.postTokenBalances = undefined;
}
async function nestedDeposit() {
  const f = await fixture('deposit');
  const wrapper = (programId: PublicKey): PartiallyDecodedInstruction => ({ programId, accounts: [], data: '' });
  f.candidate = f.parsed('settlement', [wrapper(magic), wrapper(postAct)]);
  const actions: Instruction[] = [
    { ...f.protocol(15), stackHeight: 2 }, { ...f.transfer(), stackHeight: 3 },
    { ...f.protocol(16), stackHeight: 2 }, { ...wrapper(magic), stackHeight: 3 },
  ];
  f.candidate.meta!.innerInstructions = [{ index: 1, instructions: actions }];
  missingBalances(f.candidate);
  f.candidate.meta!.logMessages = [
    `Program ${magic} invoke [1]`, `Program ${magic} success`,
    `Program ${postAct} invoke [1]`, `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} invoke [2]`,
    `Program ${TOKEN_PROGRAM_ID} invoke [3]`, 'Program log: Instruction: TransferChecked',
    `Program ${TOKEN_PROGRAM_ID} success`, `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} success`,
    `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} invoke [2]`, `Program ${magic} invoke [3]`,
    `Program ${magic} success`, `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} success`, `Program ${postAct} success`,
  ];
  return f;
}

test('a successful top-level merge proves the exact deposit when ER token balances are unavailable', async () => {
  const f = await fixture('deposit'); missingBalances(f.candidate);
  assert.equal(await f.check(), true);
  f.candidate.meta!.preTokenBalances = []; f.candidate.meta!.postTokenBalances = [];
  assert.equal(await f.check(), true, 'empty ER metadata is unavailable rather than zero');
  f.candidate.meta!.innerInstructions![0].instructions = [f.transfer(f.shuttleToken, f.amount - 1n)];
  assert.equal(await f.check(), false);
  const unchecked = f.transfer(); unchecked.parsed.type = 'transfer';
  f.candidate.meta!.innerInstructions![0].instructions = [unchecked];
  assert.equal(await f.check(), false, 'the mint and decimals must still be bound by TransferChecked');
});

test('real Magic clone and PostAct nesting can prove a merge without ER token balance metadata', async () => {
  const f = await nestedDeposit();
  assert.equal(await f.check(), true);
  assert.equal(await hasPaymentCompletion(f.base, f.per, f.signed, 'deposit', f.owner, f.amount, 104), true);
  assert.equal(await hasPaymentCompletion(f.base, f.per, f.signed, 'deposit', f.owner, f.amount, 105), false);
});

test('runtime logs cannot override conflicting or incomplete token balance metadata', async () => {
  for (const mode of ['unchanged', 'partial']) {
    const f = await nestedDeposit();
    const metadata = f.parsed('settlement').meta!;
    f.candidate.meta!.preTokenBalances = metadata.preTokenBalances;
    f.candidate.meta!.postTokenBalances = mode === 'unchanged' ? metadata.preTokenBalances : metadata.postTokenBalances!.slice(0, 1);
    assert.equal(await f.check(), false, mode);
  }
});

test('missing, truncated, spoofed or mismatched runtime logs cannot prove a nested merge', async () => {
  for (const mode of ['missing', 'truncated', 'truncation marker', 'spoofed', 'mismatched']) {
    const f = await nestedDeposit(); const logs = f.candidate.meta!.logMessages!;
    if (mode === 'missing') f.candidate.meta!.logMessages = undefined;
    else if (mode === 'truncated') logs.pop();
    else if (mode === 'truncation marker') logs.push('Log truncated');
    else if (mode === 'spoofed') f.candidate.meta!.logMessages = logs.map(line => `Program log: ${line}`);
    else logs[6] = `Program ${magic} success`;
    assert.equal(await f.check(), false, mode);
  }
});

test('a nested merge or token CPI failure stays pending even when a wrapper catches it', async () => {
  for (const mode of ['merge', 'transfer']) {
    const f = await nestedDeposit();
    const program = mode === 'merge' ? EPHEMERAL_SPL_TOKEN_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const logs = f.candidate.meta!.logMessages!;
    logs[logs.indexOf(`Program ${program} success`)] = `Program ${program} failed: custom program error: 0x1`;
    assert.equal(await f.check(), false, mode);
  }
});

test('a successful merge inside a failed ancestor is rolled back and cannot prove a deposit', async () => {
  const f = await fixture('deposit'), wrapper = Keypair.generate().publicKey;
  f.candidate = f.parsed('settlement', [{ programId: postAct, accounts: [], data: '' }], [
    { programId: wrapper, accounts: [], data: '', stackHeight: 2 }, { ...f.protocol(15), stackHeight: 3 }, { ...f.transfer(), stackHeight: 4 },
  ]);
  missingBalances(f.candidate);
  f.candidate.meta!.logMessages = [
    `Program ${postAct} invoke [1]`, `Program ${wrapper} invoke [2]`, `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} invoke [3]`,
    `Program ${TOKEN_PROGRAM_ID} invoke [4]`, `Program ${TOKEN_PROGRAM_ID} success`, `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} success`,
    `Program ${wrapper} failed: custom program error: 0x1`, `Program ${postAct} success`,
  ];
  assert.equal(await f.check(), false);
});

test('success of a later unrelated merge cannot stand in for a failed matching invocation', async () => {
  const f = await fixture('deposit'), unrelated = f.protocol(15);
  unrelated.accounts[2] = Keypair.generate().publicKey;
  f.candidate = f.parsed('settlement', [{ programId: postAct, accounts: [], data: '' }], [
    { ...f.protocol(15), stackHeight: 2 }, { ...f.transfer(), stackHeight: 3 },
    { ...unrelated, stackHeight: 2 }, { ...f.transfer(), stackHeight: 3 },
  ]);
  missingBalances(f.candidate);
  f.candidate.meta!.logMessages = [
    `Program ${postAct} invoke [1]`, `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} invoke [2]`,
    `Program ${TOKEN_PROGRAM_ID} invoke [3]`, `Program ${TOKEN_PROGRAM_ID} failed: custom program error: 0x1`,
    `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} failed: custom program error: 0x1`,
    `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} invoke [2]`, `Program ${TOKEN_PROGRAM_ID} invoke [3]`,
    `Program ${TOKEN_PROGRAM_ID} success`, `Program ${EPHEMERAL_SPL_TOKEN_PROGRAM_ID} success`, `Program ${postAct} success`,
  ];
  assert.equal(await f.check(), false);
});

test('missing or inconsistent instruction stack heights cannot prove a nested merge', async () => {
  for (const mode of ['missing', 'jump', 'extra invocation']) {
    const f = await nestedDeposit(); const instructions = f.candidate.meta!.innerInstructions![0].instructions as Instruction[];
    if (mode === 'missing') delete instructions[1].stackHeight;
    else if (mode === 'jump') instructions[1].stackHeight = 4;
    else instructions.push({ ...f.protocol(16), stackHeight: 2 });
    assert.equal(await f.check(), false, mode);
  }
});

test('F6: a version-1 withdraw completion is fetched with maxSupportedTransactionVersion 1 and proves the payment', async () => {
  const f = await fixture('withdraw');
  // Devnet now lands the base completion as a v1 transaction; an RPC asked for v0 throws.
  const strict = (connection: History): History => ({
    getSignaturesForAddress: connection.getSignaturesForAddress.bind(connection),
    async getParsedTransaction(signature, options) {
      const version = typeof options === 'object' ? options.maxSupportedTransactionVersion : undefined;
      if (signature === 'settlement' && (version ?? -1) < 1) throw new Error('Transaction version (1) is not supported by the requesting client.');
      return connection.getParsedTransaction(signature, options);
    },
  });
  assert.equal(await hasPaymentCompletion(strict(f.base), strict(f.per), f.signed, 'withdraw', f.owner, f.amount), true);
});
