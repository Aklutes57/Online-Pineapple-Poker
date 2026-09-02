// Turning a pasted invite into a table code.
//
// This exists because an installed app on iOS never captures a link: tapping a
// table link in a message opens Safari and leaves the app behind, every time.
// So the app has to be able to take the link itself, and people paste whatever
// they were sent — a full URL, a URL without the scheme, or just the code off
// the end of one.
//
// The security property is structural rather than checked: only the CODE is
// ever taken out of what was pasted, never the host. A link pointing at
// somebody else's server yields its code and nothing else, so the app can only
// ever navigate to its own /games/<code>.

// The ids gameManager generates are alphanumeric and ten characters; the range
// here is deliberately wider so an older or hand-typed code still resolves.
const CODE_RE = /^[A-Za-z0-9]{6,32}$/;

export function tableCodeFrom(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (CODE_RE.test(text)) return text;

  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const m = url.pathname.match(/\/games\/([A-Za-z0-9]{6,32})\/?$/);
  return m ? m[1] : null;
}
