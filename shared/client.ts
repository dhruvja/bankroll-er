import bs58 from 'bs58';
import { Connection, PublicKey, Transaction, TransactionInstruction, type AccountInfo, type BlockhashWithExpiryBlockHeight, type Signer } from '@solana/web3.js';
import { unpackAccount } from '@solana/spl-token';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { BASE_RPC, DEVNET_GENESIS, ER_RPC, PUBLIC_VALIDATOR, invariant } from './config';
import {
  PHASE_OFFSET, PROGRAM_ID, accountsFor, buildInstruction, custodyAddress, decodeTable, delegationStatus, idl,
  currentSeat, isActive, mintKey, settleRemaining, tableAddress, tokenAddress, u64, type TableView,
} from './chain';
import { board } from './board';
import type { PaymentClient } from './sponsored';

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const programErrors = new Map((idl.errors ?? []).map(error => [error.code, error.name]));

export class ProgramError extends Error {
  constructor(readonly signature: string, readonly code: number | undefined, detail: string) {
    super(code !== undefined && programErrors.has(code) ? `${programErrors.get(code)} (${code})` : detail);
  }
}
function customCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('InstructionError' in error) || !Array.isArray(error.InstructionError)) return undefined;
  const detail: unknown = error.InstructionError[1];
  return detail && typeof detail === 'object' && 'Custom' in detail && typeof detail.Custom === 'number' ? detail.Custom : undefined;
}

export interface SentTransaction { signature: string; label: string; sentAt: number; confirmedAt: number }

/** Public RPC client. Keys stay with the caller; there is no game server. */
export class BankrollClient implements PaymentClient {
  readonly base: Connection;
  readonly er: Connection;
  private erRpc: string;
  private blockhash?: { value: BlockhashWithExpiryBlockHeight; expires: number };
  private identity?: Promise<void>;
  private genesis?: Promise<void>;
  private routed = new Set<string>();

  constructor(options: { baseRpc?: string; erRpc?: string } = {}) {
    this.base = new Connection(options.baseRpc || BASE_RPC, 'confirmed');
    this.erRpc = options.erRpc || ER_RPC;
    this.er = new Connection(this.erRpc, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  }

  verifyDevnet() {
    this.genesis ??= this.base.getGenesisHash().then(hash => { invariant(hash === DEVNET_GENESIS, 'This app only accepts Solana devnet.'); })
      .catch(error => { this.genesis = undefined; throw error; });
    return this.genesis;
  }
  verifyPublicRollup() {
    this.identity ??= (async () => {
      const response = await fetch(this.erRpc, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getIdentity' }), signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as { result?: { identity?: string } };
      invariant(response.ok && body.result?.identity === PUBLIC_VALIDATOR, 'The public rollup validator does not match this game.');
    })().catch(error => { this.identity = undefined; throw error; });
    return this.identity;
  }
  /** A table must be routed by the router to the pinned validator behind this ER endpoint. */
  async verifyTableRoute(table: PublicKey) {
    if (this.routed.has(table.toBase58())) return;
    const status = await delegationStatus(table);
    invariant(status.isDelegated && status.delegationRecord?.authority === PUBLIC_VALIDATOR && status.fqdn
      && new URL(status.fqdn).origin === new URL(this.erRpc).origin, 'This table belongs to another rollup.');
    this.routed.add(table.toBase58());
  }

  /** Base USDC, play (ER) USDC and base lamports, as bomberman reads them. */
  async walletBalances(owner: PublicKey) {
    await Promise.all([this.verifyDevnet(), this.verifyPublicRollup()]);
    const token = tokenAddress(owner), eata = custodyAddress(owner);
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
      invariant(route.isDelegated && route.delegationRecord?.authority === PUBLIC_VALIDATOR,
        'This wallet is delegated to another rollup. Use a different wallet for Bankroll.');
      const projected = await this.er.getAccountInfo(eata);
      invariant(projected?.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), 'Your public play balance is still reaching the rollup.');
      play = amount(await this.er.getAccountInfo(token));
    } else invariant(!custody || custody.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), 'Unexpected USDC custody account.');
    return { base: amount(baseAccount), er: play, lamports };
  }

  async erTokenBalance(owner: PublicKey): Promise<bigint> {
    const account = await this.er.getAccountInfo(tokenAddress(owner), 'confirmed');
    return account ? unpackAccount(tokenAddress(owner), account).amount : 0n;
  }

  async readTable(address: PublicKey): Promise<TableView> {
    const account = await this.er.getAccountInfo(address, 'confirmed');
    invariant(account && account.owner.equals(PROGRAM_ID), 'Table not found on the public rollup.');
    return decodeTable(address, account.data);
  }

  /** Pushes every ER change of the table; the first snapshot is read immediately. */
  subscribeTable(address: PublicKey, onTable: (table: TableView) => void, onError: (error: Error) => void = () => {}) {
    let closed = false;
    const id = this.er.onAccountChange(address, account => {
      if (closed || !account.owner.equals(PROGRAM_ID)) return;
      try { onTable(decodeTable(address, account.data)); } catch (error) { onError(error as Error); }
    }, { commitment: 'confirmed' });
    void this.readTable(address).then(table => { if (!closed) onTable(table); }, error => onError(error as Error));
    return () => { closed = true; void this.er.removeAccountChangeListener(id).catch(() => {}); };
  }

  /** Free tables on the ER, via `getProgramAccounts` filtered on `phase == Free`. */
  async findFreeTables(): Promise<TableView[]> {
    await this.verifyPublicRollup();
    const accounts = await this.er.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(idl.accounts!.find(item => item.name === 'Table')!.discriminator)) } },
      { memcmp: { offset: PHASE_OFFSET, bytes: bs58.encode(Buffer.from([0])) } },
    ] });
    const tables: TableView[] = [];
    for (const { pubkey, account } of accounts) {
      try { tables.push(decodeTable(pubkey, account.data)); } catch { /* Not a canonical table. */ }
    }
    return tables.filter(table => table.phase === 'free').sort((a, b) => a.index - b.index);
  }

  async readTables(count: number): Promise<TableView[]> {
    const addresses = Array.from({ length: count }, (_, index) => tableAddress(index));
    const accounts = await this.er.getMultipleAccountsInfo(addresses, 'confirmed');
    return accounts.map((account, index) => {
      invariant(account && account.owner.equals(PROGRAM_ID), `Table ${index} is not on the public rollup.`);
      return decodeTable(addresses[index], account.data);
    });
  }

  private async erBlockhash(fresh = false) {
    if (!fresh && this.blockhash && this.blockhash.expires > Date.now()) return this.blockhash.value.blockhash;
    const value = await this.er.getLatestBlockhash('confirmed');
    this.blockhash = { value, expires: Date.now() + 5_000 };
    return value.blockhash;
  }

  /** ER send path: cached blockhash, a memo nonce so repeats never collide, skipPreflight and
   * maxRetries 0, then status polling. Throws ProgramError with the IDL error name on failure. */
  async sendEr(label: string, instructions: TransactionInstruction[], signer: Signer): Promise<SentTransaction> {
    const memo = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`${label}:${Math.random().toString(36).slice(2, 10)}`) });
    const transaction = new Transaction({ feePayer: signer.publicKey, recentBlockhash: await this.erBlockhash() }).add(...instructions, memo);
    transaction.sign(signer);
    const signature = bs58.encode(transaction.signature!), sentAt = Date.now();
    try { await this.er.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 0 }); }
    catch (error) { this.blockhash = undefined; throw error; }
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = (await this.er.getSignatureStatuses([signature])).value[0];
      if (status?.err) {
        if (/blockhash/i.test(JSON.stringify(status.err))) this.blockhash = undefined;
        throw new ProgramError(signature, customCode(status.err), `${label} failed: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { signature, label, sentAt, confirmedAt: Date.now() };
      await pause(100);
    }
    this.blockhash = undefined;
    throw new Error(`${label} was not confirmed on the rollup: ${signature}`);
  }

  private async act(label: string, name: Parameters<typeof buildInstruction>[0], table: PublicKey, signer: Signer, args: Record<string, unknown> = {}, recipient?: PublicKey, remaining: Parameters<typeof buildInstruction>[3] = []) {
    await Promise.all([this.verifyDevnet(), this.verifyPublicRollup(), this.verifyTableRoute(table)]);
    return this.sendEr(label, [buildInstruction(name, accountsFor(table, signer.publicKey, recipient), args, remaining)], signer);
  }
  openTable(table: PublicKey, host: Signer, options: { name: string; entry: number; maxPlayers: number; target: number }) {
    return this.act('open', 'open_table', table, host, { name: options.name, entry: u64(options.entry), max_players: options.maxPlayers, target: u64(options.target) });
  }
  joinTable(table: PublicKey, player: Signer, nonce: number, name: string) {
    return this.act('join', 'join_table', table, player, { expected_nonce: u64(nonce), name });
  }
  startGame(table: PublicKey, signer: Signer) { return this.act('start', 'start_game', table, signer); }
  roll(table: PublicKey, signer: Signer) { return this.act('roll', 'roll', table, signer); }
  buy(table: PublicKey, signer: Signer) { return this.act('buy', 'buy', table, signer); }
  pass(table: PublicKey, signer: Signer) { return this.act('pass', 'pass', table, signer); }
  forceTimeout(table: PublicKey, signer: Signer) { return this.act('timeout', 'force_timeout', table, signer); }
  cancel(table: PublicKey, signer: Signer) { return this.act('cancel', 'cancel_or_expire', table, signer); }
  refund(table: PublicKey, signer: Signer, view: TableView, seat: number) {
    return this.act('refund', 'refund_player', table, signer, { seat }, new PublicKey(view.seats[seat].wallet));
  }
  settle(table: PublicKey, signer: Signer, view: TableView) {
    return this.act('settle', 'settle', table, signer, {}, undefined, settleRemaining(view));
  }
}

/** What a participant's client should send next for liveness, or nothing yet. */
export type CrankAction = 'timeout' | 'retry-roll' | 'retry-start' | 'settle' | 'expire' | { refund: number };
export function nextCrank(table: TableView, wallet: string, now: number): { action: CrankAction; at: number } | undefined {
  const rules = board.rules.deadlinesSec, seat = table.seats.findIndex(item => item.wallet === wallet);
  if (seat < 0) return undefined;
  const idle = table.lastActionAt + rules.idle;
  switch (table.phase) {
    case 'lobby': return { action: 'expire', at: table.lobbyDeadline };
    case 'refunding': {
      const pending = table.seats.findIndex(item => !item.refunded);
      return pending < 0 ? undefined : { action: { refund: pending }, at: now };
    }
    case 'finished': return { action: 'settle', at: now };
    case 'playing': {
      if (table.stage === 'ordering') return { action: now >= idle ? 'timeout' : 'retry-start', at: Math.min(idle, table.vrfRequestedAt + rules.vrfRetry) };
      if (table.stage === 'rolling') {
        if (now >= idle) return { action: 'timeout', at: idle };
        // Mirrors OTHER_SEAT_RETRY_SECONDS: seats that aren't rolling wait three VRF retry windows.
        const wait = seat === currentSeat(table) ? rules.vrfRetry : 3 * rules.vrfRetry;
        return isActive(table, seat) ? { action: 'retry-roll', at: table.vrfRequestedAt + wait } : { action: 'timeout', at: idle };
      }
      return { action: 'timeout', at: Math.min(idle, table.stageDeadline) };
    }
    default: return undefined;
  }
}

/** Every participant tab runs this. It fires the next liveness action once its deadline passes,
 * after 0–3 s of jitter so tabs rarely race; a lost race simply fails and re-reads. */
export function startCrank(client: BankrollClient, address: PublicKey, signer: Signer, onSent: (sent: SentTransaction) => void = () => {}, jitterMs = 3_000) {
  let table: TableView | undefined, busy = false, stopped = false;
  const unsubscribe = client.subscribeTable(address, next => { table = next; });
  const timer = setInterval(() => {
    if (busy || stopped || !table) return;
    const now = Date.now() / 1000, step = nextCrank(table, signer.publicKey.toBase58(), now);
    if (!step || now < step.at + Math.random() * jitterMs / 1000) return;
    busy = true;
    const view = table, action = step.action;
    const send = action === 'timeout' ? client.forceTimeout(address, signer)
      : action === 'retry-roll' ? client.roll(address, signer)
      : action === 'retry-start' ? client.startGame(address, signer)
      : action === 'settle' ? client.settle(address, signer, view)
      : action === 'expire' ? client.cancel(address, signer)
      : client.refund(address, signer, view, action.refund);
    void send.then(onSent, () => {}).finally(() => { busy = false; });
  }, 500);
  return () => { stopped = true; clearInterval(timer); unsubscribe(); };
}
