// P2P payment services a player can link to their profile so table-mates can
// pay them straight from the ledger. Some services expose a web/deep link that
// prefills the amount and a note (Venmo, Cash App, PayPal); others have no
// public payment URL (Zelle, Chime), so we show the handle to copy instead.
// Shared by the server (validation) and the browser (profile form + ledger).

export const PAYMENT_SERVICES = [
  { key: 'venmo', label: 'Venmo', icon: '🅥', prefix: '@', placeholder: 'your-venmo', hint: 'Your Venmo username' },
  { key: 'cashapp', label: 'Cash App', icon: '＄', prefix: '$', placeholder: 'cashtag', hint: 'Your $Cashtag' },
  { key: 'paypal', label: 'PayPal', icon: '🅿', prefix: '', placeholder: 'paypal.me name', hint: 'Your PayPal.Me name' },
  { key: 'zelle', label: 'Zelle', icon: 'ⓩ', prefix: '', placeholder: 'email or phone', hint: 'The email or phone your bank uses for Zelle' },
  { key: 'chime', label: 'Chime', icon: '🅒', prefix: '$', placeholder: 'ChimeSign', hint: 'Your $ChimeSign' },
];

const BY_KEY = new Map(PAYMENT_SERVICES.map((s) => [s.key, s]));

// Normalize a handle: drop a leading @/$, strip anything that isn't safe in a
// username/email/phone, and cap the length. Same rule on both sides so what a
// player types is exactly what table-mates see.
export function cleanHandle(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^[@$]/, '')
    .replace(/[^A-Za-z0-9@._+-]/g, '')
    .slice(0, 64);
}

// Validate + normalize a whole payments object down to known services with
// non-empty handles.
export function cleanPayments(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const svc of PAYMENT_SERVICES) {
      const h = cleanHandle(raw[svc.key]);
      if (h) out[svc.key] = h;
    }
  }
  return out;
}

// A payment link that prefills amount (+ note where supported). Returns null
// when the service has no public payment URL — the UI then shows the handle to
// copy. `amount` is a whole-number chip/dollar amount; `note` is free text.
export function paymentUrl(key, handle, { amount, note } = {}) {
  const h = encodeURIComponent(handle);
  const amt = amount != null && amount !== '' ? encodeURIComponent(String(amount)) : '';
  const n = encodeURIComponent(note || '');
  switch (key) {
    case 'venmo':
      return `https://venmo.com/?txn=pay&audience=private&recipients=${h}&amount=${amt}&note=${n}`;
    case 'cashapp':
      return `https://cash.app/$${h}${amt ? `/${amt}` : ''}`;
    case 'paypal':
      return `https://paypal.me/${h}${amt ? `/${amt}` : ''}`;
    default:
      return null; // zelle, chime — no public prefill link
  }
}

export function serviceLabel(key) {
  return BY_KEY.get(key)?.label || key;
}

export function serviceIcon(key) {
  return BY_KEY.get(key)?.icon || '💸';
}

// How the handle reads back to a human (with its @/$ prefix).
export function displayHandle(key, handle) {
  const svc = BY_KEY.get(key);
  return `${svc?.prefix || ''}${handle}`;
}
