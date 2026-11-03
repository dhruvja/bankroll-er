import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { readFileSync, readdirSync } from 'node:fs';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { deriveShuttleAta, deriveShuttleEphemeralAta, deriveShuttleWalletAta, deriveVault, deriveVaultAta, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import bs58 from 'bs58';
const base = new Connection('https://rpc.magicblock.app/devnet', 'confirmed');
const mint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const file = readdirSync('receipts').find(name => name.endsWith('.json'))!;
const receipt = JSON.parse(readFileSync(`receipts/${file}`, 'utf8')) as { owner: string; signature: string; build: { transactionBase64: string } };
const owner = new PublicKey(receipt.owner);
const signed = Transaction.from(Buffer.from(receipt.build.transactionBase64, 'base64'));
const shuttleIx = signed.instructions.at(-1)!;
const [shuttle] = deriveShuttleEphemeralAta(owner, mint, shuttleIx.data.readUInt32LE(1));
const [backing] = deriveShuttleAta(shuttle, mint);
const shuttleToken = deriveShuttleWalletAta(mint, shuttle);
const [vault] = deriveVault(mint);
const expected = { shuttle, backing, shuttleToken, ownerToken: getAssociatedTokenAddressSync(mint, owner), vault, vaultToken: deriveVaultAta(mint, vault) };
const origin = await base.getParsedTransaction(receipt.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
const history = await base.getSignaturesForAddress(shuttle, { limit: 10 }, 'confirmed');
const out = [];
for (const entry of history) {
  const tx = await base.getParsedTransaction(entry.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
  const ixs = tx!.transaction.message.instructions.flatMap((ix, index) => [ix, ...(tx!.meta?.innerInstructions?.find(g => g.index === index)?.instructions ?? [])]);
  out.push({ signature: entry.signature, slot: entry.slot, err: entry.err, afterOrigin: entry.slot > (origin?.slot ?? 0),
    espl: ixs.filter(ix => ix.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID) && 'data' in ix).map(ix => ({ disc: bs58.decode((ix as { data: string }).data)[0],
      accounts: (ix as { accounts: PublicKey[] }).accounts.slice(0, 9).map(key => Object.entries(expected).find(([, v]) => v.equals(key))?.[0] ?? key.toBase58()) })),
    transfers: ixs.filter(ix => 'parsed' in ix && (ix.parsed as { type?: string })?.type?.startsWith('transfer')).map(ix => (ix as { parsed: unknown }).parsed) });
}
console.log(JSON.stringify({ originSlot: origin?.slot, originErr: origin?.meta?.err, expected, history: out }, null, 2));
