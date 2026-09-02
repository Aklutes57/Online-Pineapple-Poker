// SQLite persistence using Node's built-in `node:sqlite` — no external deps.
// One file at data/pineapple.db (override with PP_DB_PATH; ':memory:' works
// for tests). Schema changes go in MIGRATIONS as new numbered entries; they
// run in order and are recorded in schema_version, so upgrading is automatic
// and re-running is a no-op.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let db = null;

const MIGRATIONS = [
  // 1 — accounts, sessions, and everything hanging off a profile
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    prefs_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_account ON sessions(account_id);

  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    label TEXT,
    auto_send INTEGER NOT NULL DEFAULT 1,
    unsubscribe_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(account_id, email)
  );

  CREATE TABLE notify_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    label TEXT,
    auto_send INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    target TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );

  CREATE TABLE themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    felt_image TEXT,
    felt_color TEXT,
    rail_color TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sound_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    trigger_key TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(account_id, trigger_key)
  );
  `,

  // 2 — table sessions, per-player results, saved hands, reactions, stats
  `
  CREATE TABLE table_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL UNIQUE,
    host_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    variant TEXT NOT NULL,
    small_blind INTEGER NOT NULL,
    big_blind INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    hands_played INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE session_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    player_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    buy_ins INTEGER NOT NULL DEFAULT 0,
    cash_outs INTEGER NOT NULL DEFAULT 0,
    final_stack INTEGER NOT NULL DEFAULT 0,
    net INTEGER NOT NULL DEFAULT 0,
    hands_played INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(table_session_id, player_id)
  );
  CREATE INDEX idx_results_account ON session_results(account_id);

  CREATE TABLE hands (
    id TEXT PRIMARY KEY,
    table_session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    hand_no INTEGER NOT NULL,
    variant TEXT NOT NULL,
    board_json TEXT NOT NULL,
    timeline_json TEXT NOT NULL,
    players_json TEXT NOT NULL,
    winners_json TEXT NOT NULL,
    pot INTEGER NOT NULL,
    cooler_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_hands_session ON hands(table_session_id);

  CREATE TABLE hand_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id TEXT NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    nickname TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_reactions_hand ON hand_reactions(hand_id);

  CREATE TABLE player_stats (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    hands_dealt INTEGER NOT NULL DEFAULT 0,
    vpip_hands INTEGER NOT NULL DEFAULT 0,
    pfr_hands INTEGER NOT NULL DEFAULT 0,
    three_bet_hands INTEGER NOT NULL DEFAULT 0,
    three_bet_ops INTEGER NOT NULL DEFAULT 0,
    saw_flop_hands INTEGER NOT NULL DEFAULT 0,
    wtsd_hands INTEGER NOT NULL DEFAULT 0,
    wsd_hands INTEGER NOT NULL DEFAULT 0,
    aggressive_actions INTEGER NOT NULL DEFAULT 0,
    passive_actions INTEGER NOT NULL DEFAULT 0,
    hands_won INTEGER NOT NULL DEFAULT 0,
    biggest_pot INTEGER NOT NULL DEFAULT 0,
    best_hand_score INTEGER NOT NULL DEFAULT 0,
    best_hand_desc TEXT,
    net_chips INTEGER NOT NULL DEFAULT 0,
    sessions_played INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  `,

  // 3 — content-addressed uploads backing table themes and the soundboard
  `
  CREATE TABLE uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    original_name TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_uploads_account ON uploads(account_id, kind);
  `,

  // 4 — web push subscriptions + persisted server config (VAPID keys)
  `
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys_json TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX idx_push_subs_account ON push_subscriptions(account_id);

  CREATE TABLE server_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  // 5 — provably-fair RNG. The server seed is stored the moment the table
  // session exists but is only ever surfaced through the API once the session
  // has ended (ended_at set), so a mucked hand can't be reconstructed mid-game.
  // The public commit is safe to expose immediately; each hand keeps its own
  // client seed, nonce, proof and float.
  `
  ALTER TABLE table_sessions ADD COLUMN fairness_server_seed TEXT;
  ALTER TABLE table_sessions ADD COLUMN fairness_server_commit TEXT;
  ALTER TABLE hands ADD COLUMN fairness_json TEXT;
  `,

  // 6 — the name a player settles up under, kept apart from the username they
  // played under. Nullable: it is optional, and every ledger built before this
  // simply falls back to the nickname, exactly as it did.
  `
  ALTER TABLE session_results ADD COLUMN real_name TEXT;
  `,

  // 7 — money actually handed over, against the running tab. The tab itself is
  // derived (sum of session nets), so settling has to be recorded separately or
  // paying somebody would silently un-record itself the next time they played.
  //
  // Amounts are positive and directional: `from` paid `to`. Part payments are
  // ordinary rows, so "paid me 50 of the 250" is two rows and not a special
  // case. Deleting a row undoes it, which is how a mistake gets fixed.
  `
  CREATE TABLE settle_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    to_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    note TEXT,
    recorded_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_settle_host ON settle_payments(host_account_id);
  `,
];

export function initDb(dbPath = process.env.PP_DB_PATH || path.join(root, 'data', 'pineapple.db')) {
  if (db) return db;
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate();
  return db;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let current = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${i + 1} failed: ${err.message}`);
    }
  }
}

export function getDb() {
  if (!db) initDb();
  return db;
}

// Small helpers so callers don't repeat prepare/run everywhere.
export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

export function get(sql, ...params) {
  const row = getDb().prepare(sql).get(...params);
  return row === undefined ? null : plain(row);
}

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params).map(plain);
}

// node:sqlite returns null-prototype objects; normalize for easy spreading.
function plain(row) {
  return row ? { ...row } : row;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export function now() {
  return Date.now();
}
