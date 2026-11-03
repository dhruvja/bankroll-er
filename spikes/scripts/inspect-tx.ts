import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
const er = new Connection('https://devnet-as.magicblock.app', 'confirmed');
const [req, cb] = process.argv.slice(2);
const r = await er.getTransaction(req, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
const c = await er.getTransaction(cb, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
const keys = (t: typeof r) => t!.transaction.message.staticAccountKeys.map(k => k.toBase58());
const inner = r!.meta?.innerInstructions?.flatMap(g => g.instructions).map(i => ({ program: keys(r)[i.programIdIndex], disc: bs58.decode(i.data)[0] }));
console.log(JSON.stringify({
  request: { fee: r!.meta?.fee, cu: r!.meta?.computeUnitsConsumed, feePayer: keys(r)[0], payerPre: r!.meta?.preBalances[0], payerPost: r!.meta?.postBalances[0], innerCpis: inner,
    logs: r!.meta?.logMessages?.filter(l => /invoke|success|consumed/.test(l)) },
  callback: { signers: keys(c).slice(0, c!.transaction.message.header.numRequiredSignatures), cu: c!.meta?.computeUnitsConsumed, err: c!.meta?.err,
    logs: c!.meta?.logMessages?.filter(l => /invoke|success|consumed/.test(l)) },
}, null, 2));
