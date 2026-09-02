// P2P payment services a player can link to their profile so table-mates can
// pay them straight from the ledger.
//
// The field asks for the SHARE LINK the app itself gives you — the thing you
// get from Venmo's share sheet or Cash App's profile — rather than a username
// somebody has to retype. A bare handle is still accepted, because people will
// type one, and it is turned into the same canonical link.
//
// Two services have no such link, and the UI says so rather than pretending:
// Zelle lives inside your bank's app and has no public per-person page, and
// Chime's $ChimeSign is searched inside the Chime app. Those stay handles.
//
// SECURITY. A stored value here is rendered as a clickable link for OTHER
// players — people who are about to send real money — so a pasted URL is
// hostile input. Three rules do the work:
//   1. https only, no userinfo, no port, and the host must EXACTLY equal one
//      of a small allowlist. Never endsWith/includes: `venmo.com.evil.com`
//      and `evil-venmo.com` both pass a naive suffix check, and a punycode
//      homoglyph host passes anything but exact matching.
//   2. The path must match the service's known shape and the handle inside it
//      must match that service's character rules.
//   3. We never store what was pasted. The link is REBUILT from the host and
//      the validated handle, which drops query strings, fragments, control
//      characters, bidi overrides and anything else riding along.
//
// Shared by the server (validation, which is the boundary that counts) and the
// browser (the profile form and the ledger's pay buttons).

export const PAYMENT_SERVICES = [
  {
    key: 'venmo', label: 'Venmo', icon: '🅥', prefix: '@', kind: 'link',
    placeholder: 'https://account.venmo.com/u/your-name',
    hint: 'In Venmo: your profile → the share icon → Copy link. A bare username works too.',
  },
  {
    key: 'cashapp', label: 'Cash App', icon: '＄', prefix: '$', kind: 'link',
    placeholder: 'https://cash.app/$YourCashtag',
    hint: 'In Cash App: your profile → Share. Your $Cashtag on its own works too.',
  },
  {
    key: 'paypal', label: 'PayPal', icon: '🅿', prefix: '', kind: 'link',
    placeholder: 'https://paypal.me/YourName',
    hint: 'Your PayPal.Me link, from Account settings → Profile. The name alone works too.',
  },
  {
    key: 'zelle', label: 'Zelle', icon: 'ⓩ', prefix: '', kind: 'handle',
    placeholder: 'email or US mobile number',
    hint: 'Zelle has no share link — it runs inside your bank\'s app. Give the email or US mobile you enrolled.',
  },
  {
    key: 'chime', label: 'Chime', icon: '🅒', prefix: '$', kind: 'handle',
    placeholder: 'ChimeSign',
    hint: 'Chime has no share link — your $ChimeSign is searched inside the Chime app.',
  },
];

const BY_KEY = new Map(PAYMENT_SERVICES.map((s) => [s.key, s]));

// Long enough for any real share link, short enough that nothing pathological
// reaches the parser.
const MAX_INPUT = 300;

// Whitespace, control characters, bidi overrides and zero-width characters.
// A real link contains none of these; an attack dressing one host up as
// another contains several. Checked by code point rather than by a character
// class, so the characters being rejected are not invisible in this file.
function hasNastyChars(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c <= 0x20) return true;                      // space, tab, newline, C0 controls
    if (c >= 0x7f && c <= 0x9f) return true;         // DEL and the C1 controls
    if (c === 0xa0 || c === 0x3000) return true;     // non-breaking and ideographic spaces
    if (c >= 0x200b && c <= 0x200f) return true;     // zero-width, LRM/RLM
    if (c >= 0x2028 && c <= 0x202e) return true;     // line/paragraph separators, bidi overrides
    if (c >= 0x2066 && c <= 0x2069) return true;     // bidi isolates
    if (c === 0xfeff) return true;                   // byte-order mark
  }
  return false;
}

// Venmo serves real pages off its first path segment, so a bare
// venmo.com/<something> is only a username if it is not one of these. The list
// is load-bearing: venmo.com/business/profiles is a real Venmo route.
const VENMO_RESERVED = new Set([
  'code', 'u', 'login', 'signin', 'signup', 'account', 'business', 'charity',
  'about', 'help', 'settings', 'pay', 'refer', 'invite', 'legal', 'privacy',
  'terms', 'static', 'assets', 'feed', 'story', 'support', 'blog',
]);

// The sigil in front of a Cashtag is part of the path and is localised: the
// UK help pages call it a £Cashtag. A $-only check silently rejects a valid
// non-US player's link.
const CASHTAG_SIGILS = ['$', '£', '€'];

const LINK_RULES = {
  venmo: {
    hosts: new Set(['venmo.com', 'www.venmo.com', 'account.venmo.com']),
    handle: /^[A-Za-z0-9_-]{5,30}$/,
    // account.venmo.com is the profile app's own origin, and the form Venmo's
    // share sheet is most often seen producing.
    build: (handle) => `https://account.venmo.com/u/${handle}`,
    parse(url, segments) {
      if (segments[0] === 'u' && segments.length === 2) return { handle: segments[1] };
      // The personal QR / "copy link" payload. It carries an opaque numeric id
      // and no username, so it is kept as a link and never turned into one.
      if (segments[0] === 'code' && segments.length === 1) {
        const id = url.searchParams.get('user_id');
        if (!/^[0-9]{1,25}$/.test(id || '')) return null;
        const created = url.searchParams.get('created');
        const extra = /^[0-9]{1,15}$/.test(created || '') ? `&created=${created}` : '';
        return { opaque: `https://venmo.com/code?user_id=${id}${extra}` };
      }
      if (segments.length === 1 && !VENMO_RESERVED.has(segments[0].toLowerCase())) {
        return { handle: segments[0] };
      }
      return null;
    },
  },
  cashapp: {
    // Deliberately NOT cash.me. Nobody could show it still resolves to Block,
    // and a lapsed domain in an allowlist is a phishing target our own UI
    // would point at.
    hosts: new Set(['cash.app']),
    // At least one letter, and Cash App's documented 20-character ceiling.
    handle: /^(?=.*[A-Za-z])[A-Za-z0-9_-]{1,20}$/,
    build: (handle) => `https://cash.app/$${handle}`,
    parse(url, segments) {
      if (segments.length !== 1) return null;
      const sigil = CASHTAG_SIGILS.find((s) => segments[0].startsWith(s));
      // The sigil is what keeps /help, /press, /legal, /learn and /tags out —
      // a reserved-word list would always lag behind Cash App's own routes.
      if (!sigil) return null;
      return { handle: segments[0].slice(sigil.length) };
    },
  },
  paypal: {
    hosts: new Set(['paypal.me', 'www.paypal.me', 'paypal.com', 'www.paypal.com']),
    // PayPal.Me names are alphanumeric only, 20 characters at most.
    handle: /^[A-Za-z0-9]{1,20}$/,
    build: (handle) => `https://paypal.me/${handle}`,
    parse(url, segments) {
      const onMe = url.hostname.toLowerCase().endsWith('paypal.me');
      const rest = onMe ? segments : (segments[0] === 'paypalme' ? segments.slice(1) : null);
      if (!rest || !rest.length) return null;
      // A pasted link may already carry an amount (paypal.me/Name/25). Keep
      // the person, drop their amount — the ledger sets its own.
      return { handle: rest[0] };
    },
  },
};

// The rules for services that have no link at all. Kept as handles, shown as
// text to copy.
const HANDLE_RULES = {
  // An email or a US mobile number, exactly as enrolled with their bank. Held
  // loosely on purpose: a player may have enrolled any of several, and only
  // they know which one works.
  zelle: { pattern: /^[A-Za-z0-9@._+-]{3,64}$/, error: 'Give the email or US mobile number you enrolled with Zelle' },
  // Starts with a letter, 3-30 characters, letters/numbers/dashes.
  chime: { pattern: /^[A-Za-z][A-Za-z0-9-]{2,29}$/, error: 'A $ChimeSign starts with a letter and is 3-30 letters, numbers or dashes' },
};

// Normalize a handle: drop a leading @/$, strip anything that isn't safe in a
// username/email/phone, and cap the length.
export function cleanHandle(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^[@$£€]/, '')
    .replace(/[^A-Za-z0-9@._+-]/g, '')
    .slice(0, 64);
}

// One service's field. Returns what to store, the handle inside it where there
// is one, and a message to show when it could not be read.
//
// `value` is always something this module built, never the string that was
// pasted. That is the property the rest of the app depends on.
export function parsePayment(key, raw) {
  const svc = BY_KEY.get(key);
  if (!svc) return { ok: false, error: 'Unknown payment service' };
  if (typeof raw !== 'string') return { ok: true, value: '', handle: '' };

  const input = raw.trim();
  if (!input) return { ok: true, value: '', handle: '' };
  if (input.length > MAX_INPUT) return { ok: false, error: `That ${svc.label} link is too long` };
  if (hasNastyChars(input)) return { ok: false, error: `That ${svc.label} link has characters that don't belong in a link` };

  // Anything with a scheme, or that looks like a bare host, is read as a link.
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith('//') || input.includes('/');

  const rule = LINK_RULES[key];
  if (!rule) {
    // Zelle and Chime: a handle is all there is. A pasted URL has to be
    // refused out loud — cleanHandle would strip the punctuation out of it and
    // store convincing-looking nonsense.
    if (looksLikeUrl) {
      return { ok: false, error: `${svc.label} has no share link. ${svc.hint}` };
    }
    const handle = cleanHandle(input);
    const check = HANDLE_RULES[key];
    if (!handle || (check && !check.pattern.test(handle))) {
      return { ok: false, error: check?.error || `That ${svc.label} handle doesn't look right` };
    }
    return { ok: true, value: handle, handle };
  }
  if (!looksLikeUrl) {
    const handle = cleanHandle(input);
    if (!rule.handle.test(handle)) return { ok: false, error: handleError(svc) };
    return { ok: true, value: rule.build(handle), handle };
  }

  const parsed = parseLink(rule, input);
  if (!parsed) return { ok: false, error: linkError(svc, rule) };
  if (parsed.opaque) return { ok: true, value: parsed.opaque, handle: '' };
  if (!rule.handle.test(parsed.handle)) return { ok: false, error: handleError(svc) };
  return { ok: true, value: rule.build(parsed.handle), handle: parsed.handle };
}

function parseLink(rule, input) {
  // A pasted "venmo.com/u/me" has no scheme. Adding https is safe: the host
  // still has to survive the allowlist, and "//evil.com" becomes an https URL
  // for evil.com, which is refused there.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input.replace(/^\/+/, '')}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // https only: kills javascript:, data:, blob:, file:, vbscript: and plain
  // http in one condition rather than by blocklisting schemes one at a time.
  if (url.protocol !== 'https:') return null;
  // https://venmo.com@evil.com/u/x — the host is evil.com, and the eye reads
  // venmo.com. Refuse any authority carrying credentials at all.
  if (url.username || url.password) return null;
  if (url.port) return null;
  if (!rule.hosts.has(url.hostname.toLowerCase())) return null;

  let segments;
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // a malformed percent-escape
  }
  if (!segments.length || segments.some((s) => !s || hasNastyChars(s))) return null;
  return rule.parse(url, segments);
}

function handleError(svc) {
  return `That doesn't look like a ${svc.label} ${svc.key === 'paypal' ? 'name' : 'username'}`;
}

function linkError(svc, rule) {
  return `Paste the share link ${svc.label} gives you — it should start with https://${[...rule.hosts][0]}/`;
}

// Validate a whole payments object down to known services. Returns the map to
// store plus, per service, why anything was dropped — a link that silently
// disappears is worse than one that says what was wrong with it.
export function cleanPayments(raw) {
  const payments = {};
  const errors = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const svc of PAYMENT_SERVICES) {
      const result = parsePayment(svc.key, raw[svc.key]);
      if (result.ok) {
        if (result.value) payments[svc.key] = result.value;
      } else {
        errors[svc.key] = result.error;
      }
    }
  }
  return { payments, errors };
}

// The link a table-mate actually opens, and whether it carries the amount.
//
// It is deliberately the player's own share link rather than a constructed
// deep link. Venmo has not allowed a payment to be started from the web since
// 2018 and documents no person-to-person link parameters at all, so an
// amount bolted onto one is a guess — and a guess that silently drops the
// amount is how somebody pays the wrong number and the ledger desynchronises.
// PayPal is the exception: PayPal's own help centre documents the amount as a
// path segment, so that one is added.
//
// Either way the caller must show the amount as text beside the button.
export function paymentLink(key, value, { amount } = {}) {
  const stored = typeof value === 'string' ? value.trim() : '';
  if (!stored) return null;
  const rule = LINK_RULES[key];
  if (!rule) return null; // zelle, chime — no public link exists

  // A value saved before this field took links is still a bare handle.
  const href = stored.startsWith('https://')
    ? stored
    : (rule.handle.test(cleanHandle(stored)) ? rule.build(cleanHandle(stored)) : null);
  if (!href) return null;

  if (key === 'paypal' && Number.isFinite(Number(amount)) && Number(amount) > 0) {
    return { href: `${href}/${Math.round(Number(amount))}`, prefilled: true };
  }
  return { href, prefilled: false };
}

// The handle inside a stored value, where there is one. Venmo's QR link
// carries an opaque id and no username, so this is empty for those.
export function handleOf(key, value) {
  const stored = typeof value === 'string' ? value.trim() : '';
  if (!stored) return '';
  const rule = LINK_RULES[key];
  if (!rule) return stored;
  if (!stored.startsWith('https://')) return cleanHandle(stored);
  const parsed = parseLink(rule, stored);
  return parsed && parsed.handle ? parsed.handle : '';
}

export function serviceLabel(key) {
  return BY_KEY.get(key)?.label || key;
}

export function serviceIcon(key) {
  return BY_KEY.get(key)?.icon || '💸';
}

// How a stored value reads back to a human: their handle with its @/$ where we
// know it, and the service's name where the link keeps it to itself.
export function displayHandle(key, value) {
  const svc = BY_KEY.get(key);
  const handle = handleOf(key, value);
  if (!handle) return `${svc?.label || key} link`;
  return `${svc?.prefix || ''}${handle}`;
}
