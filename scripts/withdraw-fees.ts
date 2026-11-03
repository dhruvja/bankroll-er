/**
 * ADMIN fee withdrawal. Moves `--amount` atoms (default: the whole treasury) from the treasury
 * custody to the admin's own ER account with `withdraw_fees`, then, unless `--keep-on-er`, sends
 * the admin's ER balance to base through the sponsored Payments API withdraw (0.50 USDC minimum,
 * 0.20 relay fee paid from the admin's base USDC). The first run creates and delegates the admin's
 * eATA on base (admin pays the rent), as bootstrap does for tables.
 */
import { PublicKey } from '@solana/web3.js';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { PUBLIC_VALIDATOR, RELAY_FEE, TOKEN_SCALE, WITHDRAW_MINIMUM, invariant } from '../shared/config';
import { custodyAddress, tokenAddress, treasuryAddress } from '../shared/chain';
import { custodyInstructions } from '../shared/custody';
import { client, filePayments, flags, loadAdmin, requireDevnet, saveArtifact, sendBase } from './node';

const args = flags();
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const usdc = (atoms: bigint) => (Number(atoms) / TOKEN_SCALE).toFixed(6);
await requireDevnet();
const admin = loadAdmin(), treasury = treasuryAddress();
const signatures: Record<string, string> = {};

const eata = await client.base.getAccountInfo(custodyAddress(admin.publicKey));
if (!eata?.owner.equals(DELEGATION_PROGRAM_ID)) {
  signatures.adminCustody = await sendBase(custodyInstructions(admin.publicKey, admin.publicKey, new PublicKey(PUBLIC_VALIDATOR), !eata), [admin]);
}
for (let attempt = 0; attempt < 60; attempt++) {
  const [token, custody] = await client.er.getMultipleAccountsInfo([tokenAddress(admin.publicKey), custodyAddress(admin.publicKey)], 'confirmed');
  if (token && custody?.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID)) break;
  invariant(attempt < 59, 'The admin custody did not appear on the ER.');
  await pause(1000);
}

const before = { treasury: await client.erTokenBalance(treasury), adminEr: await client.erTokenBalance(admin.publicKey), adminBase: (await client.walletBalances(admin.publicKey)).base };
const amount = BigInt(args.value('amount') ?? before.treasury.toString());
invariant(amount > 0n && amount <= before.treasury, `Nothing to withdraw: treasury ${usdc(before.treasury)}, asked ${usdc(amount)}.`);
signatures.withdrawFees = (await client.withdrawFees(admin, amount)).signature;
let after = before;
for (let poll = 0; poll < 40; poll++) {
  after = { ...before, treasury: await client.erTokenBalance(treasury), adminEr: await client.erTokenBalance(admin.publicKey) };
  if (after.treasury === before.treasury - amount && after.adminEr === before.adminEr + amount) break;
  await pause(500);
}
const erExact = after.treasury === before.treasury - amount && after.adminEr === before.adminEr + amount;
invariant(erExact, `ER balances did not move by ${amount}: ${JSON.stringify({ before, after }, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item)}`);

let toBase: { amount: string; baseBefore: string; baseAfter: string; landed: boolean } | undefined;
if (!args.has('keep-on-er')) {
  invariant(after.adminEr >= BigInt(WITHDRAW_MINIMUM), `The admin ER balance ${usdc(after.adminEr)} is below the 0.50 withdraw minimum; rerun later or pass --keep-on-er.`);
  invariant(before.adminBase >= BigInt(RELAY_FEE), 'The admin needs 0.20 base USDC for the relay fee.');
  const { payments, signatures: paid } = filePayments();
  await payments.execute(admin, 'withdraw', after.adminEr);
  const baseAfter = (await client.walletBalances(admin.publicKey)).base;
  toBase = { amount: usdc(after.adminEr), baseBefore: usdc(before.adminBase), baseAfter: usdc(baseAfter),
    landed: baseAfter === before.adminBase - BigInt(RELAY_FEE) + after.adminEr };
  invariant(toBase.landed, `Base withdraw mismatch: ${JSON.stringify(toBase)}`);
  for (const item of paid) signatures[`payments:${item.operation}`] = item.signature;
}
console.log(saveArtifact('withdraw-fees.json', { ok: true, at: new Date().toISOString(), admin: admin.publicKey.toBase58(), treasury: treasury.toBase58(),
  amount: usdc(amount), erBefore: { treasury: usdc(before.treasury), admin: usdc(before.adminEr) }, erAfter: { treasury: usdc(after.treasury), admin: usdc(after.adminEr) },
  erExact, toBase, signatures }));
