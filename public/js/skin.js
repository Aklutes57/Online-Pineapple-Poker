// Applies the player's chosen table look before anything is painted.
//
// Deliberately a plain blocking script in <head>, not a module: a deferred
// script runs after the document is parsed, which is late enough to show one
// frame of the wrong room. It only ever writes one attribute, so blocking here
// costs nothing measurable.
//
// It keeps no list of skins on purpose. An unknown value simply matches no
// :root[data-skin=…] rule and falls through to the base palette, so adding a
// skin means editing shared/constants.js and base.css — never this file.
(function () {
  var skin = 'velvet';
  try {
    var saved = localStorage.getItem('pp:skin');
    if (saved && /^[a-z][a-z0-9-]{0,23}$/.test(saved)) skin = saved;
  } catch (e) {
    /* private browsing: the default is fine */
  }
  document.documentElement.dataset.skin = skin;
  // Keep the browser/PWA chrome in step with the room.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
})();
