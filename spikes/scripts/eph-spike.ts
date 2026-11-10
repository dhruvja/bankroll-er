/** On-demand table spike: a delegated program PDA sponsors ER-only Tables that a zero-SOL host creates,
 * rolls VRF dice into, and closes. Usage: pnpm spike scripts/eph-spike.ts */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Transaction, TransactionInstruction, type AccountMeta, type Signer,
} from '@solana/web3.js';
import {
  DELEGATION_PROGRAM_ID, delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { invariant } from '../shared/config';
import { DirectChainClient } from '../shared/client';

const PROGRAM = new PublicKey(process.env.SPIKE_PROGRAM ?? '6ry644nw1mhuggqxWPVAZLwpyDwbsPvPydSkBVMzWD7X');
const VRF_PROGRAM = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const TABLE_SPACE = 1503, RENT = (TABLE_SPACE + 60) * 32;
const SPONSOR_FUNDING = Number(process.env.SPONSOR_FUNDING ?? 20_000_000); // default 0.02 SOL: about 400 tables open at once
const ARTIFACTS = resolve(import.meta.dirname, '../../../plans/bankroll/artifacts/eph-spike');

const { base, er } = new DirectChainClient();
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(homedir(), '.config/solana/id.json'), 'utf8')) as number[]));
const [sponsor] = PublicKey.findProgramAddressSync([Buffer.from('sponsor')], PROGRAM);
const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from('identity')], PROGRAM);
const tableAddress = (id: bigint) => PublicKey.findProgramAddressSync([Buffer.from('eph_table'), u64(id)], PROGRAM)[0];
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64 = (value: bigint) => { const out = Buffer.alloc(8); out.writeBigUInt64LE(value); return out; };
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

async function sendBase(instructions: TransactionInstruction[], signers: Signer[]) {
  const latest = await base.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(...instructions);
  tx.sign(...signers);
  const signature = await base.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const result = await base.confirmTransaction({ signature, ...latest }, 'confirmed');
  invariant(!result.value.err, `Base transaction failed: ${signature} ${JSON.stringify(result.value.err)}`);
  return signature;
}

async function sendEr(instructions: TransactionInstruction[], signers: Signer[]) {
  const { blockhash } = await er.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: blockhash }).add(...instructions);
  tx.sign(...signers);
  const sentAt = Date.now();
  let signature: string;
  try { signature = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 }); }
  catch (error) { return { signature: '', ms: Date.now() - sentAt, err: error instanceof Error ? error.message : String(error) }; }
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = (await er.getSignatureStatuses([signature])).value[0];
    if (status?.err) {
      const logs = (await er.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages;
      return { signature, ms: Date.now() - sentAt, err: JSON.stringify(status.err), logs: logs?.slice(-6) };
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { signature, ms: Date.now() - sentAt, err: null };
    await sleep(100);
  }
  throw new Error(`ER transaction not confirmed: ${signature}`);
}
async function mustEr(label: string, instructions: TransactionInstruction[], signers: Signer[]) {
  const result = await sendEr(instructions, signers);
  invariant(!result.err, `${label} failed: ${result.err} ${JSON.stringify(result.logs ?? [])}`);
  return result;
}

const lifecycleIx = (name: 'create_table' | 'close_table', host: PublicKey, id: bigint) => new TransactionInstruction({
  programId: PROGRAM, data: Buffer.concat([disc(name), u64(id)]),
  keys: [meta(host, true, false), meta(sponsor, false, true), meta(tableAddress(id), false, true), meta(EPHEMERAL_VAULT, false, true), meta(MAGIC_PROGRAM, false, false)],
});
const requestRollIx = (payer: PublicKey, id: bigint) => new TransactionInstruction({
  programId: PROGRAM, data: disc('request_roll'),
  keys: [meta(payer, true, true), meta(tableAddress(id), false, true), meta(EPHEMERAL_QUEUE, false, true), meta(programIdentity, false, false),
    meta(VRF_PROGRAM, false, false), meta(SYSVAR_SLOT_HASHES_PUBKEY, false, false), meta(SystemProgram.programId, false, false)],
});

interface TableView { id: bigint; host: string; nonce: bigint; pending: boolean; die: number; fulfilled: number; owner: string; size: number }
async function readTable(id: bigint): Promise<TableView | null> {
  const info = await er.getAccountInfo(tableAddress(id), 'confirmed');
  if (!info) return null;
  if (info.data.length < 63) return { raw: true, owner: info.owner.toBase58(), lamports: info.lamports, size: info.data.length } as unknown as TableView;
  const d = info.data;
  return { id: d.readBigUInt64LE(8), host: new PublicKey(d.subarray(16, 48)).toBase58(), nonce: d.readBigUInt64LE(48), pending: d[56] === 1,
    die: d[57], fulfilled: d.readUInt32LE(58), owner: info.owner.toBase58(), size: d.length };
}
const sponsorLamports = async () => (await er.getAccountInfo(sponsor, 'confirmed'))?.lamports ?? 0;

async function setup() {
  const signatures: Record<string, string> = {};
  const onBase = await base.getAccountInfo(sponsor);
  if (!onBase) {
    signatures.init = await sendBase([new TransactionInstruction({ programId: PROGRAM, data: disc('init_sponsor'),
      keys: [meta(admin.publicKey, true, true), meta(sponsor, false, true), meta(SystemProgram.programId, false, false)] }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sponsor, lamports: SPONSOR_FUNDING })], [admin]);
  }
  if (!(await base.getAccountInfo(sponsor))?.owner.equals(DELEGATION_PROGRAM_ID)) {
    signatures.delegate = await sendBase([new TransactionInstruction({ programId: PROGRAM, data: disc('delegate_sponsor'), keys: [
      meta(admin.publicKey, true, true), meta(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(sponsor, PROGRAM), false, true),
      meta(delegationRecordPdaFromDelegatedAccount(sponsor), false, true), meta(delegationMetadataPdaFromDelegatedAccount(sponsor), false, true),
      meta(sponsor, false, true), meta(PROGRAM, false, false), meta(DELEGATION_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false)] })], [admin]);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await er.getAccountInfo(sponsor, 'confirmed');
    if (info?.owner.equals(PROGRAM)) return { signatures, sponsorOnEr: info.lamports };
    await sleep(300);
  }
  throw new Error('Sponsor never appeared on the ER.');
}

async function rollUntilCallback(host: Keypair, id: bigint) {
  const before = await readTable(id);
  invariant(before && !before.pending, 'Table missing or a roll is pending.');
  const sent = await mustEr('request_roll', [requestRollIx(host.publicKey, id)], [host]);
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 600; attempt++) {
    const view = await readTable(id);
    if (view && view.fulfilled > before.fulfilled) return { request: sent.signature, die: view.die, nonce: view.nonce, callbackMs: Date.now() - startedAt + sent.ms };
    await sleep(50);
  }
  throw new Error(`No VRF callback within 30 s for ${sent.signature}`);
}


const mode = process.env.SPIKE_MODE ?? 'lifecycle';
if (mode === 'unblock') {
  // Audit L-1 fix candidate: a permissionless base-layer sweep of SOL sent to an unused table address.
  const host = Keypair.generate(), sweeper = admin;
  const report: Record<string, unknown> = { program: PROGRAM.toBase58(), mode };
  report.setup = await setup();
  const id = BigInt(Date.now()), table = tableAddress(id);
  const unblockIx = new TransactionInstruction({ programId: PROGRAM, data: Buffer.concat([disc('unblock_table'), u64(id)]),
    keys: [meta(sweeper.publicKey, true, true), meta(table, false, true), meta(SystemProgram.programId, false, false)] });
  report.id = id.toString(); report.table = table.toBase58();
  report.prefund = await sendBase([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: table, lamports: 1_000_000 })], [admin]);
  await sleep(3000);
  report.blockedCreate = await sendEr([lifecycleIx('create_table', host.publicKey, id)], [host]);
  const sweeperBefore = await base.getBalance(sweeper.publicKey);
  report.unblock = await sendBase([unblockIx], [sweeper]);
  report.sweeperDelta = (await base.getBalance(sweeper.publicKey)) - sweeperBefore;
  report.baseAfterUnblock = await base.getAccountInfo(table);
  const started = Date.now();
  let erView: unknown = 'still cloned';
  for (let attempt = 0; attempt < 60; attempt++) {
    const info = await er.getAccountInfo(table, 'confirmed');
    if (!info || info.lamports === 0) { erView = info ? { lamports: info.lamports, owner: info.owner.toBase58() } : null; break; }
    await sleep(500);
  }
  report.erAfterUnblock = { view: erView, waitedMs: Date.now() - started };
  report.createAfterUnblock = await sendEr([lifecycleIx('create_table', host.publicKey, id)], [host]);
  report.tableAfterUnblock = await readTable(id);
  if ((report.tableAfterUnblock as { owner?: string } | null)?.owner === PROGRAM.toBase58()) {
    report.roll = await rollUntilCallback(host, id).catch(error => String(error));
    report.close = await sendEr([lifecycleIx('close_table', host.publicKey, id)], [host]);
  }
  // A sweep against a live ER table address must do nothing harmful: on base the address is empty.
  report.unblockWhenEmpty = await sendBase([unblockIx], [sweeper]).catch(error => String(error).slice(0, 200));
  mkdirSync(ARTIFACTS, { recursive: true });
  const text = JSON.stringify(report, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
  writeFileSync(resolve(ARTIFACTS, `unblock-${id}.json`), `${text}\n`);
  console.log(text);
  process.exit(0);
}

if (mode === 'prefund') {
  // Audit question: can anyone block a table address by sending SOL to it on base first?
  const host = Keypair.generate();
  const report: Record<string, unknown> = { program: PROGRAM.toBase58(), mode };
  report.setup = await setup();
  const fund = async (id: bigint) => sendBase([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: tableAddress(id), lamports: 1_000_000 })], [admin]);
  // A: prefund on base, then create on the ER.
  const a = BigInt(Date.now());
  report.a = { id: a.toString(), table: tableAddress(a).toBase58(), prefund: await fund(a) };
  await sleep(3000);
  const erBefore = await er.getAccountInfo(tableAddress(a), 'confirmed');
  (report.a as Record<string, unknown>).erBefore = erBefore ? { owner: erBefore.owner.toBase58(), lamports: erBefore.lamports } : null;
  (report.a as Record<string, unknown>).create = await sendEr([lifecycleIx('create_table', host.publicKey, a)], [host]);
  (report.a as Record<string, unknown>).after = await readTable(a);
  // B: create on the ER, then prefund on base; does the ER table survive and keep working?
  const b = a + 1n;
  (report as Record<string, unknown>).b = { id: b.toString(), table: tableAddress(b).toBase58(), create: await mustEr('create b', [lifecycleIx('create_table', host.publicKey, b)], [host]) };
  (report.b as Record<string, unknown>).prefund = await fund(b);
  await sleep(5000);
  (report.b as Record<string, unknown>).afterPrefund = await readTable(b);
  (report.b as Record<string, unknown>).roll = await rollUntilCallback(host, b).catch(error => String(error));
  (report.b as Record<string, unknown>).close = await sendEr([lifecycleIx('close_table', host.publicKey, b)], [host]);
  (report.b as Record<string, unknown>).afterClose = await readTable(b);
  const aState = await readTable(a);
  if (aState) (report.a as Record<string, unknown>).close = await sendEr([lifecycleIx('close_table', host.publicKey, a)], [host]);
  mkdirSync(ARTIFACTS, { recursive: true });
  const text = JSON.stringify(report, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
  writeFileSync(resolve(ARTIFACTS, `prefund-${a}.json`), `${text}\n`);
  console.log(text);
  process.exit(0);
}

const host = Keypair.generate(), stranger = Keypair.generate();
const id = BigInt(Date.now());
const report: Record<string, unknown> = { program: PROGRAM.toBase58(), sponsor: sponsor.toBase58(), host: host.publicKey.toBase58(), id: id.toString(), table: tableAddress(id).toBase58() };
report.hostBaseLamports = await base.getBalance(host.publicKey);
report.setup = await setup();

const beforeCreate = await sponsorLamports();
report.create = await mustEr('create_table', [lifecycleIx('create_table', host.publicKey, id)], [host]);
const afterCreate = await sponsorLamports();
report.createRent = { charged: beforeCreate - afterCreate, expected: RENT };
report.tableOnEr = await readTable(id);
report.tableOnBase = (await base.getAccountInfo(tableAddress(id))) !== null;
report.duplicateCreate = await sendEr([lifecycleIx('create_table', host.publicKey, id)], [host]);

const listed = await er.getProgramAccounts(PROGRAM, { commitment: 'confirmed', filters: [{ dataSize: TABLE_SPACE }, { memcmp: { offset: 16, bytes: host.publicKey.toBase58() } }] });
report.getProgramAccounts = listed.map(entry => entry.pubkey.toBase58());

const rolls = [];
for (let i = 0; i < 5; i++) rolls.push(await rollUntilCallback(host, id));
report.rolls = rolls;

report.strangerClose = await sendEr([lifecycleIx('close_table', stranger.publicKey, id)], [stranger]);
const beforeClose = await sponsorLamports();
report.close = await mustEr('close_table', [lifecycleIx('close_table', host.publicKey, id)], [host]);
report.closeRefund = { refunded: (await sponsorLamports()) - beforeClose, expected: RENT };
report.tableAfterClose = await readTable(id);

report.recreate = await mustEr('create_table again', [lifecycleIx('create_table', host.publicKey, id)], [host]);
report.recreatedTable = await readTable(id);
report.recreateRoll = await rollUntilCallback(host, id);
report.closeAgain = await mustEr('close_table again', [lifecycleIx('close_table', host.publicKey, id)], [host]);
report.sponsorEnd = { lamports: await sponsorLamports(), start: beforeCreate };
report.hostBaseLamportsEnd = await base.getBalance(host.publicKey);

mkdirSync(ARTIFACTS, { recursive: true });
const text = JSON.stringify(report, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
writeFileSync(resolve(ARTIFACTS, `run-${id}.json`), `${text}\n`);
console.log(text);
