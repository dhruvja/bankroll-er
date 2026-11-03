export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const BASE_RPC = 'https://rpc.magicblock.app/devnet';
export const ER_RPC = 'https://devnet-as.magicblock.app';
export const PUBLIC_VALIDATOR = 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57';
export const PAYMENTS_API = 'https://payments.magicblock.app';
export const PAYMENT_CLUSTER = 'devnet';
export const RELAY_FEE = 200_000;
export const ROUTER_RPC = 'https://devnet-router.magicblock.app';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const TOKEN_SCALE = 1_000_000;
export const PROTOCOL_FEE_BPS = 300;
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function splitPot(total: bigint) {
  invariant(total >= 0n, 'Pot cannot be negative.');
  const fee = total * BigInt(PROTOCOL_FEE_BPS) / 10_000n;
  return { fee, prize: total - fee };
}
