// Applies the player's chosen table look before anything is painted.
//
// Deliberately a plain blocking script in <head>, not a module: a deferred
// script runs after the document is parsed, which is late enough to show one
// frame of the wrong room. It only ever writes one attribute, so blocking here
// costs nothing measurable.
(function () {
  var SKINS = { velvet: 1, tour: 1, series: 1 };
  var skin = 'velvet';
  try {
    var saved = localStorage.getItem('pp:skin');
    if (saved && SKINS[saved]) skin = saved;
  } catch (e) {
    /* private browsing: the default is fine */
  }
  document.documentElement.dataset.skin = skin;
})();
