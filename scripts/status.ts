/**
 * Read-only pool report from the ER: occupancy, tables that need a client or operator action
 * (expired lobbies, games past the idle deadline, failing settles, pending refunds), custody
 * against what each table owes, and the treasury balance. Exits 1 when any custody is short.
 */
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, treasuryAddress } from '../shared/chain';
import { poolStatus } from '../shared/status';
import { client, readDeployment, requireDevnet, saveArtifact } from './node';

await requireDevnet();
const deployment = readDeployment();
const tables = await client.readTables(deployment.tables);
const custody = await Promise.all(tables.map(table => client.erTokenBalance(new PublicKey(table.address))));
const status = poolStatus(tables, custody, await client.erTokenBalance(treasuryAddress()), await client.erNow());
console.log(saveArtifact(process.env.BANKROLL_STATUS_FILE ?? 'status.json', { at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), ...status }));
if (!status.ok) process.exit(1);
