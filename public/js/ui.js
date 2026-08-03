// Tiny shared UI helpers (kept dependency-free to avoid module cycles).

let toastTimeout = null;

// Pass { ok: true } for something that worked — it shows green instead of the
// red used for problems, so "Settings saved" doesn't read like a failure.
export function showToast(text, { ok = false } = {}) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.toggle('ok', ok);
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2500);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
