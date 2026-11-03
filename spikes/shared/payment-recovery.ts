import { PublicKey, type Connection, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction, type Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { deriveShuttleAta, deriveShuttleEphemeralAta, deriveShuttleWalletAta, deriveVault, deriveVaultAta, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import bs58 from 'bs58';
import { DEVNET_USDC, PUBLIC_VALIDATOR } from './config';
import type { PaymentOperation } from './payments';

type HistoryConnection = Pick<Connection, 'getParsedTransaction' | 'getSignaturesForAddress'>;
type Instruction = (ParsedInstruction | PartiallyDecodedInstruction) & { stackHeight?: number | null };
type Invocation = { instruction: Instruction; children: Instruction[]; topLevel: boolean };
const mint = new PublicKey(DEVNET_USDC);
// Phase 01 patch (F6 stale): sponsored withdraw completions on devnet now land as v1 transactions.
const parsedOptions = { commitment: 'confirmed', maxSupportedTransactionVersion: 1 } as const;

// Only accept transfers inside the matching protocol instruction's CPI subtree.
// Nested invocations without stack heights are ambiguous and fail closed.
function invocationChildren(transaction: ParsedTransactionWithMeta, matches: (ix: Instruction) => boolean): Invocation[] {
  const groups: Invocation[] = [];
  transaction.transaction.message.instructions.forEach((outer, index) => {
    const inner: Instruction[] = transaction.meta?.innerInstructions?.find(group => group.index === index)?.instructions || [];
    if (matches(outer)) groups.push({ instruction: outer, children: inner, topLevel: true });
    inner.forEach((instruction, offset) => {
      const height = instruction.stackHeight;
      if (!matches(instruction) || typeof height !== 'number') return;
      const children: Instruction[] = [];
      for (const child of inner.slice(offset + 1)) {
        if (typeof child.stackHeight !== 'number') return;
        if (child.stackHeight <= height) break;
        children.push(child);
      }
      groups.push({ instruction, children, topLevel: false });
    });
  });
  return groups;
}

function protocolInstruction(ix: Instruction, discriminator: number, accounts: Array<PublicKey | undefined>) {
  if (!ix.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID) || !('data' in ix)) return false;
  return bs58.decode(ix.data)[0] === discriminator
    && accounts.every((key, index) => !key || ix.accounts[index]?.equals(key));
}

function transferAmount(instruction: Instruction, destination: PublicKey, sources: Array<[PublicKey, PublicKey]>): bigint | null {
  if (!instruction.programId.equals(TOKEN_PROGRAM_ID) || !('parsed' in instruction)) return null;
  const { type, info } = instruction.parsed || {};
  if (type !== 'transferChecked' || info?.mint !== DEVNET_USDC || info.destination !== destination.toBase58()
    || info.tokenAmount?.decimals !== 6 || !/^\d+$/.test(info.tokenAmount?.amount)
    || !sources.some(([source, authority]) => info.source === source.toBase58() && info.authority === authority.toBase58())) return null;
  return BigInt(info.tokenAmount.amount);
}

function transferred(instructions: Instruction[], destination: PublicKey, sources: Array<[PublicKey, PublicKey]>) {
  return instructions.reduce((amount, instruction) => amount + (transferAmount(instruction, destination, sources) ?? 0n), 0n);
}

// ER receipts can omit token balances. For nested calls, bind metadata to complete
// runtime invocation logs: a successful child can still be rolled back by a caught
// ancestor failure. "Program log:" text cannot impersonate these runtime lines.
function successfulMerge(transaction: ParsedTransactionWithMeta, invocation: Invocation, transfers: Instruction[]): boolean {
  // MergeShuttle propagates its TransferChecked error; top-level transaction success
  // therefore proves this exact transfer without needing optional runtime logs.
  if (invocation.topLevel) return true;
  type Frame = { program: string; depth: number; parent?: Frame; success?: boolean };
  const frames: Frame[] = [], stack: Frame[] = [];
  for (const line of transaction.meta?.logMessages ?? []) {
    if (line === 'Log truncated') return false;
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth !== stack.length + 1) return false;
      const frame: Frame = { program: invoke[1], depth, parent: stack.at(-1) };
      frames.push(frame); stack.push(frame);
      continue;
    }
    const completed = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed: .+)$/.exec(line);
    if (completed) {
      const frame = stack.pop();
      if (!frame || frame.program !== completed[1]) return false;
      frame.success = completed[2] === 'success';
    }
  }
  if (!frames.length || stack.length) return false;
  const metadata: { instruction: Instruction; depth: number }[] = [];
  for (const [index, outer] of transaction.transaction.message.instructions.entries()) {
    metadata.push({ instruction: outer, depth: 1 });
    let previousDepth = 1;
    for (const inner of transaction.meta?.innerInstructions?.find(group => group.index === index)?.instructions ?? []) {
      const depth = (inner as Instruction).stackHeight;
      if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 2 || depth > previousDepth + 1) return false;
      metadata.push({ instruction: inner, depth }); previousDepth = depth;
    }
  }
  const frameFor = (instruction: Instruction) => {
    const reference = metadata.find(item => item.instruction === instruction);
    if (!reference) return;
    const program = instruction.programId.toBase58();
    const matchingInstructions = metadata.filter(item => item.depth === reference.depth && item.instruction.programId.equals(instruction.programId));
    const matchingFrames = frames.filter(frame => frame.depth === reference.depth && frame.program === program);
    if (matchingInstructions.length !== matchingFrames.length) return;
    return matchingFrames[matchingInstructions.indexOf(reference)];
  };
  const merge = frameFor(invocation.instruction);
  if (!merge) return false;
  for (let ancestor: Frame | undefined = merge; ancestor; ancestor = ancestor.parent) if (ancestor.success !== true) return false;
  return transfers.length > 0 && transfers.every(instruction => {
    const frame = frameFor(instruction);
    return frame?.parent === merge && frame.success === true;
  });
}

function tokenDelta(transaction: ParsedTransactionWithMeta, address: PublicKey, owner: PublicKey): bigint | null {
  const index = transaction.transaction.message.accountKeys.findIndex(key => key.pubkey.equals(address));
  const balance = (values: NonNullable<typeof transaction.meta>['preTokenBalances']) => values?.find(value => value.accountIndex === index
    && value.mint === DEVNET_USDC && value.owner === owner.toBase58() && value.uiTokenAmount.decimals === 6);
  const before = balance(transaction.meta?.preTokenBalances);
  const after = balance(transaction.meta?.postTokenBalances);
  return before && after ? BigInt(after.uiTokenAmount.amount) - BigInt(before.uiTokenAmount.amount) : null;
}

/**
 * Read-only fallback for a previously validated, signed payment. Current wallet
 * balances and shuttle disappearance are NOT completion proofs: a shuttle may
 * close after cancellation/refund. Missing/unsupported RPC history stays pending.
 * This is bounded, trusted-RPC evidence.
 */
export async function hasPaymentCompletion(base: HistoryConnection, per: HistoryConnection, signed: Transaction,
  operation: PaymentOperation, owner: PublicKey, amount: bigint, beforeErSlot?: number): Promise<boolean> {
  try {
    if (amount <= 0n || !signed.signature || !signed.verifySignatures()
      || !signed.signatures.some(item => item.publicKey.equals(owner))) return false;
    const instruction = signed.instructions.at(-1);
    if (!instruction?.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID) || instruction.data.length !== 45
      || instruction.data[0] !== (operation === 'deposit' ? 24 : 26) || instruction.data.readBigUInt64LE(5) !== amount
      || !instruction.data.subarray(13).equals(new PublicKey(PUBLIC_VALIDATOR).toBuffer())) return false;
    const [shuttle] = deriveShuttleEphemeralAta(owner, mint, instruction.data.readUInt32LE(1));
    const [backing] = deriveShuttleAta(shuttle, mint);
    const shuttleToken = deriveShuttleWalletAta(mint, shuttle);
    const ownerToken = getAssociatedTokenAddressSync(mint, owner);
    const bindings = [[2, shuttle], [3, backing], [4, shuttleToken], [5, owner], [13, ownerToken], [14, mint], [15, TOKEN_PROGRAM_ID]] as const;
    if (!bindings.every(([index, key]) => instruction.keys[index]?.pubkey.equals(key))) return false;
    const signature = bs58.encode(signed.signature);
    const origin = await base.getParsedTransaction(signature, parsedOptions);
    if (!origin?.meta || origin.meta.err !== null || !origin.transaction.signatures.includes(signature)) return false;
    const connection = operation === 'deposit' ? per : base;
    const history = await connection.getSignaturesForAddress(operation === 'deposit' ? shuttleToken : shuttle, { limit: 10 }, 'confirmed');
    const [vault] = deriveVault(mint);
    const vaultToken = deriveVaultAta(mint, vault);
    for (const entry of history.slice(0, 10)) {
      if (entry.err !== null || entry.signature === signature) continue;
      const transaction = await connection.getParsedTransaction(entry.signature, parsedOptions);
      if (!transaction?.meta || transaction.meta.err !== null || !transaction.transaction.signatures.includes(entry.signature)) continue;
      // A pre-signing ER slot checkpoint excludes earlier shuttle reuse. Without it,
      // ER slots are not comparable to base slots. Require strictly later known
      // block time there; on base require a strictly later slot. Same-second ER
      // results stay pending rather than matching old reused-shuttle history.
      if (operation === 'deposit') {
        if (beforeErSlot !== undefined) {
          if (!Number.isSafeInteger(beforeErSlot) || transaction.slot <= beforeErSlot) continue;
        } else if (origin.blockTime == null || transaction.blockTime == null || transaction.blockTime <= origin.blockTime) continue;
        const groups = invocationChildren(transaction, ix => protocolInstruction(ix, 15, [owner, ownerToken, shuttle, shuttleToken, mint, TOKEN_PROGRAM_ID]));
        const sources: Array<[PublicKey, PublicKey]> = [[shuttleToken, shuttle]];
        const balancesMatch = tokenDelta(transaction, ownerToken, owner) === amount && tokenDelta(transaction, shuttleToken, shuttle) === -amount;
        const balancesUnavailable = !transaction.meta.preTokenBalances?.length && !transaction.meta.postTokenBalances?.length;
        if (groups.some(group => transferred(group.children, ownerToken, sources) === amount && (balancesMatch
          || balancesUnavailable && successfulMerge(transaction, group, group.children.filter(child => transferAmount(child, ownerToken, sources) !== null))))) return true;
      } else {
        if (transaction.slot <= origin.slot) continue;
        const accounts = [undefined, shuttle, backing, shuttleToken, ownerToken, mint, vault, vaultToken, TOKEN_PROGRAM_ID];
        const groups = invocationChildren(transaction, ix => protocolInstruction(ix, 201, accounts) || protocolInstruction(ix, 32, accounts));
        if (!groups.some(group => transferred(group.children, ownerToken, [[shuttleToken, shuttle], [vaultToken, vault]]) === amount)) continue;
        if (tokenDelta(transaction, ownerToken, owner) === amount) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
