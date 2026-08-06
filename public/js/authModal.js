// The sign-in / sign-up modal, shared by the landing page and the profile
// page. Injects its own markup so any page can call openAuthModal().

import { signup, signin, isRemembered } from '/js/auth.js';

let installed = false;
let onDone = null;

const MARKUP = `
<div class="modal-backdrop hidden" id="auth-modal">
  <div class="modal">
    <h2 id="auth-title">Sign in</h2>
    <p class="auth-blurb">Playing as a guest works fine — an account just remembers your results,
      stats, friends list and table look between games.</p>
    <div class="field auth-name-field hidden">
      <label for="a-name">Display name</label>
      <input id="a-name" maxlength="20" autocomplete="nickname" placeholder="e.g. AceHigh">
    </div>
    <div class="field">
      <label for="a-email">Email</label>
      <input id="a-email" type="email" autocomplete="email" placeholder="you@example.com">
    </div>
    <div class="field">
      <label for="a-password">Password</label>
      <input id="a-password" type="password" autocomplete="current-password" placeholder="At least 8 characters">
    </div>
    <label class="check-label remember-row" for="a-remember">
      <input type="checkbox" id="a-remember" checked>
      <span>Keep me signed in on this device</span>
    </label>
    <p class="auth-error hidden" id="auth-error"></p>
    <div class="actions">
      <button class="btn btn-ghost" id="a-cancel">Cancel</button>
      <button class="btn btn-primary" id="a-submit">Sign in</button>
    </div>
    <p class="auth-switch">
      <span id="auth-switch-text">New here?</span>
      <button class="linkish" id="a-switch">Create an account</button>
    </p>
  </div>
</div>`;

let mode = 'signin';

function install() {
  if (installed) return;
  installed = true;
  document.body.insertAdjacentHTML('beforeend', MARKUP);

  document.getElementById('a-cancel').addEventListener('click', closeAuthModal);
  document.getElementById('auth-modal').addEventListener('click', (e) => {
    if (e.target.id === 'auth-modal') closeAuthModal();
  });
  document.getElementById('a-switch').addEventListener('click', () => {
    setMode(mode === 'signin' ? 'signup' : 'signin');
  });
  document.getElementById('a-submit').addEventListener('click', submit);
  for (const id of ['a-name', 'a-email', 'a-password']) {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }
}

function setMode(next) {
  mode = next;
  const isSignup = mode === 'signup';
  document.getElementById('auth-title').textContent = isSignup ? 'Create an account' : 'Sign in';
  document.getElementById('a-submit').textContent = isSignup ? 'Create account' : 'Sign in';
  document.querySelector('.auth-name-field').classList.toggle('hidden', !isSignup);
  document.getElementById('auth-switch-text').textContent = isSignup
    ? 'Already have an account?'
    : 'New here?';
  document.getElementById('a-switch').textContent = isSignup ? 'Sign in instead' : 'Create an account';
  document.getElementById('a-password').autocomplete = isSignup ? 'new-password' : 'current-password';
  showError('');
}

function showError(text) {
  const el = document.getElementById('auth-error');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

async function submit() {
  const email = document.getElementById('a-email').value.trim();
  const password = document.getElementById('a-password').value;
  const displayName = document.getElementById('a-name').value.trim();
  const remember = document.getElementById('a-remember').checked;
  const btn = document.getElementById('a-submit');

  if (!email || !password) {
    showError('Enter your email and password');
    return;
  }
  if (mode === 'signup' && !displayName) {
    showError('Pick a display name');
    return;
  }

  btn.disabled = true;
  const result = mode === 'signup'
    ? await signup({ email, password, displayName, remember })
    : await signin({ email, password, remember });
  btn.disabled = false;

  if (!result.ok) {
    showError(result.error);
    return;
  }
  closeAuthModal();
  if (onDone) onDone(result.account);
}

export function openAuthModal({ startMode = 'signin', onSuccess = null } = {}) {
  install();
  onDone = onSuccess;
  setMode(startMode);
  document.getElementById('a-password').value = '';
  // Default to what this device chose last time.
  document.getElementById('a-remember').checked = isRemembered();
  document.getElementById('auth-modal').classList.remove('hidden');
  document.getElementById(startMode === 'signup' ? 'a-name' : 'a-email').focus();
}

export function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('hidden');
}
