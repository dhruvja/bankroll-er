import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction } from "@solana/web3.js";
import { createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { delegateSpl, withdrawSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_USDC as MINT, PUBLIC_VALIDATOR as VALIDATOR } from "../../shared/config";
const DEVNET_USDC = new PublicKey(MINT), PUBLIC_VALIDATOR = new PublicKey(VALIDATOR);
import { validatePayment as validateClientPayment } from "../../shared/payments.ts";

async function fixture(operation: "deposit" | "withdraw", privateDeposit = false) {
  const owner = Keypair.generate();
  const sponsor = Keypair.generate();
  const amount = 1_000_000n;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const options = { payer: sponsor.publicKey, validator: PUBLIC_VALIDATOR, shuttleId: 42, escrowIndex: 0, initIfMissing: true, initAtasIfMissing: true, idempotent: true };
  const instructions = operation === "deposit"
    ? await delegateSpl(owner.publicKey, DEVNET_USDC, amount, { ...options, private: privateDeposit, initVaultIfMissing: true })
    : await withdrawSpl(owner.publicKey, DEVNET_USDC, amount, options);
  const transaction = new Transaction({ feePayer: sponsor.publicKey, recentBlockhash: blockhash }).add(
    createTransferInstruction(getAssociatedTokenAddressSync(DEVNET_USDC, owner.publicKey), getAssociatedTokenAddressSync(DEVNET_USDC, sponsor.publicKey), owner.publicKey, 200_000n), ...instructions,
  );
  transaction.partialSign(sponsor);
  const build = {
    kind: operation, version: "legacy", sendTo: "base", validator: PUBLIC_VALIDATOR.toBase58(),
    transactionBase64: transaction.serialize({ requireAllSignatures: false }).toString("base64"),
    recentBlockhash: blockhash, lastValidBlockHeight: 100, requiredSigners: [sponsor.publicKey.toBase58(), owner.publicKey.toBase58()],
    instructionCount: transaction.instructions.length, fees: { tokens: "200000", lamports: "0" },
  };
  return { owner, amount, build };
}

for (const [label, validate] of [["browser", validateClientPayment]] as const) {
for (const operation of ["deposit", "withdraw"] as const) {
  test(`${label}: accepts exact sponsored ${operation}, rejects changed amount, fee and validator`, async () => {
    const { owner, amount, build } = await fixture(operation);
    await validate(build, owner.publicKey, operation, amount);
    await assert.rejects(validate(build, owner.publicKey, operation, amount + 1n), /differs/);
    await assert.rejects(validate({ ...build, fees: { ...build.fees, tokens: "200001" } }, owner.publicKey, operation, amount), /fee/);
    await assert.rejects(validate({ ...build, validator: owner.publicKey.toBase58() }, owner.publicKey, operation, amount), /validator/);
    await assert.rejects(validate(build, Keypair.generate().publicKey, operation, amount), /signer|signature/i);
    await assert.rejects(validate({ ...build, sendTo: "ephemeral" }, owner.publicKey, operation, amount), /routing/);
    const unsigned = Transaction.from(Buffer.from(build.transactionBase64, "base64"));
    unsigned.signatures[0].signature = null;
    await assert.rejects(validate({ ...build, transactionBase64: unsigned.serialize({ requireAllSignatures: false }).toString("base64") }, owner.publicKey, operation, amount), /signature/i);
  });
}

test(`${label}: rejects a private deposit even when sponsor signs it`, async () => {
  const { owner, amount, build } = await fixture("deposit", true);
  await assert.rejects(validate(build, owner.publicKey, "deposit", amount), /differs/);
});
}
