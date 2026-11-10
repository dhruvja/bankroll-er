/**
 * Devnet smoke on ephemeral tables.
 *   --check                                   read-only readiness (G7)
 *   --execute [--players 3] [--target 2500] [--entry 1000] [--trades]
 *                                             G8, zero-SOL bots:
 *                                             - SOL sent to bot 3's table address blocks its first
 *                                               open; `unblock_table` sweeps it and the open retries;
 *                                               bot 2 joins, and nobody starts it;
 *                                             - bot 1's table is created and plays an N-player game
 *                                               to settle; with --trades they trade on every Auction
 *                                               landing they can;
 *                                             - bot 1 re-opens it in place at once (same address,
 *                                               next nonce, no new rent); an invite to the old game
 *                                               is refused; bot 2 joins and a 2-player game settles;
 *                                             - bot 3's lobby expires and every seat is refunded;
 *                                             - a close is refused before the grace; after the real
 *                                               10-min grace a fresh zero-SOL wallet closes both
 *                                               tables and the house rent, liability and vault are
 *                                               back where they started.
 *   --execute --abandon [--resume]            3 bots play a few turns, then all stop; after the real
 *                                             60-min idle deadline the returning current seat is
 *                                             refused, and one transaction from a fresh zero-SOL
 *                                             wallet ends, ranks and settles the game exactly.
 *                                             --resume continues from smoke-abandon-start.json
 * Player wallets come from `.env` (SMOKE_PLAYER_<n>, base58 secret keys) and are created there if
 * missing. They never receive SOL; the admin only tops up their base USDC.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { DELEGATION_PROGRAM_ID, EPHEMERAL_SPL_TOKEN_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-sdk';
import { DEMO_ENTRY, ENTRIES, ER_RPC, PUBLIC_VALIDATOR, ROUTER_RPC, TOKEN_SCALE, invariant } from '../shared/config';
import {
  CLOSE_GRACE_SECONDS, NO_OFFER, PROGRAM_ID, canBuild, currentSeat, tradeOffers, tradeable, custodyAddress, delegationStatus, expectedPayouts, houseAddress, isActive,
  mintKey, netWorth, tableAddress, treasuryAddress, type TableView,
} from '../shared/chain';
import { board } from '../shared/board';
import { ProgramError, type SentTransaction } from '../shared/client';
import { ARTIFACTS, client, filePayments, flags, fundPlayers, lamports, loadAdmin, loadWallets, readDeployment, readHouseStatus, requireDevnet, saveArtifact, sendBase } from './node';

const args = flags();
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
const now = () => Date.now() / 1000;
const usdc = (atoms: bigint | number) => (Number(atoms) / TOKEN_SCALE).toFixed(6);
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);

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
  await step('deployment', async () => {
    invariant(deployment.programId === PROGRAM_ID.toBase58() && deployment.house === houseAddress().toBase58(), 'deployment.json is for another program.');
    return deployment;
  });
  await step('houseRouted', async () => {
    const route = await delegationStatus(houseAddress());
    invariant(route.isDelegated && route.delegationRecord?.authority === PUBLIC_VALIDATOR && route.fqdn && new URL(route.fqdn).origin === new URL(ER_RPC).origin,
      `House route via ${ROUTER_RPC}: ${JSON.stringify(route)}`);
    await client.verifyRoute();
    return { house: deployment.house, fqdn: route.fqdn };
  });
  await step('custodyLive', async () => {
    for (const owner of [houseAddress(), treasuryAddress()]) {
      invariant((await client.base.getAccountInfo(custodyAddress(owner)))?.owner.equals(DELEGATION_PROGRAM_ID), `${owner.toBase58()} custody is not delegated.`);
      invariant((await client.er.getAccountInfo(custodyAddress(owner)))?.owner.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID), `${owner.toBase58()} custody is not live on the ER.`);
    }
    return { vault: usdc(await client.erTokenBalance(houseAddress())), treasury: usdc(await client.erTokenBalance(treasuryAddress())) };
  });
  await step('houseHealthy', async () => {
    const status = await readHouseStatus();
    invariant(status.ok, `House status: ${json(status)}`);
    invariant(status.house.capacity > 0, 'The house cannot sponsor another table.');
    return { capacity: status.house.capacity, lamports: status.house.lamports, liability: status.house.liability.toString(), tables: status.occupancy };
  });
  console.log(saveArtifact('smoke-check.json', { ok: true, at: new Date().toISOString(), checks }));
}

type Events = {
  builds: number; sales: number; bails: number; jailTurnsServed: number; cards: number[]; eliminations: { seat: number; at: number }[];
  tradesOpened: number; tradePasses: number; offers: number; offersReplaced: number; emptyWindowsCancelled: number;
  trades: { lander: number; seat: number; gave: number; took: number; signature: string; verified: boolean }[];
};

/** Bots play sim.py's greedy policy from a started game to settle: sell out of debt, build when $150
 * stays in hand, bail with at least $500, buy when $100 stays in hand. With `idle`, the last seat
 * idles through its first turn so the others must strike it with force_timeout. */
async function playToSettle(address: PublicKey, seats: Keypair[], nonce: number, options: { idle: boolean; trades: boolean }, record: (tx: SentTransaction) => SentTransaction) {
  const playerCount = seats.length, idleSeat = playerCount - 1, startedAt = now();
  let idled = !options.idle, finishedView: TableView | undefined, settle: SentTransaction | undefined, turns = 0, replaced = false, lastCardNonce = 0;
  const events: Events = { builds: 0, sales: 0, bails: 0, jailTurnsServed: 0, cards: [], eliminations: [], tradesOpened: 0, tradePasses: 0, offers: 0,
    offersReplaced: 0, emptyWindowsCancelled: 0, trades: [] };
  /** A seat's unbuilt properties, cheapest first. */
  const unbuilt = (view: TableView, owner: number) => board.spaces.filter(space => tradeable(view, owner, space.index))
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0)).map(space => space.index);
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
    const table = await client.readTable(address);
    invariant(table.gameNonce === nonce, 'The table moved to another game.');
    const seat = currentSeat(table), actor = seats[seat];
    if (table.phase === 'finished') {
      finishedView = table;
      settle = record(await client.settle(address, seats[0], table));
      break;
    }
    invariant(table.phase === 'playing', `Unexpected phase ${table.phase}.`);
    // A card belongs to the callback that answered `vrfNonce`; count it once, after that callback.
    if (table.stage !== 'rolling' && table.lastCard && table.vrfNonce !== lastCardNonce) { events.cards.push(table.lastCard); lastCardNonce = table.vrfNonce; }
    if (table.stage === 'ordering' || table.stage === 'rolling') {
      if (now() > table.vrfRequestedAt + board.rules.deadlinesSec.vrfRetry + 1) {
        await attempt('vrf retry', () => table.stage === 'ordering' ? client.startGame(address, seats[0]) : client.roll(address, actor));
      } else await pause(150);
      continue;
    }
    if (table.stage === 'preroll' && seat === idleSeat && !idled) {
      if (now() < table.stageDeadline + 1) { await pause(500); continue; }
      await attempt('timeout', () => client.forceTimeout(address, seats[(idleSeat + 1) % playerCount]));
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
      if (!options.trades || give === undefined) { if (await attempt('trade-pass', () => client.pass(address, actor))) events.tradePasses++; continue; }
      if (await attempt('trade-open', () => client.openTrade(address, actor, give))) events.tradesOpened++;
      continue;
    }
    if (table.stage === 'tradeoffers') {
      const view = table, open = now() < view.trade.deadline - 2;
      // Every other active seat offers its cheapest unbuilt property; the first one then replaces its
      // offer once with its next property, so replacement runs on chain too.
      const offerer = view.order.find(other => other !== seat && isActive(view, other) && view.trade.offers[other] === NO_OFFER && unbuilt(view, other).length > 0);
      if (open && offerer !== undefined) {
        if (await attempt('trade-offer', () => client.offerTrade(address, seats[offerer], unbuilt(view, offerer)[0]))) events.offers++;
        continue;
      }
      const switcher = tradeOffers(view).find(offer => unbuilt(view, offer.seat).length > 1);
      if (open && !replaced && switcher) {
        const next = unbuilt(view, switcher.seat).find(space => space !== switcher.space)!;
        if (await attempt('trade-replace', () => client.offerTrade(address, seats[switcher.seat], next))) { events.offersReplaced++; replaced = true; }
        continue;
      }
      const pick = tradeOffers(view)[0];
      if (!pick) {
        if (now() < view.trade.deadline + 1) { await pause(500); continue; }
        if (await attempt('timeout', () => client.forceTimeout(address, seats[(seat + 1) % playerCount]))) events.emptyWindowsCancelled++;
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
  return { finishedView: done, settle, events, turns, endedBy, idled };
}

/** Polls the ER until `check` passes (reads can trail a confirmed signature), then returns the last
 * result; the caller asserts it. */
async function settled<T extends { assertions: Record<string, boolean> }>(read: () => Promise<T>, polls = 40): Promise<T> {
  let result = await read();
  for (let poll = 1; poll < polls && !Object.values(result.assertions).every(Boolean); poll++) { await pause(500); result = await read(); }
  return result;
}
const allTrue = (assertions: Record<string, boolean>) => Object.values(assertions).every(Boolean);

async function execute() {
  const playerCount = Number(args.value('players') ?? 3), target = Number(args.value('target') ?? 2500), entry = Number(args.value('entry') ?? DEMO_ENTRY);
  const trades = args.has('trades');
  invariant([3, 4].includes(playerCount) && board.rules.targets.includes(target) && (ENTRIES as readonly number[]).includes(entry),
    'Use --players 3-4, --target 2500/5000/7000 and an --entry the program accepts.');
  await requireDevnet();
  readDeployment();
  const admin = loadAdmin(), players = loadWallets('SMOKE_PLAYER_', playerCount), names = players.map((_, index) => `Bot ${index + 1}`);
  const [host, second, lobbyHost] = players, entryAtoms = BigInt(entry);
  const { payments, signatures: paymentSignatures } = filePayments();
  const sent: SentTransaction[] = [], base: Record<string, string> = {};
  const record = (tx: SentTransaction) => { sent.push(tx); return tx; };
  const adminBefore = { lamports: await client.base.getBalance(admin.publicKey), usdc: (await client.walletBalances(admin.publicKey)).base };
  // Bot 1: two games. Bot 2: both games and the expiring lobby. Bot 3: the first game and its lobby.
  const needs = players.map((_, index) => entryAtoms * BigInt(index === 0 ? 2 : index === 1 ? 3 : index === 2 ? 2 : 1));
  await fundPlayers(players, admin, payments, needs, base);
  const hostTable = tableAddress(host.publicKey), lobbyTable = tableAddress(lobbyHost.publicKey), treasury = treasuryAddress(), house = houseAddress();
  for (const address of [hostTable, lobbyTable]) {
    invariant(!(await client.er.getAccountInfo(address)), `${address.toBase58()} already exists; close it (pnpm status shows when) before the smoke.`);
  }
  const ledger = () => Promise.all([Promise.all(players.map(player => client.erTokenBalance(player.publicKey))), client.erTokenBalance(treasury),
    client.erTokenBalance(house), client.readHouse()]).then(([balances, treasuryBalance, vault, houseView]) => ({ players: balances, treasury: treasuryBalance, vault, house: houseView }));
  const start = await ledger();
  invariant(start.house.liability === (await readHouseStatus()).heldTotal, 'The house liability does not match the live tables before the smoke.');

  // 1. Audit F-1 on the deployed program: SOL at bot 3's table address blocks the ER create until
  // `unblock_table` sweeps it to the caller (the admin here, the public faucet in the web app).
  const rentExempt = await client.base.getMinimumBalanceForRentExemption(0);
  base.prefund = await sendBase([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: lobbyTable, lamports: rentExempt })], [admin]);
  invariant(await client.blocked(lobbyHost.publicKey), 'The prefunded table address does not read as blocked.');
  const lobbyOpen = await client.openTable(lobbyHost, { name: names[2], entry, maxPlayers: 2, target: 2500 }, admin);
  record(lobbyOpen);
  invariant(lobbyOpen.unblocked, 'The prefunded address did not block the first open.');
  const unblock = { prefundLamports: rentExempt, signature: lobbyOpen.unblocked, blockedAfter: await client.blocked(lobbyHost.publicKey) };
  const lobby = await client.readTable(lobbyTable);
  record(await client.joinTable(lobbyTable, second, lobby.gameNonce, names[1]));

  // 2. Bot 1's table is created by its first open and plays an N-player game to settle.
  const houseBeforeCreate = await client.readHouse();
  record(await client.openTable(host, { name: names[0], entry, maxPlayers: playerCount, target }));
  let table = await client.readTable(hostTable);
  const created = await client.readHouse();
  const firstNonce = table.gameNonce, seatsOne = players.slice(0, playerCount);
  for (let seat = 1; seat < playerCount; seat++) record(await client.joinTable(hostTable, players[seat], firstNonce, names[seat]));
  const beforeOne = await ledger();
  record(await client.startGame(hostTable, host));
  const one = await playToSettle(hostTable, seatsOne, firstNonce, { idle: true, trades }, record);
  const expectedOne = expectedPayouts(one.finishedView), potOne = entryAtoms * BigInt(playerCount);
  const gameOne = await settled(async () => {
    const view = await client.readTable(hostTable), after = await ledger();
    return { view, after, assertions: {
      tableFree: view.phase === 'free' && view.gameNonce === firstNonce,
      heldZero: view.held === 0,
      payoutsRecorded: view.seats.every((seat, index) => seat.payout === expectedOne.payouts[index]),
      playerBalancesExact: seatsOne.every((_, index) => after.players[index] - beforeOne.players[index] === BigInt(expectedOne.payouts[index])),
      treasuryExact: after.treasury - beforeOne.treasury === BigInt(expectedOne.treasury),
      feeAtLeast3Percent: BigInt(expectedOne.treasury) * 10_000n >= potOne * 300n,
      liabilityReleased: after.house.liability === beforeOne.house.liability - potOne,
      vaultPaidOut: after.vault === beforeOne.vault - potOne,
      idleSeatStruck: view.seats[playerCount - 1].strikes >= 1,
      endedByTargetOrBankruptcy: one.endedBy !== 'idle',
    } };
  });
  invariant(allTrue(gameOne.assertions), `Game 1 settlement mismatch: ${json({ ...gameOne, expectedOne, beforeOne })}`);
  const tradeCompleted = one.events.trades.length > 0 && one.events.trades.every(trade => trade.verified);
  if (trades) invariant(tradeCompleted, `No verified trade this game (${json(one.events)}); settlement was exact, rerun the smoke.`);

  // 3. Bot 1 re-opens in place right away: same account, next nonce, no new table or rent. An
  // invite to the finished game is refused.
  const houseBeforeReopen = await client.readHouse();
  record(await client.openTable(host, { name: names[0], entry, maxPlayers: 2, target: 2500 }));
  table = await client.readTable(hostTable);
  const houseAfterReopen = await client.readHouse();
  let staleInvite: string | undefined;
  try { await client.joinTable(hostTable, players[2], firstNonce, names[2]); } catch (error) {
    invariant(error instanceof ProgramError && /^StaleNonce /.test(error.message), `Unexpected stale-invite error: ${String(error)}`);
    staleInvite = error.message;
  }
  const reopen = {
    sameAddress: table.address === hostTable.toBase58(), nextNonce: table.gameNonce === firstNonce + 1, vrfNonceKept: table.vrfNonce >= one.finishedView.vrfNonce,
    noNewTable: houseAfterReopen.tablesCreated === houseBeforeReopen.tablesCreated, noNewRent: houseAfterReopen.lamports === houseBeforeReopen.lamports,
    staleInviteRefused: staleInvite !== undefined,
  };
  invariant(allTrue(reopen), `Re-open in place failed: ${json({ reopen, table, houseBeforeReopen, houseAfterReopen })}`);
  const secondNonce = table.gameNonce, seatsTwo = [host, second];
  record(await client.joinTable(hostTable, second, secondNonce, names[1]));
  const beforeTwo = await ledger();
  record(await client.startGame(hostTable, host));
  const two = await playToSettle(hostTable, seatsTwo, secondNonce, { idle: false, trades: false }, record);
  const expectedTwo = expectedPayouts(two.finishedView), potTwo = entryAtoms * 2n;
  const gameTwo = await settled(async () => {
    const view = await client.readTable(hostTable), after = await ledger();
    return { view, after, assertions: {
      tableFree: view.phase === 'free' && view.gameNonce === secondNonce,
      heldZero: view.held === 0,
      payoutsRecorded: view.seats.every((seat, index) => seat.payout === expectedTwo.payouts[index]),
      playerBalancesExact: seatsTwo.every((_, index) => after.players[index] - beforeTwo.players[index] === BigInt(expectedTwo.payouts[index])),
      treasuryExact: after.treasury - beforeTwo.treasury === BigInt(expectedTwo.treasury),
      liabilityReleased: after.house.liability === beforeTwo.house.liability - potTwo,
      vaultPaidOut: after.vault === beforeTwo.vault - potTwo,
    } };
  });
  invariant(allTrue(gameTwo.assertions), `Game 2 settlement mismatch: ${json({ ...gameTwo, expectedTwo, beforeTwo })}`);

  // 4. Bot 3's lobby expires on the ER clock; a seat that isn't the host expires it and every seat
  // gets its full entry back.
  for (let erNow = await client.erNow(); erNow < lobby.lobbyDeadline + 1; erNow = await client.erNow()) {
    console.log(`waiting ${lobby.lobbyDeadline + 1 - erNow} s for bot 3's lobby to expire`);
    await pause(Math.min(30_000, Math.max(1_000, (lobby.lobbyDeadline + 1 - erNow) * 1000)));
  }
  const beforeRefund = await ledger();
  record(await client.cancel(lobbyTable, host));
  const refunding = await client.readTable(lobbyTable);
  for (const tx of await client.refundPending(lobbyTable, host, refunding, await client.erNow())) record(tx);
  const lobbyRefund = await settled(async () => {
    const view = await client.readTable(lobbyTable), after = await ledger();
    return { view, after, assertions: {
      tableFree: view.phase === 'free' && view.held === 0 && view.freedAt > 0,
      lobbyHostRefunded: after.players[2] - beforeRefund.players[2] === entryAtoms,
      joinerRefunded: after.players[1] - beforeRefund.players[1] === entryAtoms,
      noFee: after.treasury === beforeRefund.treasury,
      liabilityReleased: after.house.liability === beforeRefund.house.liability - 2n * entryAtoms,
    } };
  });
  invariant(allTrue(lobbyRefund.assertions), `Lobby refund mismatch: ${json({ ...lobbyRefund, beforeRefund })}`);

  // 5. Close: refused inside the grace, then a fresh zero-SOL wallet closes both tables after it.
  const closer = Keypair.generate();
  let earlyClose: string | undefined;
  try { await client.closeTable(hostTable, closer); } catch (error) {
    invariant(error instanceof ProgramError && /^TooEarly /.test(error.message), `Unexpected early-close error: ${String(error)}`);
    earlyClose = error.message;
  }
  invariant(earlyClose, 'A table closed inside its grace.');
  const closableAt = Math.max(gameTwo.view.freedAt, lobbyRefund.view.freedAt) + CLOSE_GRACE_SECONDS;
  for (let erNow = await client.erNow(); erNow < closableAt + 1; erNow = await client.erNow()) {
    console.log(`waiting ${closableAt + 1 - erNow} s for the close grace`);
    await pause(Math.min(30_000, Math.max(1_000, (closableAt + 1 - erNow) * 1000)));
  }
  const closes = [record(await client.closeTable(hostTable, closer)), record(await client.closeTable(lobbyTable, closer))];
  const end = await settled(async () => {
    const after = await ledger(), accounts = await client.er.getMultipleAccountsInfo([hostTable, lobbyTable], 'confirmed');
    const expectedNet = (seat: number) => (BigInt(expectedOne.payouts[seat] ?? 0) - entryAtoms) + (seat < 2 ? BigInt(expectedTwo.payouts[seat]) - entryAtoms : 0n);
    return { after, assertions: {
      tablesClosed: accounts.every(account => !account || !account.owner.equals(PROGRAM_ID)),
      houseRentRestored: after.house.lamports === start.house.lamports,
      twoTablesCreated: after.house.tablesCreated === start.house.tablesCreated + 2n,
      liabilityBack: after.house.liability === start.house.liability,
      vaultBack: after.vault === start.vault,
      playerBalancesExact: players.every((_, seat) => after.players[seat] - start.players[seat] === expectedNet(seat)),
      treasuryExact: after.treasury - start.treasury === BigInt(expectedOne.treasury + expectedTwo.treasury),
    } };
  });
  invariant(allTrue(end.assertions), `Close mismatch: ${json({ ...end, start })}`);
  const lamportsAfter = await Promise.all([...players, closer].map(player => lamports(player.publicKey)));
  const zeroSol = lamportsAfter.every(value => value.base === 0 && value.er === 0);
  invariant(zeroSol, `A player wallet gained lamports: ${json(lamportsAfter)}`);
  const callbacks = async (address: PublicKey, from: string) => {
    const ours = new Set(sent.map(tx => tx.signature));
    // History of a closed ephemeral account may be gone; that only loses this count.
    try { return (await client.er.getSignaturesForAddress(address, { limit: 1000, until: from }, 'confirmed')).filter(item => !ours.has(item.signature) && item.err === null).length; }
    catch { return -1; }
  };
  const result = {
    ok: true, at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), entry: usdc(entry), houseAddress: house.toBase58(),
    tables: { host: hostTable.toBase58(), lobby: lobbyTable.toBase58() },
    players: players.map((player, seat) => ({ seat, wallet: player.publicKey.toBase58(), name: names[seat], erStart: usdc(start.players[seat]), erEnd: usdc(end.after.players[seat]),
      lamports: lamportsAfter[seat] })),
    unblock, created: { tablesCreatedBefore: houseBeforeCreate.tablesCreated, tablesCreatedAfter: created.tablesCreated, rentCharged: houseBeforeCreate.lamports - created.lamports },
    games: [one, two].map((game, index) => ({ players: index === 0 ? playerCount : 2, gameNonce: index === 0 ? firstNonce : secondNonce, rounds: game.finishedView.round,
      rolls: game.turns, endedBy: game.endedBy, payouts: (index === 0 ? expectedOne : expectedTwo).payouts.map(usdc), treasury: usdc((index === 0 ? expectedOne : expectedTwo).treasury),
      events: game.events, settle: game.settle.signature, assertions: index === 0 ? gameOne.assertions : gameTwo.assertions })),
    tradesMode: trades, reopen, lobbyRefund: { lobbyDeadline: lobby.lobbyDeadline, assertions: lobbyRefund.assertions }, earlyClose,
    close: { closer: closer.publicKey.toBase58(), closableAt, signatures: closes.map(tx => tx.signature) },
    house: { start: start.house, end: end.after.house }, vault: { start: start.vault, end: end.after.vault },
    assertions: { ...end.assertions, ...(trades ? { tradeCompleted } : {}), zeroSol },
    signatures: { base, payments: paymentSignatures, er: sent.map(tx => ({ label: tx.label, signature: tx.signature, ms: tx.confirmedAt - tx.sentAt })),
      vrfCallbacks: await callbacks(hostTable, sent[2].signature) },
    admin: { lamportsSpent: adminBefore.lamports - await client.base.getBalance(admin.publicKey), usdcSpent: usdc(adminBefore.usdc - (await client.walletBalances(admin.publicKey)).base) },
  };
  console.log(saveArtifact('smoke-execute.json', result));
}

interface AbandonStart {
  at: string; table: { address: string; gameNonce: number }; players: string[]; rolls: number;
  /** The table as the bots left it, and each seat's ER USDC then (entries already paid). */
  snapshot: TableView; erAtAbandon: string[]; treasuryAtAbandon: string; idleAt: number; signatures: { label: string; signature: string }[];
}

/** G8 abandon: everyone stops, and only a ranking can end the game, from any returning client. */
async function abandon() {
  await requireDevnet();
  const players = loadWallets('SMOKE_PLAYER_', 3), entry = TOKEN_SCALE, startFile = resolve(ARTIFACTS, 'smoke-abandon-start.json');
  let start: AbandonStart;
  if (args.has('resume')) start = JSON.parse(readFileSync(startFile, 'utf8')) as AbandonStart;
  else {
    const admin = loadAdmin(), base: Record<string, string> = {};
    const { payments } = filePayments();
    await fundPlayers(players, admin, payments, players.map(() => BigInt(entry)), base);
    const sent: SentTransaction[] = [];
    const opened = await client.openTable(players[0], { name: 'Bot 1', entry, maxPlayers: 3, target: 7000 });
    sent.push(opened);
    const address = opened.table, nonce = (await client.readTable(address)).gameNonce;
    for (const seat of [1, 2]) sent.push(await client.joinTable(address, players[seat], nonce, `Bot ${seat + 1}`));
    sent.push(await client.startGame(address, players[0]));
    // A few turns of plain play (buy with $100 to spare, pass any trade), stopping in a PreRoll.
    let rolls = 0;
    for (;;) {
      const table = await client.readTable(address), seat = currentSeat(table), actor = players[seat];
      invariant(table.phase === 'playing', `Unexpected phase ${table.phase} before the abandon.`);
      if (table.stage === 'ordering' || table.stage === 'rolling') {
        if (Date.now() / 1000 > table.vrfRequestedAt + board.rules.deadlinesSec.vrfRetry + 1) {
          sent.push(await (table.stage === 'ordering' ? client.startGame(address, players[0]) : client.roll(address, actor)));
        } else await pause(150);
        continue;
      }
      if (table.stage === 'preroll' && rolls >= 6 && table.lastRoll !== 0) break;
      if (table.stage === 'preroll') { sent.push(await client.roll(address, actor)); rolls++; continue; }
      if (table.stage === 'buydecision') {
        const price = board.spaces[table.seats[seat].position].price ?? 0;
        sent.push(await (table.seats[seat].cash - price >= 100 ? client.buy(address, actor) : client.pass(address, actor)));
        continue;
      }
      if (table.stage === 'tradeopen' || table.stage === 'tradeoffers') { sent.push(await client.pass(address, actor)); continue; }
      throw new Error(`Unexpected stage ${table.stage}.`);
    }
    const snapshot = await client.readTable(address);
    start = {
      at: new Date().toISOString(), table: { address: address.toBase58(), gameNonce: nonce }, players: players.map(player => player.publicKey.toBase58()),
      rolls, snapshot, erAtAbandon: (await Promise.all(players.map(player => client.erTokenBalance(player.publicKey)))).map(String),
      treasuryAtAbandon: String(await client.erTokenBalance(treasuryAddress())), idleAt: snapshot.lastActionAt + board.rules.deadlinesSec.idle,
      signatures: [...sent.map(tx => ({ label: tx.label, signature: tx.signature })), ...Object.entries(base).map(([label, signature]) => ({ label: `base:${label}`, signature }))],
    };
    saveArtifact('smoke-abandon-start.json', start);
    console.log(`abandoned table ${start.table.address} at ER ${snapshot.lastActionAt}; idle deadline ${new Date(start.idleAt * 1000).toISOString()}`);
  }

  // Every bot is gone. Nobody touches the table until the ER clock passes the idle deadline.
  const address = new PublicKey(start.table.address);
  for (let erNow = await client.erNow(); erNow < start.idleAt + 5; erNow = await client.erNow()) {
    const table = await client.readTable(address);
    invariant(table.gameNonce === start.table.gameNonce && table.phase === 'playing' && table.lastActionAt === start.snapshot.lastActionAt,
      `The abandoned table changed while waiting: ${json(table)}`);
    console.log(`waiting: ${Math.ceil((start.idleAt + 5 - erNow) / 60)} min to the idle deadline (ER ${erNow})`);
    await pause(Math.min(60_000, Math.max(5_000, (start.idleAt + 5 - erNow) * 1000)));
  }

  // The current seat returns first and tries to keep playing: refused, nothing changes.
  const seat = currentSeat(start.snapshot), returning = players[seat];
  let refused: { seat: number; error: string; signature: string } | undefined;
  try { await client.roll(address, returning); }
  catch (error) {
    invariant(error instanceof ProgramError && /^IdleDeadlinePassed /.test(error.message), `Unexpected refusal: ${String(error)}`);
    refused = { seat, error: error.message, signature: error.signature };
  }
  invariant(refused, 'The returning current seat was allowed to roll after the idle deadline.');
  const unchanged = await client.readTable(address);
  invariant(json(unchanged) === json(start.snapshot), 'A refused action changed the table.');

  // One transaction from a wallet that never played and holds no SOL: end by ranking and settle.
  const fresh = Keypair.generate();
  const ending = await client.endIdleAndSettle(address, fresh, unchanged);
  const expected = expectedPayouts(start.snapshot);
  const final = await settled(async () => {
    const table = await client.readTable(address);
    const after = { players: await Promise.all(players.map(player => client.erTokenBalance(player.publicKey))), treasury: await client.erTokenBalance(treasuryAddress()) };
    return { table, after, assertions: {
      tableFree: table.phase === 'free' && table.gameNonce === start.table.gameNonce,
      endedByIdleRanking: table.endedAt >= start.idleAt,
      noForfeits: table.seats.every((item, index) => item.strikes === start.snapshot.seats[index].strikes && item.eliminatedAt === start.snapshot.seats[index].eliminatedAt),
      payoutsRecorded: table.seats.every((item, index) => item.payout === expected.payouts[index]),
      playerBalancesExact: players.every((_, index) => after.players[index] - BigInt(start.erAtAbandon[index]) === BigInt(expected.payouts[index])),
      treasuryExact: after.treasury - BigInt(start.treasuryAtAbandon) === BigInt(expected.treasury),
      heldZero: table.held === 0,
    } };
  });
  invariant(allTrue(final.assertions), `Abandon settlement mismatch: ${json({ ...final, expected })}`);
  const lamportsAfter = await Promise.all([...players, fresh].map(player => lamports(player.publicKey)));
  const zeroSol = lamportsAfter.every(value => value.base === 0 && value.er === 0);
  invariant(zeroSol, `A wallet gained lamports: ${json(lamportsAfter)}`);
  console.log(saveArtifact('smoke-abandon.json', {
    ok: true, at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), table: start.table, abandonedAt: start.at, idleAt: start.idleAt, rollsBeforeAbandon: start.rolls,
    players: start.snapshot.seats.map((item, index) => ({ seat: index, wallet: item.wallet, cash: item.cash, netWorth: netWorth(start.snapshot, index), strikes: item.strikes,
      payout: usdc(expected.payouts[index]), erAtAbandon: usdc(BigInt(start.erAtAbandon[index])), erAfter: usdc(final.after.players[index]) })),
    pot: usdc(entry * 3), treasuryDelta: usdc(final.after.treasury - BigInt(start.treasuryAtAbandon)), refusedReturningSeat: refused,
    freshClient: fresh.publicKey.toBase58(), assertions: { ...final.assertions, refusedAfterIdle: true, zeroSol },
    signatures: { setup: start.signatures, refusedRoll: refused.signature, endAndSettle: ending.signature },
  }));
}

if (args.has('check')) await check();
else if (args.has('execute') && args.has('abandon')) await abandon();
else if (args.has('execute')) await execute();
else throw new Error('Usage: smoke --check | --execute [--players 3|4] [--target 2500] [--entry 1000] [--trades] | --execute --abandon [--resume]');
