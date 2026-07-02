// theme-boot.js - applies the saved theme to the popup and options pages
// before first paint (loaded in <head>, so it blocks rendering briefly).
//
// Fully IIFE-scoped on purpose: options.js declares its own top-level
// VALID_THEME_MODES / CACHE_THEME_KEY consts, so this file must not leak
// any declarations into the global scope (suspended-theme.js does, which
// is why it cannot be reused here).
(function () {
  var VALID = ['auto', 'light', 'dark'];
  var CACHE_KEY = 'utsCacheThemeMode';
  var STORAGE_KEY = 'utsSettings';

  function apply(mode) {
    if (VALID.indexOf(mode) === -1) {
      mode = 'auto';
    }
    var resolved = mode === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  // The localStorage cache is shared with the suspended page (same origin)
  // and lets us resolve the theme synchronously, avoiding a flash of the
  // wrong theme while chrome.storage loads.
  var cached = null;
  try {
    cached = localStorage.getItem(CACHE_KEY);
  } catch (e) {
    // localStorage unavailable - fall through to chrome.storage below
  }
  apply(cached);

  if (VALID.indexOf(cached) === -1 && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(STORAGE_KEY, function (data) {
      var cfg = (data && data[STORAGE_KEY]) || {};
      var mode = VALID.indexOf(cfg.themeMode) === -1 ? 'auto' : cfg.themeMode;
      apply(mode);
      try {
        localStorage.setItem(CACHE_KEY, mode);
      } catch (e) {
        // Non-fatal: next load resolves via chrome.storage again
      }
    });
  }
})();
