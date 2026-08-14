/**
 * Shared fixtures and reporting helpers for the benchmarks.
 *
 * The scenarios below build a browser the size of the one we care about — ten
 * thousand tabs spread over twenty windows — and run the real source against
 * the test suite's chrome mock. Nothing here models IPC, so read the call
 * counts as the finding and the milliseconds as a floor.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { installChrome, requireSource } = require(path.join(ROOT, 'test', 'helpers', 'load-source.js'));

const TAB_COUNT = 10000;
const WINDOW_COUNT = 20;

/**
 * Build `TAB_COUNT` tabs across `WINDOW_COUNT` windows, one active per window.
 * `suspendedEvery` turns every n-th tab into one of our suspended placeholders
 * (1 = all of them), which is what exercises the suspended-URL parsing.
 * Each tab carries `_original`, the URL a pause would be keyed by.
 */
function makeTabs({ suspendedEvery = 0 } = {}) {
  const tabs = [];
  for (let i = 0; i < TAB_COUNT; i++) {
    const original = `https://site${i % 500}.example/path/page-${i}?q=${i}`;
    const suspended =
      'chrome-extension://testextensionid/suspended.html' +
      `?uri=${encodeURIComponent(original)}&ttl=${encodeURIComponent('Tab title ' + i)}`;
    tabs.push({
      id: i + 1,
      url: suspendedEvery && i % suspendedEvery === 0 ? suspended : original,
      title: `Tab title ${i}`,
      windowId: (i % WINDOW_COUNT) + 1,
      active: i < WINDOW_COUNT,
      discarded: false,
      pinned: false,
      audible: false,
      _original: original,
    });
  }
  return tabs;
}

function makeWindows() {
  return Array.from({ length: WINDOW_COUNT }, (_, i) => ({ id: i + 1, focused: i === 0 }));
}

/**
 * Install the mock, load background.js against it and wait for the cold-start
 * init gate plus anything chained off it. Returns `{ chrome, bg }`.
 */
async function loadBackgroundWithTabs({ tabs, windows = makeWindows(), settings } = {}) {
  const chrome = installChrome({ tabs, windows });
  if (settings) chrome.storage.sync._store.utsSettings = settings;
  const bg = requireSource('background.js');
  await bg.initPromise;
  await settle();
  return { chrome, bg };
}

/** Let queued microtasks and zero-delay timers drain. */
function settle(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Snapshot of the chrome API calls a scenario is judged by. */
function apiCalls(chrome) {
  return {
    tabsQuery: chrome.tabs.query.mock.calls.length,
    tabsGet: chrome.tabs.get.mock.calls.length,
    tabsUpdate: chrome.tabs.update.mock.calls.length,
    tabsDiscard: chrome.tabs.discard.mock.calls.length,
    tabsReload: chrome.tabs.reload.mock.calls.length,
    sessionSet: chrome.storage.session.set.mock.calls.length,
    badgeText: chrome.action.setBadgeText.mock.calls.length,
    badgeColor: chrome.action.setBadgeBackgroundColor.mock.calls.length,
    title: chrome.action.setTitle.mock.calls.length,
  };
}

/** Render only the counters a scenario actually moved. */
function callDiff(before, after) {
  const moved = Object.keys(after)
    .map((key) => [key, after[key] - before[key]])
    .filter(([, delta]) => delta !== 0)
    .map(([key, delta]) => `${key}:${delta}`);
  return moved.length > 0 ? moved.join(' ') : 'no api calls';
}

/** Time one scenario and print `label  <ms>  <counters>`. */
async function measure(label, fn) {
  const startedAt = performance.now();
  const detail = await fn();
  const ms = performance.now() - startedAt;
  console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms   ${detail || ''}`);
  return ms;
}

/** Time a scenario and report the API calls it made, in one step. */
async function measureCalls(label, chrome, fn) {
  const before = apiCalls(chrome);
  return measure(label, async () => {
    await fn();
    return callDiff(before, apiCalls(chrome));
  });
}

module.exports = {
  ROOT,
  TAB_COUNT,
  WINDOW_COUNT,
  installChrome,
  requireSource,
  makeTabs,
  makeWindows,
  loadBackgroundWithTabs,
  settle,
  apiCalls,
  callDiff,
  measure,
  measureCalls,
};
