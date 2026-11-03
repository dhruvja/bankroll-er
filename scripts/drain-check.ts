/** G10: every table is Free with zero custody. Run before any layout-changing redeploy. */
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, decodeTable, idl } from '../shared/chain';
import { client, readDeployment, requireDevnet, saveArtifact } from './node';

await requireDevnet();
const deployment = readDeployment();
const listed = await client.er.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters: [
  { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(idl.accounts!.find(item => item.name === 'Table')!.discriminator)) } },
] });
const known = new Map((await client.readTables(deployment.tables)).map(table => [table.address, table]));
for (const { pubkey, account } of listed) {
  if (!known.has(pubkey.toBase58())) known.set(pubkey.toBase58(), decodeTable(pubkey, account.data));
}
const tables = [];
for (const table of [...known.values()].sort((a, b) => a.index - b.index)) {
  const custody = await client.erTokenBalance(new PublicKey(table.address));
  tables.push({ index: table.index, address: table.address, phase: table.phase, gameNonce: table.gameNonce, custody: custody.toString() });
}
const offending = tables.filter(table => table.phase !== 'free' || table.custody !== '0');
const result = { ok: offending.length === 0, at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), tables, offending };
console.log(saveArtifact('drain-check.json', result));
if (!result.ok) process.exit(1);
