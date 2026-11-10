/**
 * Admin-only, idempotent house setup on base: `init_house`, fund it with `--sol` (default 0.1) of
 * table rent above its rent-exempt minimum, give it the vault custody (USDC ATA + eATA delegated to
 * the pinned validator), delegate it, check the treasury custody, then verify the house and vault
 * on the router and the ER and write `shared/deployment.json`. Each step is skipped when done, so
 * a rerun resumes. The house cannot be topped up once delegated, so funding happens first.
 */
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { PUBLIC_VALIDATOR, invariant } from '../shared/config';
import { HOUSE_SPACE, PROGRAM_ID, accountsFor, buildInstruction, custodyAddress, delegationStatus, houseAddress, tokenAddress, treasuryAddress } from '../shared/chain';
import { custodyInstructions } from '../shared/custody';
import { DEPLOYMENT, client, flags, loadAdmin, requireDevnet, saveArtifact, sendBase } from './node';
import { writeFileSync } from 'node:fs';

const budget = Math.round(Number(flags().value('sol') ?? 0.1) * LAMPORTS_PER_SOL);
invariant(budget > 0 && budget <= LAMPORTS_PER_SOL, 'Use --sol between 0 and 1.');
await requireDevnet();
const admin = loadAdmin(), validator = new PublicKey(PUBLIC_VALIDATOR), house = houseAddress();
invariant((await client.base.getAccountInfo(PROGRAM_ID))?.executable, `Program ${PROGRAM_ID.toBase58()} is not deployed on devnet.`);
const lamportsBefore = await client.base.getBalance(admin.publicKey);
const rentExempt = await client.base.getMinimumBalanceForRentExemption(HOUSE_SPACE), target = rentExempt + budget;
const signatures: Record<string, string> = {};
const accounts = accountsFor(PublicKey.default, admin.publicKey);

let account = await client.base.getAccountInfo(house);
if (!account) {
  signatures.initHouse = await sendBase([buildInstruction('init_house', accounts)], [admin]);
  account = await client.base.getAccountInfo(house);
}
invariant(account, 'The house was not created.');
// Custody before delegation: the vault's ATA and eATA belong to the house, not to its data.
async function custody(owner: PublicKey, label: string) {
  const eata = await client.base.getAccountInfo(custodyAddress(owner));
  if (eata?.owner.equals(DELEGATION_PROGRAM_ID)) return;
  signatures[`${label}Custody`] = await sendBase(custodyInstructions(owner, admin.publicKey, validator, !eata), [admin]);
}
await custody(house, 'vault');
await custody(treasuryAddress(), 'treasury');
if (account.owner.equals(PROGRAM_ID)) {
  const instructions = [];
  if (account.lamports < target) instructions.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: house, lamports: target - account.lamports }));
  instructions.push(buildInstruction('delegate_house', accounts));
  signatures.fundAndDelegate = await sendBase(instructions, [admin]);
} else invariant(account.owner.equals(DELEGATION_PROGRAM_ID), `The house is owned by ${account.owner.toBase58()}.`);

// Verify on the router and the ER; reading each account on the ER also loads it there.
const route = await delegationStatus(house);
invariant(route.isDelegated && route.delegationRecord?.authority === PUBLIC_VALIDATOR, `The house is not delegated to ${PUBLIC_VALIDATOR}.`);
let onEr;
for (let attempt = 0; attempt < 30 && !onEr; attempt++) {
  onEr = await client.readHouse().catch(() => undefined);
  if (!onEr) await new Promise(done => setTimeout(done, 1000));
}
invariant(onEr, 'The house did not appear on the ER.');
for (const owner of [house, treasuryAddress()]) {
  invariant((await client.er.getAccountInfo(custodyAddress(owner)))?.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), `${owner.toBase58()} custody is not live on the ER.`);
}
const deployment = { programId: PROGRAM_ID.toBase58(), validator: PUBLIC_VALIDATOR, house: house.toBase58(), vault: tokenAddress(house).toBase58(),
  vaultEata: custodyAddress(house).toBase58(), treasury: treasuryAddress().toBase58(), houseLamports: onEr.lamports, setupAt: new Date().toISOString() };
writeFileSync(DEPLOYMENT, `${JSON.stringify(deployment, null, 2)}\n`);
const lamportsAfter = await client.base.getBalance(admin.publicKey);
console.log(saveArtifact('setup-house.json', { at: new Date().toISOString(), admin: admin.publicKey.toBase58(), deployment, signatures, rentExempt, budget,
  house: { ...onEr, route: route.fqdn }, adminLamports: { before: lamportsBefore, after: lamportsAfter, spent: lamportsBefore - lamportsAfter } }));
