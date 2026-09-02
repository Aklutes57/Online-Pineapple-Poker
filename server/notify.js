// Outbound notifications for table invites.
//
// Channels are pluggable: each one is { validate, send } keyed by name, so
// adding a Discord bot later means adding a registry entry and a new channel
// value — no schema change and no caller changes.
//
// Everything is queued through the outbox table, which doubles as the
// delivery log and as the fallback sink when SMTP is not configured, so the
// feature works with zero setup and the UI can show what would have gone out.

import nodemailer from 'nodemailer';
import { run, get, all, now } from './db.js';
import { ledgerCsvForGame } from './stats.js';
import { randomUUID } from 'node:crypto';

const MAX_ATTEMPTS = 3;

// ---- channels ----

const discordWebhook = {
  name: 'discord_webhook',
  // Strict allowlist: without it, a "webhook URL" field is an SSRF hole that
  // makes the server POST wherever a user points it.
  validate(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, error: 'That is not a valid URL' };
    }
    if (url.protocol !== 'https:') return { ok: false, error: 'Webhook URLs must be https' };
    const host = url.hostname.toLowerCase();
    const allowed = host === 'discord.com' || host === 'discordapp.com' || host === 'ptb.discord.com'
      || host === 'canary.discord.com';
    if (!allowed) return { ok: false, error: 'That is not a Discord webhook URL' };
    if (!url.pathname.startsWith('/api/webhooks/')) {
      return { ok: false, error: 'That is not a Discord webhook URL' };
    }
    return { ok: true, value: url.toString() };
  },
  async send(target, payload) {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Reg-Poker Online',
        embeds: [
          {
            title: payload.subject,
            description: payload.body,
            url: payload.link,
            color: 0xf5c542,
            footer: { text: 'Play money only — no real currency involved.' },
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Discord responded ${res.status}`);
  },
};

let mailTransport = null;
function transport() {
  if (mailTransport !== null) return mailTransport;
  const url = process.env.SMTP_URL;
  mailTransport = url ? nodemailer.createTransport(url) : false;
  return mailTransport;
}

export function emailConfigured() {
  return !!transport();
}

const email = {
  name: 'email',
  validate(value) {
    const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(clean) || clean.length > 254) {
      return { ok: false, error: 'Enter a valid email address' };
    }
    return { ok: true, value: clean };
  },
  async send(target, payload) {
    const tx = transport();
    // No SMTP configured: the outbox row IS the delivery, and the UI says so.
    if (!tx) throw new NotConfiguredError();
    await tx.sendMail({
      from: process.env.SMTP_FROM || 'Reg-Poker Online <no-reply@reg-poker.online>',
      to: target,
      subject: payload.subject,
      text: [payload.body, payload.link, payload.footer].filter(Boolean).join('\n\n'),
      html: renderEmailHtml(payload),
      ...(payload.attachment
        ? {
          attachments: [{
            filename: payload.attachment.filename,
            content: payload.attachment.content,
            contentType: payload.attachment.contentType || 'text/csv; charset=utf-8',
          }],
        }
        : {}),
    });
  },
};

class NotConfiguredError extends Error {
  constructor() {
    super('email is not configured on this server');
    this.notConfigured = true;
  }
}

const CHANNELS = { email, discord_webhook: discordWebhook };

export function getChannel(name) {
  return CHANNELS[name] || null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderEmailHtml(payload) {
  // A ledger mail has a different call to action from an invite, and a mail
  // with nothing to click should not grow a button pointing nowhere.
  const button = payload.link
    ? `<a href="${escapeHtml(payload.link)}"
         style="display:inline-block;background:#f5c542;color:#1a1405;font-weight:700;
                padding:12px 24px;border-radius:10px;text-decoration:none">${
  escapeHtml(payload.cta || 'Take a seat')}</a>`
    : '';
  return `
    <div style="font-family:system-ui,sans-serif;background:#10131c;color:#e8ebf4;padding:28px;border-radius:12px">
      <h2 style="margin:0 0 12px">${escapeHtml(payload.subject)}</h2>
      <p style="color:#9aa3ba;margin:0 0 20px;white-space:pre-line">${escapeHtml(payload.body)}</p>
      ${button}
      <p style="color:#6b7280;font-size:12px;margin-top:24px">
        ${escapeHtml(payload.footer || 'Play money only — no real currency involved.')}
      </p>
    </div>`;
}

// ---- contacts and targets ----

export function addContact(accountId, rawEmail, label) {
  const check = email.validate(rawEmail);
  if (!check.ok) return { ok: false, error: check.error };
  if (get('SELECT id FROM contacts WHERE account_id = ? AND email = ?', accountId, check.value)) {
    return { ok: false, error: 'That address is already on your list' };
  }
  run(
    `INSERT INTO contacts (account_id, email, label, auto_send, unsubscribe_token, created_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
    accountId, check.value,
    typeof label === 'string' ? label.trim().slice(0, 40) || null : null,
    randomUUID(), now()
  );
  return { ok: true, contacts: listContacts(accountId) };
}

export function listContacts(accountId) {
  return all(
    'SELECT id, email, label, auto_send FROM contacts WHERE account_id = ? ORDER BY created_at',
    accountId
  ).map((c) => ({ id: c.id, email: c.email, label: c.label, autoSend: !!c.auto_send }));
}

export function setContactAutoSend(accountId, contactId, autoSend) {
  run('UPDATE contacts SET auto_send = ? WHERE id = ? AND account_id = ?',
    autoSend ? 1 : 0, contactId, accountId);
  return { ok: true, contacts: listContacts(accountId) };
}

export function removeContact(accountId, contactId) {
  run('DELETE FROM contacts WHERE id = ? AND account_id = ?', contactId, accountId);
  return { ok: true, contacts: listContacts(accountId) };
}

export function unsubscribeByToken(token) {
  const row = get('SELECT id FROM contacts WHERE unsubscribe_token = ?', token);
  if (!row) return { ok: false };
  run('UPDATE contacts SET auto_send = 0 WHERE id = ?', row.id);
  return { ok: true };
}

export function addNotifyTarget(accountId, kind, value, label) {
  const channel = getChannel(kind);
  if (!channel) return { ok: false, error: 'Unknown notification type' };
  const check = channel.validate(value);
  if (!check.ok) return { ok: false, error: check.error };
  run(
    `INSERT INTO notify_targets (account_id, kind, value, label, auto_send, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    accountId, kind, check.value,
    typeof label === 'string' ? label.trim().slice(0, 40) || null : null,
    now()
  );
  return { ok: true, targets: listNotifyTargets(accountId) };
}

export function listNotifyTargets(accountId) {
  return all(
    'SELECT id, kind, value, label, auto_send FROM notify_targets WHERE account_id = ? ORDER BY created_at',
    accountId
  ).map((t) => ({
    id: t.id,
    kind: t.kind,
    // Never echo a full webhook URL back to the browser — it is a bearer
    // credential for posting into someone's Discord server.
    value: t.kind === 'discord_webhook' ? maskWebhook(t.value) : t.value,
    label: t.label,
    autoSend: !!t.auto_send,
  }));
}

function maskWebhook(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const id = parts[2] || '';
    return `${parsed.hostname}/…/${id.slice(0, 6)}…`;
  } catch {
    return 'webhook';
  }
}

export function removeNotifyTarget(accountId, targetId) {
  run('DELETE FROM notify_targets WHERE id = ? AND account_id = ?', targetId, accountId);
  return { ok: true, targets: listNotifyTargets(accountId) };
}

// ---- sending ----

// `attachment` is { filename, content } and is stored with the row rather than
// regenerated at send time, so the outbox row IS the delivery — a retry sends
// byte-for-byte what the first attempt would have, and the log shows what went
// out even when SMTP is not configured. A ledger .csv is a couple of KB.
export function enqueue({ channel, target, subject, body, link, footer, cta, attachment }) {
  const result = run(
    `INSERT INTO outbox (channel, target, subject, body, status, attempts, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    channel, target, subject, JSON.stringify({ body, link, footer, cta, attachment }), now()
  );
  return Number(result.lastInsertRowid);
}

export async function deliver(id) {
  const row = get('SELECT * FROM outbox WHERE id = ?', id);
  if (!row || row.status === 'sent') return;
  const channel = getChannel(row.channel);
  if (!channel) {
    run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", 'unknown channel', id);
    return;
  }
  let payload;
  try {
    payload = { subject: row.subject, ...JSON.parse(row.body) };
  } catch {
    payload = { subject: row.subject, body: row.body, link: '' };
  }

  try {
    await channel.send(row.target, payload);
    run("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?", now(), id);
  } catch (err) {
    const attempts = row.attempts + 1;
    // "Not configured" is a settled outcome, not a failure to retry: the
    // outbox row is the record of what would have been sent.
    const status = err.notConfigured
      ? 'logged'
      : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    run('UPDATE outbox SET status = ?, error = ?, attempts = ? WHERE id = ?',
      status, String(err.message).slice(0, 300), attempts, id);
    if (err.notConfigured) {
      console.log(`[outbox] ${row.channel} -> ${row.target}: ${row.subject} ${payload.link || ''}`);
    }
  }
}

// Fires every auto-send contact and target for a host. Never throws — an
// invite failing must not affect the table that was just created.
export async function announceTable(accountId, { gameId, variantLabel, blinds, link, hostName }) {
  if (!accountId) return { sent: 0 };
  const subject = `${hostName} started a poker table`;
  const body = `${variantLabel} · blinds ${blinds}. Click through to take a seat.`;
  const jobs = [];

  try {
    for (const contact of listContacts(accountId)) {
      if (!contact.autoSend) continue;
      jobs.push(enqueue({ channel: 'email', target: contact.email, subject, body, link,
        footer: 'You are on a Reg-Poker Online invite list. Reply to be removed.' }));
    }
    for (const target of all(
      'SELECT * FROM notify_targets WHERE account_id = ? AND auto_send = 1', accountId
    )) {
      jobs.push(enqueue({ channel: target.kind, target: target.value, subject, body, link }));
    }
  } catch (err) {
    console.error('queuing invites failed:', err.message);
    return { sent: 0 };
  }

  // Deliver in the background: creating a table must not wait on the network.
  Promise.allSettled(jobs.map((id) => deliver(id))).catch(() => {});
  return { sent: jobs.length };
}

// ---- the ledger, emailed to the host when the game ends ----

// Written out rather than taken from a locale, so the subject line reads the
// same on the server, in a test, and on whatever machine this ends up on.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// The date the game is named by. UTC, matching the .csv filename and the dates
// already shown on the profile page, so one game is one date everywhere.
//
// The wart: a table is stamped with when it STARTED, and a game that starts at
// 8pm in North America has already ticked over into the next UTC day, so an
// evening game can be named by the following morning's date. Fixing that needs
// the host's timezone stored with the session; until then everything at least
// agrees with everything else. This is the one place that decides, so there is
// one line to change.
export function ledgerDateLabel(startedAt) {
  const d = new Date(startedAt);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// The host's own record of their own game, sent when the table closes.
//
// Never throws and never blocks: a table closing must not wait on a mail
// server, and a mail server being down must not stop a table closing.
export async function mailLedgerToHost({ gameId, hostAccountId, origin }) {
  if (!hostAccountId) return { sent: 0, reason: 'no signed-in host' };

  let csv;
  try {
    csv = ledgerCsvForGame(gameId);
  } catch (err) {
    console.error(`building the ledger for ${gameId} failed:`, err.message);
    return { sent: 0, reason: 'ledger failed' };
  }
  // A table nobody played at has no ledger, and an empty attachment is worse
  // than no mail at all.
  if (!csv) return { sent: 0, reason: 'no ledger' };

  const account = get('SELECT email, display_name FROM accounts WHERE id = ?', hostAccountId);
  if (!account?.email) return { sent: 0, reason: 'host has no email' };

  const when = ledgerDateLabel(csv.startedAt);
  const subject = `Your poker ledger — ${when}`;
  const body = [
    `${csv.variant} · blinds ${csv.blinds}`,
    `${csv.players} player${csv.players === 1 ? '' : 's'} · `
      + `${csv.hands} hand${csv.hands === 1 ? '' : 's'}`,
    'The full ledger and the settle-up are attached as a .csv.',
  ].join('\n');

  const id = enqueue({
    channel: 'email',
    target: account.email,
    subject,
    body,
    // The saved copy on the server, so the mail is still useful from a phone
    // that will not open an attachment.
    link: origin ? `${origin}/api/games/${encodeURIComponent(gameId)}/ledger.csv` : '',
    cta: 'Open the ledger',
    footer: 'You are getting this because you hosted this table. Play money only.',
    attachment: { filename: csv.filename, content: csv.body },
  });

  // Deliberately not awaited by the caller: see above.
  await deliver(id).catch(() => {});
  return { sent: 1, outboxId: id, subject };
}

export function recentDeliveries(limit = 20) {
  return all(
    'SELECT id, channel, target, subject, status, error, created_at FROM outbox ORDER BY id DESC LIMIT ?',
    limit
  ).map((r) => ({
    id: r.id,
    channel: r.channel,
    target: r.channel === 'discord_webhook' ? maskWebhook(r.target) : r.target,
    subject: r.subject,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
  }));
}
