/**
 * Read-only house report from the ER: house lamports and how many more tables it can sponsor,
 * live tables by phase and those awaiting a client crank, each table's `held` against what it owes,
 * the house `liability` against the vault and against the tables' `held`, strays and the treasury.
 * Exits 1 on a shortfall or a liability mismatch.
 */
import { PROGRAM_ID } from '../shared/chain';
import { readDeployment, readHouseStatus, requireDevnet, saveArtifact } from './node';

await requireDevnet();
readDeployment();
const status = await readHouseStatus();
console.log(saveArtifact(process.env.BANKROLL_STATUS_FILE ?? 'status.json', { at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), ...status }));
if (!status.ok) process.exit(1);
