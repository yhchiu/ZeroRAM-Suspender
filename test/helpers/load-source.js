/**
 * Source-loading helpers. Each loader resets the module registry, installs a
 * fresh chrome mock on the global, and requires the source file so its
 * module-load side effects (listener registration, IIFEs) run against the mock.
 */
const path = require('path');
const { createChromeMock } = require('./chrome-mock');
const { loadHtmlBody } = require('./dom');

const ROOT = path.join(__dirname, '..', '..');

function installChrome(initialState) {
  jest.resetModules();
  const chrome = createChromeMock(initialState);
  global.chrome = chrome;
  global.self = global;
  return chrome;
}

function requireSource(file) {
  return require(path.join(ROOT, file));
}

/** Flush pending microtasks (and let queued timers settle if real timers). */
function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function loadBackground(initialState) {
  const chrome = installChrome(initialState);
  const bg = requireSource('background.js');
  return { chrome, bg };
}

function loadOptions(initialState) {
  const chrome = installChrome(initialState);
  loadHtmlBody('options.html');
  const options = requireSource('options.js');
  return { chrome, options };
}

function loadI18n(initialState) {
  const chrome = installChrome(initialState);
  const i18n = requireSource('i18n.js');
  return { chrome, i18n };
}

function loadSuspendedTheme(initialState) {
  const chrome = installChrome(initialState);
  const theme = requireSource('suspended-theme.js');
  return { chrome, theme };
}

function loadPopup(initialState) {
  const chrome = installChrome(initialState);
  loadHtmlBody('popup.html');
  requireSource('popup.js');
  return { chrome };
}

function loadSuspended(initialState) {
  const chrome = installChrome(initialState);
  loadHtmlBody('suspended.html');
  requireSource('suspended.js');
  return { chrome };
}

module.exports = {
  installChrome,
  requireSource,
  flushMicrotasks,
  loadBackground,
  loadOptions,
  loadI18n,
  loadSuspendedTheme,
  loadPopup,
  loadSuspended,
  ROOT,
};
