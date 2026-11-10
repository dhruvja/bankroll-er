/** G10: the house owes nothing (`liability == 0`, no table holds money) and every live table is
 * Free. Run before any layout-changing redeploy, rollback, or validator/ER migration (audit F-2). */
import { PROGRAM_ID } from '../shared/chain';
import { readDeployment, readHouseStatus, requireDevnet, saveArtifact } from './node';

await requireDevnet();
readDeployment();
const status = await readHouseStatus();
const offending = status.tables.filter(table => table.phase !== 'free' || table.held !== 0n);
const ok = status.ok && status.house.liability === 0n && offending.length === 0;
console.log(saveArtifact('drain-check.json', { ok, at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), liability: status.house.liability,
  vault: status.vault, strays: status.strays, tables: status.tables.map(({ address, phase, held }) => ({ address, phase, held })), offending }));
if (!ok) process.exit(1);
