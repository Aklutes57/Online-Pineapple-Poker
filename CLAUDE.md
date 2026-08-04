# Project notes for Claude

## User environment & preferences

- The user (Ayden, `lutes` on their PC) works on **Windows with PowerShell**
  and runs commands by copy-pasting them.
- **Always give shell commands as a single line** (join steps with `;`) —
  multi-line pastes trigger Windows Terminal's paste warning.
- Their local clone lives under `Desktop\AI Projects\Online-Pineapple-Poker`
  (Desktop may be OneDrive-redirected; resolve it with
  `[Environment]::GetFolderPath('Desktop')`, never hardcode).
- Commands they run locally are PowerShell; commands run in this remote
  session are bash. Don't mix the two syntaxes.

## Project

Reg-Poker Online — a PokerNow-style play-money poker web app. Node 22 +
Express + Socket.IO server, vanilla-JS ES-module frontend (no build step),
SQLite via built-in `node:sqlite`, installable PWA with Web Push.

- All development happens on branch `claude/pokernow-website-clone-w0si2o`.
- Deployed on Fly.io as app **`pineapple-poker-now`**
  (https://pineapple-poker-now.fly.dev), region `ord`, volume `pp_data`
  mounted at `/data`. Always deploy with `fly deploy --ha=false` — the app
  must run exactly ONE machine (tables live in process memory).
- A deploy restarts the server and voids any hand in progress — deploy
  between game nights.

## Commands

- `npm start` — run locally on http://localhost:3000
- `npm test` — all unit suites (plain node, no framework)
- `npm run soak` — bot multiplayer soak, all variants + home-game options
- `npm run smoke` — Playwright end-to-end (uses preinstalled Chromium at
  `/opt/pw-browsers` in the remote environment)

## Invariants that must hold

- Chip conservation: sum of stacks === buy-ins − cash-outs after every
  hand (the soak asserts it). All chip movement goes through `betting.pay`
  / the pot system — never adjust stacks directly mid-hand.
- Hole cards never leave `server/views.js` except to their owner.
- The service worker (`public/sw.js`) must never intercept `/socket.io/*`
  or `/api/*`, and updates must never force a reload mid-hand.
- Guests are first-class: every feature must work without an account.
