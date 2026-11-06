export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const BASE_RPC = 'https://rpc.magicblock.app/devnet';
export const ER_RPC = 'https://devnet-as.magicblock.app';
export const PUBLIC_VALIDATOR = 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57';
export const PAYMENTS_API = 'https://payments.magicblock.app';
export const PAYMENT_CLUSTER = 'devnet';
export const RELAY_FEE = 200_000;
export const ROUTER_RPC = 'https://devnet-router.magicblock.app';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const VRF_PROGRAM = 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz';
export const EPHEMERAL_QUEUE = '5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc';
export const TOKEN_SCALE = 1_000_000;
export const PROTOCOL_FEE_BPS = 300;
export const WITHDRAW_MINIMUM = 500_000;
export const ENTRIES = [1_000, 1_000_000, 5_000_000] as const;
/** /demo tables play for 0.001 USDC, funded by the faucet; the USDC mode offers the rest. */
export const DEMO_ENTRY = ENTRIES[0];
export const PAID_ENTRIES = ENTRIES.slice(1);
/** Ranked shares in bps of the pot, by player count (mirrors the program `const`). */
export const SHARES_BPS: Record<number, number[]> = { 2: [9700], 3: [6700, 3000], 4: [6000, 2700, 1000] };
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
