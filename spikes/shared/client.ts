// Minimal stand-in for bomberman's DirectChainClient: only the surface SponsoredPayments uses.
import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID, deriveEphemeralAta } from '@magicblock-labs/ephemeral-rollups-sdk';
import { BASE_RPC, DEVNET_USDC, ER_RPC, PUBLIC_VALIDATOR, ROUTER_RPC, invariant } from './config';

export const mintKey = new PublicKey(DEVNET_USDC);

export async function delegationStatus(account: PublicKey) {
  const response = await fetch(ROUTER_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { error?: unknown; result?: { isDelegated: boolean; fqdn?: string; delegationRecord?: { authority?: string } } };
  invariant(!body.error && body.result, 'Router getDelegationStatus failed.');
  return body.result;
}

export class DirectChainClient {
  readonly base = new Connection(BASE_RPC, 'confirmed');
  readonly er = new Connection(ER_RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true });

  async walletBalances(owner: PublicKey) {
    const token = getAssociatedTokenAddressSync(mintKey, owner, true), [eata] = deriveEphemeralAta(owner, mintKey);
    const [lamports, baseAccount, custody] = await Promise.all([this.base.getBalance(owner), this.base.getAccountInfo(token), this.base.getAccountInfo(eata)]);
    const amount = (account: AccountInfo<Buffer> | null) => {
      if (!account) return 0n;
      const value = unpackAccount(token, account);
      invariant(value.mint.equals(mintKey) && value.owner.equals(owner), 'Unexpected USDC account.');
      return value.amount;
    };
    let play = 0n;
    if (custody?.owner.equals(DELEGATION_PROGRAM_ID)) {
      const route = await delegationStatus(eata);
      invariant(route.isDelegated && route.delegationRecord?.authority === PUBLIC_VALIDATOR, 'eATA delegated to another validator.');
      const projected = await this.er.getAccountInfo(eata);
      invariant(projected?.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), 'Play balance still reaching the rollup.');
      play = amount(await this.er.getAccountInfo(token));
    } else invariant(!custody || custody.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), 'Unexpected USDC custody account.');
    return { base: amount(baseAccount), er: play, lamports };
  }
}
