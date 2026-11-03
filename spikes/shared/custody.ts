import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { deriveEphemeralAta, initEphemeralAtaIx, delegateEphemeralAtaIx } from '@magicblock-labs/ephemeral-rollups-sdk';
import { DEVNET_USDC, PUBLIC_VALIDATOR, invariant } from './config';

const mint = new PublicKey(DEVNET_USDC);

export function tokenCustodyAddress(owner: PublicKey): PublicKey {
  return deriveEphemeralAta(owner, mint)[0];
}

// Host-funded setup on base. Call only after checking any existing delegation
// targets the selected public validator.
export function custodyInstructions(owner: PublicKey, payer: PublicKey, validator: PublicKey, initialize = true): TransactionInstruction[] {
  invariant(validator.toBase58() === PUBLIC_VALIDATOR, 'Room custody must use the configured public validator.');
  const eata = tokenCustodyAddress(owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(mint, owner, true), owner, mint),
    ...(initialize ? [initEphemeralAtaIx(eata, owner, mint, payer)] : []),
    delegateEphemeralAtaIx(payer, eata, validator),
  ];
}
