/**
 * What the core paths cost at 10k tabs: the every-minute scan, the bulk
 * operations, worker start-up and the session-storage payloads.
 *
 * Several of these are known to scale with the tab count — that is the point of
 * measuring them. See bench/README.md for how to read the output.
 */
const {
  installChrome,
  requireSource,
  makeTabs,
  makeWindows,
  loadBackgroundWithTabs,
  measureCalls,
  settle,
  trackNavigations,
} = require('./helpers');

jest.setTimeout(300000);

const SETTINGS = {
  autoSuspendMinutes: 30,
  whitelist: ['example.com', 'https://foo.com/keep', 'bar.org'],
  neverSuspendAudio: true,
  neverSuspendPinned: true,
  neverSuspendActive: true,
  rememberLastActiveTab: true,
  fixFaviconEnabled: false,
  suspendBatchConcurrency: 5,
  // Off on purpose: with native discard on, every suspended tab waits for its
  // placeholder to report favicon readiness, and the mock never sends that
  // event, so each tab would burn the full DISCARD_READY_TIMEOUT_MS. That wait
  // is a real cost of bulk suspend (see bench/README.md), it just cannot be
  // measured here.
  useNativeDiscard: false,
};

test('checkTabs, the every-minute alarm scan', async () => {
  const { chrome, bg } = await loadBackgroundWithTabs({
    tabs: makeTabs(),
    settings: SETTINGS,
  });

  // No tab is idle yet, so this times the scan itself, not the suspending.
  await measureCalls('checkTabs (nothing idle)', chrome, () => bg.checkTabs());
});

test('worker start-up', async () => {
  const chrome = installChrome({ tabs: makeTabs(), windows: makeWindows() });

  // Measured around the load itself: an MV3 worker pays this every time it is
  // woken, which is many times an hour once the 30s idle teardown kicks in.
  await measureCalls('initializeState + start-up badges', chrome, async () => {
    const bg = requireSource('background.js');
    await bg.initPromise;
    await settle(30);
  });
});

test('unsuspend every tab', async () => {
  const { chrome, bg } = await loadBackgroundWithTabs({
    tabs: makeTabs({ suspendedEvery: 1 }),
    settings: SETTINGS,
  });

  // Each tabs.update here starts a real page load in a real browser, so the
  // number to watch is not how many were sent but how many were in flight at
  // once: that is the memory spike. It should track the batch concurrency, not
  // the tab count.
  const navigations = trackNavigations(chrome);
  await measureCalls('unsuspendAllTabs', chrome, () => bg.unsuspendAllTabs());
  console.log(
    `${'  peak pages loading at once'.padEnd(44)} ${String(navigations.peak).padStart(9)}    of ${navigations.completed} restored`
  );
});

test('suspend every other tab', async () => {
  const { chrome, bg } = await loadBackgroundWithTabs({
    tabs: makeTabs(),
    settings: SETTINGS,
  });

  await measureCalls('suspendOthersInAllWindows', chrome, () =>
    bg.suspendOthersInAllWindows(1)
  );
});

test('session storage write volume', async () => {
  const tabs = makeTabs();
  const { chrome, bg } = await loadBackgroundWithTabs({ tabs, settings: SETTINGS });

  // Start from a browser where every tab already carries a stamp, which is
  // what a session of this size looks like after a scan or two.
  for (const tab of tabs) bg.markTabSeen(tab.id, Date.now());
  bg.flushSeenTimestampsNow();

  const bytesWritten = () =>
    chrome.storage.session.set.mock.calls.reduce(
      (sum, [items]) => sum + JSON.stringify(items).length,
      0
    );

  // What ordinary browsing costs: one tab switch, one page load.
  chrome.storage.session.set.mockClear();
  bg.markTabSeen(4321, Date.now());
  bg.markTabSeen(8765, Date.now());
  bg.flushSeenTimestampsNow();
  console.log(
    `${'seen stamps, two tabs moved'.padEnd(44)} ${String(bytesWritten()).padStart(9)} bytes`
  );

  // The temporary whitelist is still written whole, one array under one key.
  chrome.storage.session.set.mockClear();
  bg.setTempWhitelistFromStorageValue(tabs.map((tab) => tab._original));
  await bg.persistTempWhitelist();
  console.log(
    `${'temp whitelist, 10k paused'.padEnd(44)} ${String(bytesWritten()).padStart(9)} bytes`
  );
});
