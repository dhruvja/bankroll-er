/** Phase 01 devnet spikes. Usage: pnpm spike scripts/spike.ts <setup|f6-deposit|f1|f2|f9|f8|f6-withdraw|f7> */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Transaction,
  TransactionInstruction, type AccountMeta, type Signer,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  DELEGATION_PROGRAM_ID, delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount, deriveEphemeralAta,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { BASE_RPC, DEVNET_GENESIS, ER_RPC, PUBLIC_VALIDATOR, RELAY_FEE, ROUTER_RPC, invariant } from '../shared/config';
import { DirectChainClient, delegationStatus, mintKey } from '../shared/client';
import { custodyInstructions } from '../shared/custody';
import { SponsoredPayments } from '../shared/sponsored';

const PROGRAM = new PublicKey('BNykdw1BfGo9qDfMQdTCjVhJF5AhncTCLkYNYLm5GPBC');
const VRF_PROGRAM = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const ARTIFACTS = resolve(import.meta.dirname, '../../../plans/bankroll/artifacts/phase-01');
const KEYS = resolve(import.meta.dirname, '../.keys');
const [probe] = PublicKey.findProgramAddressSync([Buffer.from('probe')], PROGRAM);
const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from('identity')], PROGRAM);
const [scopedIdentity] = PublicKey.findProgramAddressSync([Buffer.from('identity'), PROGRAM.toBuffer()], VRF_PROGRAM);
const client = new DirectChainClient();
const { base, er } = client;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mintKey, owner, true);
const eata = (owner: PublicKey) => deriveEphemeralAta(owner, mintKey)[0];
const keypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
const admin = keypair(resolve(homedir(), '.config/solana/id.json'));

interface SpikeState { fresh: string; recipients: string[]; fee: string }
function loadState(): SpikeState {
  const path = resolve(KEYS, 'state.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as SpikeState;
  const fresh = Keypair.generate();
  writeFileSync(resolve(KEYS, 'fresh.json'), JSON.stringify(Array.from(fresh.secretKey)), { mode: 0o600 });
  const state: SpikeState = { fresh: fresh.publicKey.toBase58(), recipients: [Keypair.generate(), Keypair.generate()].map(k => k.publicKey.toBase58()), fee: Keypair.generate().publicKey.toBase58() };
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}
const state = loadState();
const fresh = keypair(resolve(KEYS, 'fresh.json'));
invariant(fresh.publicKey.toBase58() === state.fresh, 'Fresh wallet key mismatch.');

function save(name: string, value: unknown) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const text = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
  writeFileSync(resolve(ARTIFACTS, `spike-${name}.json`), `${text}\n`);
  console.log(text);
}

async function sendBase(instructions: TransactionInstruction[], signers: Signer[]) {
  const latest = await base.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(...instructions);
  tx.sign(...signers);
  const signature = await base.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const result = await base.confirmTransaction({ signature, ...latest }, 'confirmed');
  invariant(!result.value.err, `Base transaction failed: ${signature} ${JSON.stringify(result.value.err)}`);
  return signature;
}

// ER sends mirror bomberman: skipPreflight, maxRetries 0, then poll the status.
async function sendEr(instructions: TransactionInstruction[], signers: Signer[], expectFailure = false) {
  const { blockhash } = await er.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: blockhash }).add(...instructions);
  tx.sign(...signers);
  const raw = tx.serialize();
  const sentAt = Date.now();
  let signature: string;
  try { signature = await er.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); }
  catch (error) {
    if (expectFailure) return { signature: '', sentAt, confirmedAt: Date.now(), err: error instanceof Error ? error.message : String(error), size: raw.length };
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = (await er.getSignatureStatuses([signature])).value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized' || status?.err) {
      invariant(expectFailure || !status.err, `ER transaction failed: ${signature} ${JSON.stringify(status.err)}`);
      return { signature, sentAt, confirmedAt: Date.now(), err: status.err, size: raw.length };
    }
    await sleep(100);
  }
  throw new Error(`ER transaction not confirmed: ${signature}`);
}

async function erTransaction(signature: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const tx = await er.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (tx) return tx;
    await sleep(300);
  }
  throw new Error(`ER transaction not readable: ${signature}`);
}

interface ProbeView { nonce: bigint; requestedAt: bigint; fulfilled: number; die: number; pending: boolean }
async function readProbe(connection: Connection = er): Promise<ProbeView> {
  const info = await connection.getAccountInfo(probe, 'confirmed');
  invariant(info, 'Probe not found.');
  const data = info.data;
  return { nonce: data.readBigUInt64LE(8), requestedAt: data.readBigInt64LE(16), fulfilled: data.readUInt32LE(24), die: data[28], pending: data[29] === 1 };
}

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });
const requestRollIx = (payer: PublicKey) => new TransactionInstruction({
  programId: PROGRAM, data: disc('request_roll'),
  keys: [meta(payer, true, true), meta(probe, false, true), meta(EPHEMERAL_QUEUE, false, true), meta(programIdentity, false, false),
    meta(VRF_PROGRAM, false, false), meta(SYSVAR_SLOT_HASHES_PUBKEY, false, false), meta(SystemProgram.programId, false, false)],
});

async function roll(payer: Keypair) {
  const before = await readProbe();
  invariant(!before.pending, 'A request is already pending; wait for its callback.');
  const sent = await sendEr([requestRollIx(payer.publicKey)], [payer]);
  for (let attempt = 0; attempt < 600; attempt++) {
    const view = await readProbe();
    if (view.fulfilled > before.fulfilled) {
      const fulfilledAt = Date.now();
      const history = await er.getSignaturesForAddress(probe, { limit: 3 }, 'confirmed');
      const callback = history.find(entry => entry.signature !== sent.signature && entry.err === null)?.signature;
      return { request: sent.signature, callback, nonce: view.nonce, die: view.die, sendToConfirmMs: sent.confirmedAt - sent.sentAt,
        sendToCallbackMs: fulfilledAt - sent.sentAt, confirmToCallbackMs: fulfilledAt - sent.confirmedAt };
    }
    await sleep(50);
  }
  throw new Error(`No callback within 30 s for ${sent.signature}`);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
};

function payments() {
  const directory = resolve(import.meta.dirname, '../receipts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = (key: string) => resolve(directory, `${encodeURIComponent(key)}.json`);
  return new SponsoredPayments(client, {
    getItem(key) {
      try { return readFileSync(file(key), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    setItem(key, value) { const path = file(key), pending = `${path}.tmp`; writeFileSync(pending, value, { mode: 0o600 }); renameSync(pending, path); },
    removeItem(key) { unlinkSync(file(key)); },
  });
}

const command = process.argv[2];
invariant(await base.getGenesisHash() === DEVNET_GENESIS, 'Refusing a non-devnet base RPC.');

if (command === 'setup') {
  const signatures: Record<string, string> = {};
  if (!(await base.getAccountInfo(probe))) {
    signatures.initProbe = await sendBase([new TransactionInstruction({ programId: PROGRAM, data: disc('init_probe'),
      keys: [meta(admin.publicKey, true, true), meta(probe, false, true), meta(SystemProgram.programId, false, false)] })], [admin]);
  }
  if (!(await base.getAccountInfo(probe))?.owner.equals(DELEGATION_PROGRAM_ID)) {
    signatures.delegateProbe = await sendBase([new TransactionInstruction({ programId: PROGRAM, data: disc('delegate_probe'), keys: [
      meta(admin.publicKey, true, true), meta(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(probe, PROGRAM), false, true),
      meta(delegationRecordPdaFromDelegatedAccount(probe), false, true), meta(delegationMetadataPdaFromDelegatedAccount(probe), false, true),
      meta(probe, false, true), meta(PROGRAM, false, false), meta(DELEGATION_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false)] })], [admin]);
  }
  const owners = [probe, ...state.recipients.map(key => new PublicKey(key)), new PublicKey(state.fee)];
  for (const owner of owners) {
    const custody = await base.getAccountInfo(eata(owner));
    if (custody?.owner.equals(DELEGATION_PROGRAM_ID)) continue;
    signatures[`custody:${owner.toBase58()}`] = await sendBase(custodyInstructions(owner, admin.publicKey, new PublicKey(PUBLIC_VALIDATOR), !custody), [admin]);
  }
  const freshFunds = await client.walletBalances(fresh.publicKey);
  const needed = 550_000n + BigInt(RELAY_FEE * 2);
  if (freshFunds.base < needed) {
    signatures.fundFresh = await sendBase([
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata(fresh.publicKey), fresh.publicKey, mintKey),
      createTransferInstruction(ata(admin.publicKey), ata(fresh.publicKey), admin.publicKey, needed - freshFunds.base),
    ], [admin]);
  }
  save("setup", { program: PROGRAM, probe, programIdentity, scopedIdentity, ...state, signatures,
    probeRoute: await delegationStatus(probe), freshBalances: await client.walletBalances(fresh.publicKey) });
} else if (command === 'f6-deposit' || command === 'f6-withdraw') {
  const operation = command === 'f6-deposit' ? 'deposit' : 'withdraw';
  const amount = operation === 'deposit' ? 550_000n : 500_000n;
  const flow = payments();
  const receipt = resolve(import.meta.dirname, '../receipts', `${encodeURIComponent(`bomberman.payment.v2.${fresh.publicKey.toBase58()}`)}.json`);
  const resumed = existsSync(receipt) ? (JSON.parse(readFileSync(receipt, 'utf8')) as { signature: string; operation: string }) : undefined;
  const startedAt = Date.now();
  let reconciled = await flow.reconcile(fresh.publicKey, true);
  while (!reconciled && Date.now() - startedAt < 180_000) { await sleep(3000); reconciled = await flow.reconcile(fresh.publicKey, true); }
  invariant(reconciled, 'A prior payment receipt is still pending after 180 s.');
  const before = await client.walletBalances(fresh.publicKey);
  if (resumed?.operation !== operation) await flow.execute(fresh, operation, amount);
  const after = await client.walletBalances(fresh.publicKey);
  const history = await base.getSignaturesForAddress(fresh.publicKey, { limit: 1 }, 'confirmed');
  save(command, { owner: fresh.publicKey, operation, amount, before, after, baseSignature: resumed?.operation === operation ? resumed.signature : history[0]?.signature,
    resumedFromReceipt: resumed?.operation === operation, reconcileMs: Date.now() - startedAt,
    note: 'Built by POST /v1/spl/' + operation + ', accepted by the verbatim bomberman validatePayment (discriminator ' + (operation === 'deposit' ? 24 : 26) + ', fee 200000), completion proven by hasPaymentCompletion.' });
} else if (command === 'f1') {
  const lamports = async () => ({ base: await base.getBalance(fresh.publicKey), er: await er.getBalance(fresh.publicKey) });
  const before = await lamports();
  invariant(before.base === 0, 'F1 needs a zero-SOL payer.');
  let result: unknown, error: string | undefined;
  try { result = await roll(fresh); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  save('f1', { payer: fresh.publicKey, lamportsBefore: before, lamportsAfter: await lamports(), result, error, probe: await readProbe() });
} else if (command === 'f2') {
  const count = Number(process.argv[3] ?? 20);
  const runs = [];
  for (let index = 0; index < count; index++) { runs.push(await roll(fresh)); await sleep(250); }
  const sendToCallback = runs.map(run => run.sendToCallbackMs), confirmToCallback = runs.map(run => run.confirmToCallbackMs);
  save('f2', { payer: fresh.publicKey, count, sendToCallbackMs: { p50: percentile(sendToCallback, 50), p95: percentile(sendToCallback, 95), max: Math.max(...sendToCallback) },
    confirmToCallbackMs: { p50: percentile(confirmToCallback, 50), p95: percentile(confirmToCallback, 95), max: Math.max(...confirmToCallback) },
    dice: runs.map(run => run.die), freshLamports: { base: await base.getBalance(fresh.publicKey), er: await er.getBalance(fresh.publicKey) }, runs });
} else if (command === 'f9') {
  const before = await readProbe();
  const consume = (identity: PublicKey, signer: boolean) => new TransactionInstruction({ programId: PROGRAM,
    data: Buffer.concat([disc('consume_roll'), Buffer.alloc(32, 7), Buffer.from(new BigUint64Array([before.nonce]).buffer)]),
    keys: [meta(identity, signer, false), meta(probe, false, true)] });
  const unsigned = await sendEr([consume(scopedIdentity, false)], [fresh], true);
  const impostor = await sendEr([consume(fresh.publicKey, true)], [fresh], true);
  const globalIdentity = await sendEr([consume(new PublicKey('9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw'), false)], [fresh], true);
  const logs = async (signature: string) => signature ? (await erTransaction(signature)).meta?.logMessages?.filter(line => /Error|failed/.test(line)) : [];
  save('f9', { scopedIdentity, before, after: await readProbe(),
    attempts: [
      { case: 'scoped identity PDA passed unsigned', ...unsigned, logs: await logs(unsigned.signature) },
      { case: 'attacker wallet in the identity slot, signed', ...impostor, logs: await logs(impostor.signature) },
      { case: 'legacy global identity, unsigned', ...globalIdentity, logs: await logs(globalIdentity.signature) },
    ] });
} else if (command === 'f8') {
  const owners = [fresh.publicKey, ...state.recipients.map(key => new PublicKey(key)), new PublicKey(state.fee)];
  const amounts = [30_000n, 12_000n, 5_000n, 3_000n];
  const total = amounts.reduce((sum, value) => sum + value, 0n);
  const custodyBefore = (await er.getTokenAccountBalance(ata(probe))).value.amount;
  let fund: Awaited<ReturnType<typeof sendEr>> | undefined;
  if (BigInt(custodyBefore) < total) fund = await sendEr([createTransferInstruction(ata(fresh.publicKey), ata(probe), fresh.publicKey, total - BigInt(custodyBefore))], [fresh]);
  const data = Buffer.alloc(8 + 4 + 8 * amounts.length);
  disc('payout').copy(data); data.writeUInt32LE(amounts.length, 8);
  amounts.forEach((value, index) => data.writeBigUInt64LE(value, 12 + 8 * index));
  const ix = new TransactionInstruction({ programId: PROGRAM, data, keys: [
    meta(admin.publicKey, true, false), meta(probe, false, false), meta(ata(probe), false, true), meta(eata(probe), false, false), meta(TOKEN_PROGRAM_ID, false, false),
    ...owners.flatMap(owner => [meta(ata(owner), false, true), meta(eata(owner), false, false)])] });
  const sent = await sendEr([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix], [admin]);
  const tx = await erTransaction(sent.signature);
  const balances = await Promise.all(owners.map(async owner => ({ owner, amount: (await er.getTokenAccountBalance(ata(owner))).value.amount })));
  save('f8', { fund: fund?.signature, payout: sent.signature, recipients: owners.length, amounts, computeUnitsConsumed: tx.meta?.computeUnitsConsumed,
    transactionBytes: sent.size, accountKeys: tx.transaction.message.staticAccountKeys.length, custodyBefore,
    custodyAfter: (await er.getTokenAccountBalance(ata(probe))).value.amount, balances, logs: tx.meta?.logMessages });
} else if (command === 'f7') {
  const rpc = async (url: string, method: string, params: unknown[] = []) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    return response.json() as Promise<unknown>;
  };
  const status = await (await fetch('https://status.magicblock.app/api/services', { signal: AbortSignal.timeout(10_000) })).json() as {
    environments?: Record<string, { regions?: Record<string, unknown> }>; live_status?: unknown; meta?: unknown };
  save('f7', { at: new Date().toISOString(), erRpc: ER_RPC, routerRpc: ROUTER_RPC, baseRpc: BASE_RPC,
    erIdentity: await rpc(ER_RPC, 'getIdentity'), erVersion: await rpc(ER_RPC, 'getVersion'), erHealth: await rpc(ER_RPC, 'getHealth'),
    routerProbeRoute: await rpc(ROUTER_RPC, 'getDelegationStatus', [probe.toBase58()]), routerRoutes: await rpc(ROUTER_RPC, 'getRoutes'),
    queueOnEr: (await er.getAccountInfo(EPHEMERAL_QUEUE))?.owner, statusDevnet: status.environments?.devnet, statusMeta: status.meta });
} else {
  throw new Error('Usage: spike.ts <setup|f6-deposit|f1|f2|f9|f8|f6-withdraw|f7>');
}
