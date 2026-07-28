# 🍍 Pineapple Poker

Free play-money poker with friends, in the browser. Create a private table,
share the link, approve who sits down, and play — no downloads, no accounts,
no real money.

**Games:** Texas Hold'em · Pineapple (discard before the flop) ·
Crazy Pineapple (discard after the flop) · Pot Limit Omaha

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open the site, click **Start a New Game**, pick your settings, and share the
table URL. Friends request seats; the host approves each one with their
buy-in. Works on phones (landscape recommended).

## Accounts are optional

You never need one. Open a link, pick a nickname, play — exactly as before.
Signing up with an email adds an all-time ledger across sessions, poker
stats, a saved invite list, and a table theme that follows you.

Data lives in a SQLite file at `data/pineapple.db` (override with
`PP_DB_PATH`), created automatically on first run.

## Features

- Real-time multiplayer over Socket.IO — server-authoritative engine, hole
  cards never leave the server except to their owner
- Optional email accounts (scrypt-hashed passwords, bearer session tokens)
  with a profile page at `/me`
- Full ring-game rules: heads-up blinds, min-raise tracking, short all-ins
  that don't reopen action, side pots with odd-chip distribution, all-in
  run-outs with revealed hands, split pots
- Pot-limit bet sizing for Omaha; simultaneous discard phase for the
  pineapple variants
- Host controls: approve seats, pause, change blinds/timer, top up or reduce
  stacks, kick players, close the table
- Chat, hand-by-hand log, and a session ledger (buy-ins / cash-outs / net)
- Reconnect: refresh mid-hand and you're back in your seat, cards intact
- Action timers with auto check/fold and away handling

## Project layout

```
server/       engine + game orchestration + socket protocol
  deck.js       cards, crypto shuffle
  evaluator.js  5-card scorer, best-of-7, Omaha 2-of-4 enumeration
  betting.js    action legality, min-raise/all-in rules, PLO pot math
  pots.js       side-pot construction and payout
  hand.js       one hand's state machine (blinds → streets → showdown)
  game.js       table: seats, lobby, hand loop, ledger, host ops
  views.js      public vs per-player state (the privacy boundary)
  sockets.js    Socket.IO handlers, validation, broadcasts
shared/       constants served to both server and browser
public/       vanilla HTML/CSS/JS frontend (no build step)
test/         plain-node test suites (no framework)
```

## Tests

```bash
npm test               # evaluator, side pots, betting, database/accounts, hardening
npm run soak           # bots play hands on every variant end-to-end
npm run smoke          # Playwright UI test (real browsers, guest + account flows)
```
