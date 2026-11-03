/**
 * Admin-only, idempotent pool bootstrap on base: creates and delegates Tables `--from`..`--tables`
 * (default 0..16), their USDC custody (ATA + eATA delegated to the pinned validator) and the
 * treasury custody. Rerun it to resume, or with a higher `--tables` to add tables.
 */
import { PublicKey } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { PUBLIC_VALIDATOR, invariant } from '../shared/config';
import { PROGRAM_ID, accountsFor, buildInstruction, custodyAddress, delegationStatus, tableAddress, tokenAddress, treasuryAddress } from '../shared/chain';
import { custodyInstructions } from '../shared/custody';
import { DEPLOYMENT, client, flags, loadAdmin, readDeployment, requireDevnet, saveArtifact, sendBase } from './node';
import { existsSync, writeFileSync } from 'node:fs';

const args = flags();
const count = Number(args.value('tables') ?? 16), from = Number(args.value('from') ?? 0);
invariant(Number.isInteger(count) && count > 0 && count <= 256 && Number.isInteger(from) && from >= 0 && from < count, 'Use --tables N (1-256) and --from M < N.');
await requireDevnet();
const admin = loadAdmin(), validator = new PublicKey(PUBLIC_VALIDATOR);
invariant((await client.base.getAccountInfo(PROGRAM_ID))?.executable, `Program ${PROGRAM_ID.toBase58()} is not deployed on devnet.`);
const lamportsBefore = await client.base.getBalance(admin.publicKey);
const signatures: Record<string, string> = {};

async function custody(owner: PublicKey, label: string) {
  const eata = await client.base.getAccountInfo(custodyAddress(owner));
  if (eata?.owner.equals(DELEGATION_PROGRAM_ID)) return;
  signatures[`${label}:custody`] = await sendBase(custodyInstructions(owner, admin.publicKey, validator, !eata), [admin]);
}

for (let index = from; index < count; index++) {
  const table = tableAddress(index), accounts = accountsFor(table, admin.publicKey);
  const account = await client.base.getAccountInfo(table);
  const instructions = [];
  if (!account) instructions.push(buildInstruction('create_table', accounts, { index }));
  if (!account || account.owner.equals(PROGRAM_ID)) instructions.push(buildInstruction('delegate_table', accounts, { index }));
  if (instructions.length) signatures[`table:${index}`] = await sendBase(instructions, [admin]);
  await custody(table, `table:${index}`);
  console.log(`table ${index} ${table.toBase58()} ready`);
}
await custody(treasuryAddress(), 'treasury');

// Verify on the router and the ER; reading each account on the ER also loads it there.
const verified = [];
for (let index = 0; index < count; index++) {
  const table = tableAddress(index);
  const route = await delegationStatus(table);
  invariant(route.isDelegated && route.delegationRecord?.authority === PUBLIC_VALIDATOR, `Table ${index} is not delegated to ${PUBLIC_VALIDATOR}.`);
  let view;
  for (let attempt = 0; attempt < 30 && !view; attempt++) {
    view = await client.readTable(table).catch(() => undefined);
    if (!view) await new Promise(done => setTimeout(done, 1000));
  }
  invariant(view, `Table ${index} did not appear on the ER.`);
  const eata = await client.er.getAccountInfo(custodyAddress(table));
  invariant(eata?.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), `Table ${index} custody is not live on the ER.`);
  verified.push({ index, table: table.toBase58(), phase: view.phase, gameNonce: view.gameNonce, custody: tokenAddress(table).toBase58(), fqdn: route.fqdn });
}
const lamportsAfter = await client.base.getBalance(admin.publicKey);
const previous = existsSync(DEPLOYMENT) ? readDeployment() : undefined;
const deployment = { programId: PROGRAM_ID.toBase58(), validator: PUBLIC_VALIDATOR, tables: Math.max(count, previous?.tables ?? 0),
  treasury: treasuryAddress().toBase58(), bootstrappedAt: previous?.bootstrappedAt ?? new Date().toISOString() };
writeFileSync(DEPLOYMENT, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(saveArtifact('bootstrap.json', { at: new Date().toISOString(), admin: admin.publicKey.toBase58(), from, count, deployment, signatures,
  adminLamports: { before: lamportsBefore, after: lamportsAfter, spent: lamportsBefore - lamportsAfter }, tables: verified }));
