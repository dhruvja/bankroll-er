/**
 * Devnet smoke.
 *   --check                                   read-only readiness (G7)
 *   --execute [--players 3] [--target 3000] [--trades]
 *                                             zero-SOL bots play a staked 1 USDC game (G8); with
 *                                             --trades they trade on every Auction landing they can
 * Player wallets come from `.env` (SMOKE_PLAYER_<n>, base58 secret keys) and are created there if
 * missing. They never receive SOL; the admin only tops up their base USDC.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getMint } from '@solana/spl-token';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { ER_RPC, PUBLIC_VALIDATOR, RELAY_FEE, ROUTER_RPC, TOKEN_SCALE, WITHDRAW_MINIMUM, invariant } from '../shared/config';
import {
  NO_OFFER, PROGRAM_ID, canBuild, currentSeat, tradeOffers, tradeable, custodyAddress, delegationStatus, expectedPayouts, isActive, mintKey, netWorth, tableAddress, tokenAddress,
  treasuryAddress, type TableView,
} from '../shared/chain';
import { board } from '../shared/board';
import { ProgramError, type SentTransaction } from '../shared/client';
import { depositForEntry } from '../shared/funding';
import { ROOT, client, filePayments, flags, loadAdmin, readDeployment, requireDevnet, saveArtifact, sendBase } from './node';

const args = flags();
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const now = () => Date.now() / 1000;
const usdc = (atoms: bigint | number) => (Number(atoms) / TOKEN_SCALE).toFixed(6);

async function check() {
  const checks: Record<string, unknown> = {};
  const step = async (name: string, run: () => Promise<unknown>) => {
    try { checks[name] = await run() ?? true; }
    catch (error) {
      const result = { ok: false, failedCheck: name, error: error instanceof Error ? error.message : String(error), checks };
      console.log(saveArtifact('smoke-check.json', result));
      process.exit(1);
    }
  };
  await step('devnetGenesis', requireDevnet);
  await step('publicRollupIdentity', async () => { await client.verifyPublicRollup(); return { er: ER_RPC, validator: PUBLIC_VALIDATOR }; });
  await step('erHealth', async () => {
    const response = await fetch(ER_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
    const body = await response.json() as { result?: string };
    invariant(body.result === 'ok', `ER health: ${JSON.stringify(body)}`); return body.result;
  });
  await step('programDeployed', async () => {
    const account = await client.base.getAccountInfo(PROGRAM_ID);
    invariant(account?.executable, 'Program is not executable on devnet.'); return PROGRAM_ID.toBase58();
  });
  await step('usdcMint', async () => { const mint = await getMint(client.base, mintKey); invariant(mint.decimals === 6, 'Unexpected decimals.'); return mint.address.toBase58(); });
  const deployment = readDeployment();
  await step('deployment', async () => { invariant(deployment.programId === PROGRAM_ID.toBase58(), 'deployment.json is for another program.'); return deployment; });
  await step('tablesRouted', async () => {
    const tables = await client.readTables(deployment.tables);
    for (const table of tables) {
      const address = new PublicKey(table.address);
      const route = await delegationStatus(address);
      invariant(route.isDelegated && route.delegationRecord?.authority === PUBLIC_VALIDATOR && route.fqdn && new URL(route.fqdn).origin === new URL(ER_RPC).origin,
        `Table ${table.index} route via ${ROUTER_RPC}: ${JSON.stringify(route)}`);
      invariant((await client.er.getAccountInfo(custodyAddress(address)))?.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), `Table ${table.index} custody not live on the ER.`);
    }
    return tables.map(table => ({ index: table.index, phase: table.phase, gameNonce: table.gameNonce }));
  });
  await step('treasuryCustody', async () => {
    const treasury = treasuryAddress();
    invariant((await client.base.getAccountInfo(custodyAddress(treasury)))?.owner.equals(DELEGATION_PROGRAM_ID), 'Treasury custody is not delegated.');
    return { treasury: treasury.toBase58(), balance: usdc(await client.erTokenBalance(treasury)) };
  });
  await step('freeTableFinder', async () => {
    const free = await client.findFreeTables();
    invariant(free.length > 0, 'No Free table; run bootstrap --tables with a higher count.');
    return free.map(table => table.index);
  });
  console.log(saveArtifact('smoke-check.json', { ok: true, at: new Date().toISOString(), checks }));
}

function loadPlayers(count: number): Keypair[] {
  const path = resolve(ROOT, '.env');
  if (existsSync(path)) process.loadEnvFile(path);
  return Array.from({ length: count }, (_, index) => {
    const name = `SMOKE_PLAYER_${index + 1}`, secret = process.env[name];
    if (secret) return Keypair.fromSecretKey(bs58.decode(secret));
    const player = Keypair.generate();
    appendFileSync(path, `${name}=${bs58.encode(player.secretKey)}\n`, { mode: 0o600 });
    return player;
  });
}

async function lamports(owner: PublicKey) {
  return { base: await client.base.getBalance(owner), er: await client.er.getBalance(owner) };
}

async function execute() {
  const playerCount = Number(args.value('players') ?? 3), target = Number(args.value('target') ?? 3000), entry = TOKEN_SCALE;
  const trades = args.has('trades');
  invariant([2, 3, 4].includes(playerCount) && board.rules.targets.includes(target), 'Use --players 2-4 and --target 3000/5000/7000.');
  await requireDevnet();
  const admin = loadAdmin(), players = loadPlayers(playerCount), names = players.map((_, index) => `Bot ${index + 1}`);
  const { payments, signatures: paymentSignatures } = filePayments();
  const sent: SentTransaction[] = [], base: Record<string, string> = {};
  const record = (tx: SentTransaction) => { sent.push(tx); return tx; };
  const adminBefore = { lamports: await client.base.getBalance(admin.publicKey), usdc: (await client.walletBalances(admin.publicKey)).base };

  // Zero SOL, always: refuse to run with a funded player wallet.
  for (const player of players) {
    const value = await lamports(player.publicKey);
    invariant(value.base === 0 && value.er === 0, `${player.publicKey.toBase58()} holds lamports; smoke wallets must have 0 SOL.`);
  }

  // Fund each play balance with exactly one entry's worth via the sponsored deposit.
  for (const [index, player] of players.entries()) {
    for (let attempt = 0; attempt < 60 && !(await payments.reconcile(player.publicKey, true)); attempt++) await pause(3000);
    let balance = await client.walletBalances(player.publicKey);
    if (balance.er >= BigInt(entry)) continue;
    const deposit = depositForEntry(0n, balance.er, BigInt(entry));
    const needed = deposit + BigInt(RELAY_FEE * 2);
    if (balance.base < needed) {
      base[`fund:${index}`] = await sendBase([
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, tokenAddress(player.publicKey), player.publicKey, mintKey),
        createTransferInstruction(tokenAddress(admin.publicKey), tokenAddress(player.publicKey), admin.publicKey, needed - balance.base),
      ], [admin]);
      balance = await client.walletBalances(player.publicKey);
    }
    await payments.execute(player, 'deposit', depositForEntry(balance.base, balance.er, BigInt(entry)));
    invariant((await client.walletBalances(player.publicKey)).er >= BigInt(entry), `Player ${index} play balance did not arrive.`);
  }

  const treasury = treasuryAddress();
  const before = { players: await Promise.all(players.map(player => client.erTokenBalance(player.publicKey))), treasury: await client.erTokenBalance(treasury) };
  const free = await client.findFreeTables();
  invariant(free.length > 0, 'No Free table.');
  const address = new PublicKey(free[0].address), custodyBefore = await client.erTokenBalance(address);
  invariant(custodyBefore === 0n, `Table ${free[0].index} custody holds ${custodyBefore} before opening; drain it first.`);

  record(await client.openTable(address, players[0], { name: names[0], entry, maxPlayers: playerCount, target }));
  let table = await client.readTable(address);
  const nonce = table.gameNonce;
  for (let seat = 1; seat < playerCount; seat++) record(await client.joinTable(address, players[seat], nonce, names[seat]));
  record(await client.startGame(address, players[0]));
  const startedAt = now();

  // Bots play sim.py's greedy policy: sell out of debt, build when $150 stays in hand, bail with
  // at least $500, buy when $100 stays in hand. The last seat idles through its first turn so the
  // others must strike it with force_timeout.
  const idleSeat = playerCount - 1;
  let idled = false, finishedView: TableView | undefined, settle: SentTransaction | undefined, turns = 0;
  const events = { builds: 0, sales: 0, bails: 0, jailTurnsServed: 0, cards: [] as number[], eliminations: [] as { seat: number; at: number }[],
    tradesOpened: 0, tradePasses: 0, offers: 0, offersReplaced: 0, emptyWindowsCancelled: 0,
    trades: [] as { lander: number; seat: number; gave: number; took: number; signature: string; verified: boolean }[] };
  let replaced = false;
  /** A seat's unbuilt properties, cheapest first. */
  const unbuilt = (view: TableView, owner: number) => board.spaces.filter(space => tradeable(view, owner, space.index))
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0)).map(space => space.index);
  let lastCardNonce = 0;
  const signerFor = (wallet: string) => players.find(player => player.publicKey.toBase58() === wallet)!;
  /** Sends one bot action; true when it landed, false when it lost a race with the chain. */
  const attempt = async (label: string, run: () => Promise<SentTransaction>) => {
    try { record(await run()); return true; }
    catch (error) {
      // Racing the chain (a deadline not yet reached on the ER clock, a stage that already moved)
      // is expected; anything else is a real failure.
      if (!(error instanceof ProgramError) || !/^(InvalidStage|TooEarly|InvalidPhase|Unauthorized|OffersClosed|OfferChanged) /.test(error.message)) throw error;
      console.log(`${label}: ${error.message}, retrying`);
      await pause(500);
      return false;
    }
  };
  while (!settle) {
    invariant(now() - startedAt < 30 * 60, 'Smoke game did not finish within 30 minutes.');
    table = await client.readTable(address);
    invariant(table.gameNonce === nonce, 'The table moved to another game.');
    const seat = currentSeat(table), actor = players[seat];
    if (table.phase === 'finished') {
      finishedView = table;
      settle = record(await client.settle(address, players[0], table));
      break;
    }
    invariant(table.phase === 'playing', `Unexpected phase ${table.phase}.`);
    // A card belongs to the callback that answered `vrfNonce`; count it once, after that callback.
    if (table.stage !== 'rolling' && table.lastCard && table.vrfNonce !== lastCardNonce) { events.cards.push(table.lastCard); lastCardNonce = table.vrfNonce; }
    if (table.stage === 'ordering' || table.stage === 'rolling') {
      if (now() > table.vrfRequestedAt + board.rules.deadlinesSec.vrfRetry + 1) {
        await attempt('vrf retry', () => table.stage === 'ordering' ? client.startGame(address, players[0]) : client.roll(address, actor));
      } else await pause(150);
      continue;
    }
    if (table.stage === 'preroll' && seat === idleSeat && !idled) {
      if (now() < table.stageDeadline + 1) { await pause(500); continue; }
      await attempt('timeout', () => client.forceTimeout(address, players[(idleSeat + 1) % playerCount]));
      idled = (await client.readTable(address)).seats[idleSeat].strikes > 0;
      continue;
    }
    if (table.stage === 'preroll') {
      const me = table.seats[seat];
      if (me.cash < 0) {
        const sale = table.board.map((lot, space) => ({ lot, space })).filter(item => item.lot.owner === seat)
          .sort((a, b) => Number(a.lot.buildings > 0) - Number(b.lot.buildings > 0) || (board.spaces[a.space].price ?? 0) - (board.spaces[b.space].price ?? 0))[0];
        if (sale) { if (await attempt('sell', () => client.sell(address, actor, sale.space))) events.sales++; continue; }
      }
      const build = board.spaces.filter(space => canBuild(table, seat, space.index) && me.cash - (space.buildingCost ?? 0) >= 150)
        .sort((a, b) => table.board[a.index].buildings - table.board[b.index].buildings || (b.rent ?? 0) - (a.rent ?? 0))[0];
      if (build) { if (await attempt('build', () => client.build(address, actor, build.index))) events.builds++; continue; }
      if (me.jailTurns > 0 && me.cash >= 500) { if (await attempt('bail', () => client.payBail(address, actor))) events.bails++; continue; }
      if (await attempt('roll', () => client.roll(address, actor))) {
        if (me.jailTurns > 0) events.jailTurnsServed++;
        turns++;
      }
      continue;
    }
    if (table.stage === 'buydecision') {
      const price = board.spaces[table.seats[seat].position].price ?? 0;
      await attempt('decide', () => table.seats[seat].cash - price >= 100 ? client.buy(address, actor) : client.pass(address, actor));
      continue;
    }
    if (table.stage === 'tradeopen') {
      // Without --trades the lander always passes. With it, the lander offers its cheapest unbuilt property.
      const give = unbuilt(table, seat)[0];
      if (!trades || give === undefined) { if (await attempt('trade-pass', () => client.pass(address, actor))) events.tradePasses++; continue; }
      if (await attempt('trade-open', () => client.openTrade(address, actor, give))) events.tradesOpened++;
      continue;
    }
    if (table.stage === 'tradeoffers') {
      const view = table, open = now() < view.trade.deadline - 2;
      // Every other active seat offers its cheapest unbuilt property; the first one then replaces its
      // offer once with its next property, so replacement runs on chain too.
      const offerer = view.order.find(other => other !== seat && isActive(view, other) && view.trade.offers[other] === NO_OFFER && unbuilt(view, other).length > 0);
      if (open && offerer !== undefined) {
        if (await attempt('trade-offer', () => client.offerTrade(address, players[offerer], unbuilt(view, offerer)[0]))) events.offers++;
        continue;
      }
      const switcher = tradeOffers(view).find(offer => unbuilt(view, offer.seat).length > 1);
      if (open && !replaced && switcher) {
        const next = unbuilt(view, switcher.seat).find(space => space !== switcher.space)!;
        if (await attempt('trade-replace', () => client.offerTrade(address, players[switcher.seat], next))) { events.offersReplaced++; replaced = true; }
        continue;
      }
      const pick = tradeOffers(view)[0];
      if (!pick) {
        if (now() < view.trade.deadline + 1) { await pause(500); continue; }
        if (await attempt('timeout', () => client.forceTimeout(address, players[(seat + 1) % playerCount]))) events.emptyWindowsCancelled++;
        continue;
      }
      let accepted: SentTransaction | undefined;
      if (!(await attempt('trade-accept', async () => (accepted = await client.acceptTrade(address, actor, pick.seat, pick.space))))) continue;
      // Re-read until the ER shows the swap: both properties moved and both sides got the $100 bonus.
      let verified = false;
      for (let poll = 0; poll < 40 && !verified; poll++) {
        const after = await client.readTable(address);
        verified = after.board[view.trade.space].owner === pick.seat && after.board[pick.space].owner === seat
          && after.seats[seat].cash === view.seats[seat].cash + board.rules.tradeBonus
          && after.seats[pick.seat].cash === view.seats[pick.seat].cash + board.rules.tradeBonus;
        if (!verified) await pause(500);
      }
      events.trades.push({ lander: seat, seat: pick.seat, gave: view.trade.space, took: pick.space, signature: accepted!.signature, verified });
      continue;
    }
    throw new Error(`Unexpected stage ${table.stage}.`);
  }
  invariant(finishedView && settle, 'No settlement.');
  const done = finishedView;
  done.seats.forEach((item, index) => { if (item.eliminatedAt) events.eliminations.push({ seat: index, at: item.eliminatedAt }); });
  const activeLeft = done.seats.filter((_, index) => isActive(done, index)).length;
  const endedBy = activeLeft <= 1 ? 'last-standing' : done.seats.some((_, index) => isActive(done, index) && netWorth(done, index) >= done.target) ? 'target' : 'idle';

  // Exact settlement: independent payout math, ER balances, fee, custody and table state. ER reads
  // can trail a confirmed signature briefly, so poll until the settled state is visible.
  const expected = expectedPayouts(finishedView);
  const pot = entry * playerCount, fee = Math.floor(pot * 300 / 10_000);
  let after = { players: before.players, treasury: before.treasury }, custodyAfter = -1n;
  let assertions: Record<string, boolean> = {};
  for (let poll = 0; poll < 40; poll++) {
    table = await client.readTable(address);
    after = { players: await Promise.all(players.map(player => client.erTokenBalance(player.publicKey))), treasury: await client.erTokenBalance(treasury) };
    custodyAfter = await client.erTokenBalance(address);
    assertions = {
      tableFree: table.phase === 'free' && table.gameNonce === nonce,
      custodyZero: custodyAfter === 0n,
      payoutsRecorded: table.seats.every((seat, index) => seat.payout === expected.payouts[index]),
      playerBalancesExact: players.every((_, index) => after.players[index] - before.players[index] === BigInt(expected.payouts[index] - entry)),
      treasuryExact: after.treasury - before.treasury === BigInt(expected.treasury),
      feeAtLeast3Percent: expected.treasury >= fee,
      idleSeatStruck: table.seats[idleSeat].strikes >= 1,
      endedByTargetOrBankruptcy: endedBy !== 'idle',
      ...(trades ? { tradeCompleted: events.trades.length > 0 && events.trades.every(trade => trade.verified) } : {}),
    };
    if (Object.values(assertions).every(Boolean)) break;
    await pause(500);
  }
  const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  invariant(Object.values(assertions).every(Boolean), `Settlement mismatch: ${json({ assertions, expected, before, after, custodyAfter, table })}`);

  // The best-paid non-winner withdraws to base (sponsored, so still zero SOL).
  const ranked = expected.payouts.map((payout, seat) => ({ payout, seat })).sort((a, b) => b.payout - a.payout);
  const withdrawer = ranked.find((item, index) => index > 0 && item.payout >= WITHDRAW_MINIMUM) ?? ranked[0];
  const owner = players[withdrawer.seat], withdrawAmount = BigInt(withdrawer.payout);
  let baseBefore = (await client.walletBalances(owner.publicKey)).base;
  if (baseBefore < BigInt(RELAY_FEE)) {
    base.withdrawFeeReserve = await sendBase([createTransferInstruction(tokenAddress(admin.publicKey), tokenAddress(owner.publicKey), admin.publicKey, BigInt(RELAY_FEE) - baseBefore)], [admin]);
    baseBefore = (await client.walletBalances(owner.publicKey)).base;
  }
  await payments.execute(owner, 'withdraw', withdrawAmount);
  const baseAfter = (await client.walletBalances(owner.publicKey)).base;
  const withdrawLanded = baseAfter === baseBefore - BigInt(RELAY_FEE) + withdrawAmount && !payments.pending(owner.publicKey.toBase58());
  invariant(withdrawLanded, `Withdraw mismatch: base ${baseBefore} -> ${baseAfter}`);

  const lamportsAfter = await Promise.all(players.map(player => lamports(player.publicKey)));
  const zeroSol = lamportsAfter.every(value => value.base === 0 && value.er === 0);
  invariant(zeroSol, `A player wallet gained lamports: ${json(lamportsAfter)}`);
  // Table history newest first, down to this game's open; everything not sent by the bots is a VRF callback.
  const history = await client.er.getSignaturesForAddress(address, { limit: 1000, until: sent[0].signature }, 'confirmed');
  const ours = new Set(sent.map(tx => tx.signature));
  const result = {
    ok: true, at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), table: { index: free[0].index, address: address.toBase58(), gameNonce: nonce },
    players: players.map((player, seat) => ({ seat, wallet: player.publicKey.toBase58(), name: names[seat], finalCash: finishedView.seats[seat].cash,
      eliminatedAt: finishedView.seats[seat].eliminatedAt, strikes: finishedView.seats[seat].strikes, payout: usdc(expected.payouts[seat]),
      erBefore: usdc(before.players[seat]), erAfter: usdc(after.players[seat]), lamports: lamportsAfter[seat] })),
    tradesMode: trades, pot: usdc(pot), treasuryDelta: usdc(after.treasury - before.treasury), feeBps: 300, rounds: finishedView.round, rolls: turns, endedBy, events,
    assertions: { ...assertions, withdrawLanded, zeroSol },
    withdraw: { seat: withdrawer.seat, amount: usdc(withdrawAmount), baseBefore: usdc(baseBefore), baseAfter: usdc(baseAfter) },
    signatures: { base, payments: paymentSignatures, settle: settle.signature, er: sent.map(tx => ({ label: tx.label, signature: tx.signature, ms: tx.confirmedAt - tx.sentAt })),
      vrfCallbacks: history.filter(entry => !ours.has(entry.signature) && entry.err === null).length },
    admin: { lamportsSpent: adminBefore.lamports - await client.base.getBalance(admin.publicKey), usdcSpent: usdc(adminBefore.usdc - (await client.walletBalances(admin.publicKey)).base) },
  };
  console.log(saveArtifact('smoke-execute.json', result));
}

if (args.has('check')) await check();
else if (args.has('execute')) await execute();
else throw new Error('Usage: smoke --check | --execute [--players N] [--target 3000] [--trades]');
