# Reg-Poker Online

Free play-money poker with friends, in the browser. Create a private table,
share the link, approve who sits down, and play — no downloads, no real money.
Sign up with an email once; the ledger is written against your account.

**Games:** Texas Hold'em · Pineapple (discard before the flop) ·
Crazy Pineapple (discard after the flop) · Pot Limit Omaha ·
747 Poker (everyone antes and plays the dealer's hand — fours are wild,
two natural sevens win outright, and an unbeaten dealer's pot rides)

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

## Play it online / install it as an app

See **[DEPLOY.md](DEPLOY.md)** for putting it on the internet (Fly.io
config, Dockerfile and a step-by-step guide are included). Once it's
hosted, the site is an installable web app: use the **📲 Install the app**
button on the landing page (desktop Chrome/Edge and Android show a real
install prompt; iPhone uses Share → Add to Home Screen). Installed, it
opens fullscreen like any app, and the 🔔 at the table turns on "it's your
turn" notifications that arrive even with the app closed.

Open the site, click **Start a New Game**, pick your settings, and share the
table URL. Friends request seats; the host approves each one with their
buy-in. Works on phones (landscape recommended).

## Accounts

An account is required to host a table or sit at one. It is what the night's
ledger is written against — the running total across nights, the stacks
carried from one game to the next, and the .csv mailed to the host when a
table closes all key on it. It also carries your poker stats, saved invite
list and table theme from game to game.

Signing up is an email, a password and a display name. Following an invite
link while signed out asks for one in place, then joins that table.

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
  pineapple variants; a second engine for 747 Poker (simultaneous
  stay/fold with a 3-2-1 reveal, wildcard evaluation, riding pots)
- A live readout under your cards telling you what your hand currently is
- Host controls: approve seats, pause, change blinds/timer, top up or reduce
  stacks, kick players, close the table
- Chat, emoji reactions, hand-by-hand log, and a session ledger with
  settle-up ("who pays whom") and CSV export
- Reconnect: refresh mid-hand and you're back in your seat, cards intact
- Action timers with auto check/fold and away handling, an optional time
  bank, an untimed "no clock" mode, and a host nudge for stallers
- Check/Fold, Check and Call-Any pre-action buttons
- Home-game options: straddle, rabbit hunt, run it twice, bomb pots and a
  toggleable 7-2 bounty with a custom payout (paid in Hold'em and the
  Pineapples, where 7-2 is the worst hand you can be dealt — not in the
  four-, five- or seven-card games) — and a 6-2 win gets its own table-wide
  callout (glory only, no chips)
- Once a hand is over anyone can show their cards: fold-winners flashing
  the bluff, folders showing what they let go
- No caps on blinds, and table stakes are the host's call. Buy-ins and
  re-buys have one ceiling, far above any real game, so the ledger's running
  totals stay in exact-integer range
- A waitlist that auto-seats people between hands when the table is full
- Cooler and bad-beat callouts, judged by real all-in equity
- Hand replayer with shareable links at `/hands/:id`
- Auto-invite email lists and Discord webhook posts for new tables
- Custom table felt image and colours, saved to your profile

## Sounds

Every sound is synthesized in the browser with WebAudio — no audio files
ship with this project. If you want specific clips, upload your own on the
profile page and map them to triggers (cooler, bad beat, quads, win, bust,
your turn). Only upload audio you have the rights to use.

## Optional configuration

| Variable | Effect |
|---|---|
| `PP_DB_PATH` | SQLite file location (default `data/pineapple.db`) |
| `PP_UPLOAD_DIR` | Where uploads are stored (default `data/uploads`) |
| `SMTP_URL` | Enables real email delivery; without it invites and the host's end-of-game ledger email are logged to an outbox and the UI says so |
| `SMTP_FROM` | From address on invite emails |
| `PORT` | HTTP port (default 3000) |

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
  db.js         SQLite schema and migrations
  accounts.js   optional email accounts and sessions
  stats.js      session results and poker statistics
  equity.js     all-in equity (exact enumeration, or sampling preflop)
  cooler.js     cooler and bad-beat classification
  handStore.js  saved hands for the replayer
  uploads.js    validated uploads, table themes, soundboard
  notify.js     pluggable email / Discord notification channels
shared/       constants served to both server and browser
public/       vanilla HTML/CSS/JS frontend (no build step)
test/         plain-node test suites (no framework)
```

## Tests

```bash
npm test               # evaluator, side pots, betting, database/accounts, hardening
npm run soak           # bots play hands on every variant end-to-end
npm run smoke          # Playwright UI test (real browsers, sign-up + play flows)
```
