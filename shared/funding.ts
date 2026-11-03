import { RELAY_FEE, invariant } from './config';

/** Amount to move into play when an entry needs funding, in integer USDC micro-units. */
export function depositForEntry(base: bigint, play: bigint, entry: bigint): bigint {
  invariant(base >= 0n && play >= 0n && entry >= 0n, 'Wallet balances and entry must be nonnegative.');
  if (play >= entry) return 0n;
  const shortfall = entry - play, minimum = 500_000n, maximum = 1_000_000_000n;
  invariant(shortfall <= maximum, 'An entry cannot require more than 1,000 USDC in one deposit.');
  const available = base - BigInt(RELAY_FEE) * 2n;
  const sweep = available > maximum ? maximum : available;
  const needed = shortfall > minimum ? shortfall : minimum;
  // Returning the required minimum when underfunded lets the UI show an actionable quote.
  return sweep > needed ? sweep : needed;
}
