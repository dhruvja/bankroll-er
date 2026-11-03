import test from 'node:test';
import assert from 'node:assert/strict';
import { depositForEntry } from '../../shared/funding';

test('joining sweeps available base USDC only when play funds are needed, retaining sponsor fees and reserve', () => {
  assert.equal(depositForEntry(20_000_000n, 0n, 1_000_000n), 19_600_000n);
  assert.equal(depositForEntry(20_000_000n, 1_000_000n, 1_000_000n), 0n);
  assert.equal(depositForEntry(0n, 5_000_000n, 1_000_000n), 0n);
  assert.equal(depositForEntry(1_500_000_000n, 0n, 10_000_000n), 1_000_000_000n);
});

test('an insufficient balance still quotes the minimum usable deposit and never hides the entry shortfall', () => {
  assert.equal(depositForEntry(899_999n, 4_800_000n, 5_000_000n), 500_000n);
  assert.equal(depositForEntry(200_000n, 0n, 5_000_000n), 5_000_000n);
  assert.equal(depositForEntry(4_276_544n, 1_123_456n, 5_000_000n), 3_876_544n);
  assert.throws(() => depositForEntry(-1n, 0n, 1_000_000n), /nonnegative/);
  assert.throws(() => depositForEntry(2_000_000_000n, 0n, 1_000_000_001n), /1,000 USDC/);
});
