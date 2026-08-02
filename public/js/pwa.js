// Installable-app plumbing, shared by every page: service worker
// registration, the install button, the iOS hint, the update toast, and
// push subscribe/unsubscribe helpers used by the table bell and /me.
//
// Everything here is best-effort: on browsers without these APIs the site
// simply behaves as it always has. Nothing throws.

const PUSH_KEY = 'pp:push';

let registrationRef = null;
let userAskedForReload = false;
let reloaded = false;

export function initPwa() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        registrationRef = registration;
        watchForUpdates(registration);
      })
      .catch(() => {});
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only ever reload because the player pressed the refresh button —
    // a deploy must never yank a table mid-hand.
    if (userAskedForReload && !reloaded) {
      reloaded = true;
      location.reload();
    }
  });
}

function watchForUpdates(registration) {
  if (registration.waiting && navigator.serviceWorker.controller) {
    showUpdateToast(registration);
  }
  registration.addEventListener('updatefound', () => {
    const incoming = registration.installing;
    if (!incoming) return;
    incoming.addEventListener('statechange', () => {
      if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateToast(registration);
      }
    });
  });
}

function showUpdateToast(registration) {
  if (document.getElementById('pwa-update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'pwa-update-toast';
  toast.innerHTML = `
    <span>A new version is ready.</span>
    <button id="pwa-refresh">Refresh</button>
    <button id="pwa-later">Later</button>`;
  Object.assign(toast.style, {
    position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
    background: '#1a1f2e', color: '#e8ebf4', border: '1px solid #2a3146',
    borderRadius: '12px', padding: '10px 14px', zIndex: 500, display: 'flex',
    gap: '10px', alignItems: 'center', fontSize: '14px',
    boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
  });
  document.body.appendChild(toast);
  for (const btn of toast.querySelectorAll('button')) {
    Object.assign(btn.style, {
      font: 'inherit', border: 'none', borderRadius: '8px', padding: '6px 12px',
      cursor: 'pointer', background: '#2a3146', color: '#e8ebf4',
    });
  }
  const refresh = toast.querySelector('#pwa-refresh');
  Object.assign(refresh.style, { background: '#f5c542', color: '#1a1405', fontWeight: '600' });
  refresh.addEventListener('click', () => {
    userAskedForReload = true;
    registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
    toast.remove();
  });
  toast.querySelector('#pwa-later').addEventListener('click', () => toast.remove());
}

// ---- install ----

let deferredInstall = null;

// buttonEl shows itself when installation is possible; on iOS Safari (no
// install prompt API) it shows the add-to-home-screen instructions instead.
export function wireInstallButton(buttonEl) {
  if (!buttonEl) return;

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return; // already installed — keep the button hidden

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstall = event; // Android/Chrome: a one-tap native install prompt
    buttonEl.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    buttonEl.classList.add('hidden');
  });

  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  const isAndroid = /android/i.test(ua);

  // Show the button on every non-installed device — even before Chrome fires
  // its prompt event — so Android and iOS users always have a way in. If the
  // native prompt isn't ready, we fall back to per-platform instructions.
  buttonEl.classList.remove('hidden');

  buttonEl.addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice.catch(() => {});
      deferredInstall = null;
      buttonEl.classList.add('hidden');
      return;
    }
    if (isIos) {
      alert(
        'Install on iPhone or iPad:\n\n' +
        '1. Tap the Share button in Safari\n' +
        '2. Choose "Add to Home Screen"\n\n' +
        'The table then opens fullscreen like any app, and turn alerts work on iOS 16.4+.'
      );
    } else if (isAndroid) {
      alert(
        'Install on Android:\n\n' +
        '1. Tap the ⋮ menu in Chrome (top-right)\n' +
        '2. Choose "Install app" (or "Add to Home screen")\n\n' +
        'It then opens fullscreen like any app, with turn notifications.'
      );
    } else {
      alert(
        'Install on your computer:\n\n' +
        'Click the install icon in your browser\'s address bar (Chrome/Edge), ' +
        'or open the browser menu and choose "Install Pineapple Poker".'
      );
    }
  });
}

// ---- push ----

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function savedPushEndpoint() {
  try {
    return localStorage.getItem(PUSH_KEY);
  } catch {
    return null;
  }
}

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// Strictly user-gesture driven: called from the bell / the /me toggle only.
export async function enablePush(authHeaders = {}) {
  if (!pushSupported()) return { ok: false, error: 'This browser does not support notifications' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, error: 'Notifications were not allowed' };

  try {
    const registration = await navigator.serviceWorker.ready;
    const { key } = await fetch('/api/push/vapid-key').then((r) => r.json());
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    const body = subscription.toJSON();
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ endpoint: body.endpoint, keys: body.keys }),
    });
    if (!res.ok) throw new Error('subscribe rejected');
    try {
      localStorage.setItem(PUSH_KEY, body.endpoint);
    } catch { /* private browsing */ }
    return { ok: true, endpoint: body.endpoint };
  } catch {
    return { ok: false, error: 'Could not turn on notifications' };
  }
}

export async function disablePush() {
  const subscription = await currentPushSubscription();
  const endpoint = subscription?.endpoint || savedPushEndpoint();
  try {
    await subscription?.unsubscribe();
  } catch { /* already gone */ }
  if (endpoint) {
    fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  }
  try {
    localStorage.removeItem(PUSH_KEY);
  } catch { /* private browsing */ }
  return { ok: true };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

initPwa();
