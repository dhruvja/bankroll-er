import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { board } from '../../shared/board';
import { NO_OFFER, NO_OWNER, tableAddress, type SeatView, type TableView } from '../../shared/chain';
import { BOT_RESERVE, botMove } from '../../shared/bot';

const NOW = 100_000;
const seat = (cash = 1500, overrides: Partial<SeatView> = {}): SeatView => ({ wallet: Keypair.generate().publicKey.toBase58(), name: 'P', refunded: false, cash,
  position: 0, jailTurns: 0, strikes: 0, eliminatedAt: 0, payout: 0, ...overrides });
function table(overrides: Partial<TableView> = {}): TableView {
  const host = Keypair.generate().publicKey;
  return {
    address: tableAddress(host).toBase58(), phase: 'playing', gameNonce: 1, vrfNonce: 0, host: host.toBase58(), held: 2000, entry: 1000, maxPlayers: 2,
    target: 2500, playerCount: 2, lobbyDeadline: NOW - 100, lastActionAt: NOW - 1, stage: 'preroll', stageDeadline: NOW + 30, turn: 0, order: [0, 1],
    round: 1, rollsThisTurn: 0, extraRoll: false, vrfPending: false, vrfRequestedAt: 0, lastRoll: 0, lastCard: 0, eliminationSeq: 0, endedAt: 0, freedAt: 0,
    seats: [seat(), seat()], board: board.spaces.map(() => ({ owner: NO_OWNER, buildings: 0 })), trade: { space: 0, offers: [NO_OFFER, NO_OFFER], deadline: 0 },
    theme: 0, startCash: 1500, ...overrides,
  };
}
const own = (view: TableView, owner: number, ...spaces: number[]) => { for (const space of spaces) view.board[space] = { owner, buildings: 0 }; return view; };

test('waits when it is not its turn or the game is not on', () => {
  assert.equal(botMove(table(), 1, NOW), undefined);
  assert.equal(botMove(table({ phase: 'lobby' }), 0, NOW), undefined);
  assert.equal(botMove(table({ stage: 'rolling' }), 0, NOW), undefined);
});

test('rolls, and builds first on a complete group while it keeps a reserve', () => {
  assert.deepEqual(botMove(table(), 0, NOW), { kind: 'roll' });
  const brown = own(table(), 0, 1, 2);
  assert.deepEqual(botMove(brown, 0, NOW), { kind: 'build', space: 1 });
  brown.seats[0].cash = 2 * BOT_RESERVE + 49;
  assert.deepEqual(botMove(brown, 0, NOW), { kind: 'roll' });
});

test('in debt it sells its cheapest property; in jail it pays bail only when rich', () => {
  const debt = own(table(), 0, 2, 27);
  debt.seats[0].cash = -50;
  assert.deepEqual(botMove(debt, 0, NOW), { kind: 'sell', space: 2 });
  const jailed = table({ seats: [seat(1500, { jailTurns: 2 }), seat()] });
  assert.deepEqual(botMove(jailed, 0, NOW), { kind: 'bail' });
  jailed.seats[0].cash = board.rules.bail + 2 * BOT_RESERVE - 1;
  assert.deepEqual(botMove(jailed, 0, NOW), { kind: 'roll' });
});

test('buys only when it keeps the reserve', () => {
  const landed = table({ stage: 'buydecision', seats: [seat(400, { position: 25 }), seat()] });
  assert.deepEqual(botMove(landed, 0, NOW), { kind: 'pass' });
  landed.seats[0].cash = 350 + BOT_RESERVE;
  assert.deepEqual(botMove(landed, 0, NOW), { kind: 'buy' });
});

test('skips putting a property up at Auction', () => {
  assert.deepEqual(botMove(own(table({ stage: 'tradeopen' }), 0, 1), 0, NOW), { kind: 'pass' });
});

test('as the lander, takes a swap for value or a group, else cancels once offers close', () => {
  const swap = own(table({ stage: 'tradeoffers', trade: { space: 4, offers: [NO_OFFER, 1], deadline: NOW + 10 } }), 0, 4, 2);
  own(swap, 1, 1);
  assert.deepEqual(botMove(swap, 0, NOW), { kind: 'trade-accept', seat: 1, space: 1 }, 'Brown 60 for Sky Blue 100 completes Brown');
  const cheap = own(table({ stage: 'tradeoffers', trade: { space: 27, offers: [NO_OFFER, 1], deadline: NOW + 10 } }), 0, 27);
  own(cheap, 1, 1);
  assert.equal(botMove(cheap, 0, NOW), undefined);
  assert.deepEqual(botMove(cheap, 0, NOW + 10), { kind: 'pass' });
});

test('offers its cheapest fair property, never one from a whole group, once', () => {
  const offer = own(table({ turn: 1, stage: 'tradeoffers', trade: { space: 27, offers: [NO_OFFER, NO_OFFER], deadline: NOW + 10 } }), 1, 27);
  own(offer, 0, 1, 2, 8);
  assert.deepEqual(botMove(offer, 0, NOW), { kind: 'trade-offer', space: 8 });
  offer.trade.offers[0] = 8;
  assert.equal(botMove(offer, 0, NOW), undefined);
  offer.trade.offers[0] = NO_OFFER;
  assert.equal(botMove(offer, 0, NOW + 10), undefined, 'offers closed');
});
