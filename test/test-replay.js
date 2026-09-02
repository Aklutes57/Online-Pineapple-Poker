// Hand persistence and the replayer's privacy rules.
// The critical assertions: an unfinished hand is never saved, and hole cards
// that were never shown down are not returned to other viewers.
// Usage: node test/test-replay.js

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'pp-replay-'));
process.env.PP_DB_PATH = path.join(dir, 'test.db');

const { initDb, closeDb } = await import('../server/db.js');
const accounts = await import('../server/accounts.js');
const handStore = await import('../server/handStore.js');
const { Hand } = await import('../server/hand.js');

let failures = 0;
let passes = 0;
function check(name, cond) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

initDb();
const acct = accounts.createAccount({
  email: 'replay@example.com', password: 'a good long password', displayName: 'Replayer',
}).account;

// A minimal game shaped like the real one.
function makeGame(players) {
  return {
    id: 'game-replay-1',
    handNo: 1,
    hostAccountId: acct.id,
    settings: { variant: 'holdem', smallBlind: 1, bigBlind: 2 },
    players: new Map(players.map((p) => [p.id, p])),
    ledgerRows: () => [],
  };
}

function makePlayer(seatIndex, nickname, stack, accountId = null) {
  return { id: `p${seatIndex}`, nickname, seatIndex, stack, accountId, sittingOut: false };
}

function ctx() {
  return {
    log() {}, changed() {}, finished() {},
    setTimer(name, ms, fn) { this.pending = fn; },
    clearTimer() { this.pending = null; },
    markAway() {},
  };
}

// ---- a hand that ends by fold: the winner's cards were never shown ----

{
  const players = [makePlayer(0, 'Alice', 200, acct.id), makePlayer(1, 'Bob', 200)];
  const game = makeGame(players);
  const c = ctx();
  const hand = new Hand({
    handNo: 1, variantKey: 'holdem', smallBlind: 1, bigBlind: 2, actionTime: 30,
    buttonSeat: 0, players, deck: ['As', 'Ad', 'Kh', 'Kc', '2c', '7d', '9s', '3h', '4d'], ctx: c,
  });

  check('an unfinished hand refuses to save', (() => {
    hand.start();
    try {
      handStore.saveHand(game, hand);
      return false;
    } catch {
      return true;
    }
  })());

  hand.handleAction(hand.bySeat.get(0), 'fold', null);
  check('hand finished by fold', hand.finished === true);

  const id = handStore.saveHand(game, hand);
  check('finished hand saves', typeof id === 'string' && id.length > 0);

  const asStranger = handStore.getHand(id, null);
  check('replay loads', asStranger !== null);
  check('a fold win hides everyone\'s cards', asStranger.players.every((p) => p.cards === null));
  check('card counts are still shown', asStranger.players.every((p) => p.cardCount === 2));
  check('no reveal events leak through the timeline',
    asStranger.timeline.every((e) => e.type !== 'reveal'));
  check('timeline recorded the blinds and the fold',
    asStranger.timeline.some((e) => e.type === 'post') &&
    asStranger.timeline.some((e) => e.type === 'action' && e.action === 'fold'));
  check('payout recorded', asStranger.timeline.some((e) => e.type === 'payout'));

  // A participant with an account still sees their own cards.
  const asAlice = handStore.getHand(id, acct.id);
  const alice = asAlice.players.find((p) => p.nickname === 'Alice');
  check('a participant sees their own hole cards', Array.isArray(alice.cards) && alice.cards.length === 2);
  const bob = asAlice.players.find((p) => p.nickname === 'Bob');
  check("a participant does not see an opponent's hidden cards", bob.cards === null);

  // Showing after the hand ends happens AFTER the row is written, so the saved
  // record has to be brought back in step — including the fairness openings,
  // or the replay's verifier would fail closed on a card it can see.
  hand.handleShowCards(hand.bySeat.get(0));
  handStore.updateHandShown(id, hand);
  const afterShow = handStore.getHand(id, null);
  const shownAlice = afterShow.players.find((p) => p.nickname === 'Alice');
  check('a voluntary show reaches the saved replay',
    Array.isArray(shownAlice.cards) && shownAlice.cards.length === 2);
  check('the folder who did not show is still hidden',
    afterShow.players.find((p) => p.nickname === 'Bob').cards === null);
}

// ---- a hand that goes to showdown: shown cards are public ----

let showdownId = null;
{
  const players = [makePlayer(0, 'Cara', 200), makePlayer(1, 'Dan', 200)];
  const game = makeGame(players);
  game.id = 'game-replay-2';
  const c = ctx();
  const hand = new Hand({
    handNo: 2, variantKey: 'holdem', smallBlind: 1, bigBlind: 2, actionTime: 30,
    buttonSeat: 0, players, deck: ['As', 'Ad', 'Kh', 'Kc', '2c', '7d', '9s', '3h', '4d'], ctx: c,
  });
  hand.start();
  hand.handleAction(hand.bySeat.get(0), 'call', null);
  hand.handleAction(hand.bySeat.get(1), 'check', null);
  for (let street = 0; street < 3; street++) {
    hand.handleAction(hand.bySeat.get(hand.toActSeat), 'check', null);
    hand.handleAction(hand.bySeat.get(hand.toActSeat), 'check', null);
  }
  check('reached showdown', hand.finished && hand.revealed);

  showdownId = handStore.saveHand(game, hand);
  const view = handStore.getHand(showdownId, null);
  check('showdown cards are public', view.players.every((p) => Array.isArray(p.cards)));
  check('showdown descriptions are public', view.players.every((p) => typeof p.desc === 'string'));
  check('reveal events are kept', view.timeline.some((e) => e.type === 'reveal'));
  check('board recorded', view.board.length === 5);
  check('pot recorded', view.pot > 0);
  check('a winner is recorded', view.winners.length >= 1);
}

// ---- a fold before showdown stays private in the replay ----

{
  const players = [makePlayer(0, 'Eve', 200), makePlayer(1, 'Frank', 200), makePlayer(2, 'Gus', 200)];
  const game = makeGame(players);
  game.id = 'game-replay-3';
  const c = ctx();
  const hand = new Hand({
    handNo: 3, variantKey: 'holdem', smallBlind: 1, bigBlind: 2, actionTime: 30,
    buttonSeat: 0, players,
    deck: ['As', 'Ad', 'Kh', 'Kc', 'Qs', 'Qd', '2c', '7d', '9s', '3h', '4d'], ctx: c,
  });
  hand.start();
  hand.handleAction(hand.bySeat.get(0), 'fold', null);
  hand.handleAction(hand.bySeat.get(1), 'call', null);
  hand.handleAction(hand.bySeat.get(2), 'check', null);
  for (let street = 0; street < 3; street++) {
    hand.handleAction(hand.bySeat.get(hand.toActSeat), 'check', null);
    hand.handleAction(hand.bySeat.get(hand.toActSeat), 'check', null);
  }
  check('fold-then-showdown: hand revealed', hand.finished && hand.revealed);
  const id = handStore.saveHand(game, hand);
  const view = handStore.getHand(id, null);
  const eve = view.players.find((p) => p.nickname === 'Eve');
  check('a folded hand stays hidden in the replay', eve.cards === null && eve.folded === true);
  check('the showdown hands are still public',
    view.players.filter((p) => !p.folded).every((p) => Array.isArray(p.cards)));
}

// ---- unknown ids ----

check('unknown hand id returns null', handStore.getHand('does-not-exist') === null);

// ---- reactions ----

check('reaction added', handStore.addHandReaction(showdownId, {
  emoji: '🔥', accountId: acct.id, nickname: 'Replayer',
}).ok === true);
check('reaction counted', handStore.listReactions(showdownId)[0].count === 1);

handStore.addHandReaction(showdownId, { emoji: '🔥', accountId: acct.id, nickname: 'Replayer' });
check('the same person cannot stack the same emoji', handStore.listReactions(showdownId)[0].count === 1);

handStore.addHandReaction(showdownId, { emoji: '🔥', accountId: null, nickname: 'SomeGuest' });
check('a different person can add the same emoji', handStore.listReactions(showdownId)[0].count === 2);

handStore.addHandReaction(showdownId, { emoji: '🔥', accountId: null, nickname: 'SomeGuest' });
check('a guest cannot stack the same emoji either', handStore.listReactions(showdownId)[0].count === 2);

handStore.addHandReaction(showdownId, { emoji: '😱', accountId: acct.id, nickname: 'Replayer' });
check('a different emoji is a separate entry', handStore.listReactions(showdownId).length === 2);
check('reactions attach to the replay', handStore.getHand(showdownId).reactions.length === 2);
check('reacting to an unknown hand fails',
  handStore.addHandReaction('nope', { emoji: '🔥', accountId: null, nickname: 'X' }).ok === false);

// ---- per-game listing ----

const listed = handStore.recentHandsForGame('game-replay-2');
check('hands listed for a game', listed.length === 1 && listed[0].id === showdownId);
check('unknown game lists nothing', handStore.recentHandsForGame('nope').length === 0);

closeDb();
rmSync(dir, { recursive: true, force: true });

console.log(`replay: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
