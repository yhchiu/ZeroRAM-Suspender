/**
 * What the pause badge costs at 10k tabs.
 *
 * The badge is painted only on the tabs the user can see — the active tab of
 * each window — so every number here should stay flat as the tab count grows.
 * A scenario whose call count starts tracking TAB_COUNT is a regression.
 */
const {
  installChrome,
  requireSource,
  makeTabs,
  makeWindows,
  loadBackgroundWithTabs,
  measureCalls,
  settle,
} = require('./helpers');

jest.setTimeout(300000);

/** A browser where every tab is already paused when the worker starts. */
function installAllPaused(tabs) {
  const chrome = installChrome({ tabs, windows: makeWindows() });
  chrome.storage.session._store.utsTempWhitelist = tabs.map((tab) => tab._original);
  return chrome;
}

test('badge refresh', async () => {
  const tabs = makeTabs();
  const { chrome, bg } = await loadBackgroundWithTabs({ tabs });

  await measureCalls('refresh, nothing paused', chrome, () => bg.refreshVisibleBadges());

  bg.setTempWhitelistFromStorageValue(tabs.map((tab) => tab._original));
  await measureCalls('refresh, 10k newly paused', chrome, () => bg.refreshVisibleBadges());
  await measureCalls('refresh, no change', chrome, () => bg.refreshVisibleBadges());

  bg.setTempWhitelistFromStorageValue([]);
  await measureCalls('refresh, 10k resumed', chrome, () => bg.refreshVisibleBadges());
});

test('badge refresh with suspended placeholders', async () => {
  const { chrome, bg } = await loadBackgroundWithTabs({ tabs: makeTabs({ suspendedEvery: 2 }) });

  await measureCalls('refresh, half suspended tabs', chrome, () => bg.refreshVisibleBadges());
});

test('pause shortcuts', async () => {
  const { chrome, bg } = await loadBackgroundWithTabs({ tabs: makeTabs() });

  await measureCalls('pause one tab (command 06)', chrome, () =>
    bg.toggleTabPauseState(chrome._getTab(1))
  );
  await measureCalls('pause every window (command 08)', chrome, () =>
    bg.toggleAllWindowsPauseState()
  );
});

test('tab activation with everything paused', async () => {
  const chrome = installAllPaused(makeTabs());
  const bg = requireSource('background.js');
  await bg.initPromise;
  await settle();

  // Switch within window 1, the way Chrome would: the incoming tab is the
  // active one by the time the event arrives.
  chrome._getTab(1).active = false;
  chrome._getTab(4321).active = true;
  void bg;

  await measureCalls('activate a paused tab', chrome, () =>
    chrome.tabs.onActivated.trigger({ tabId: 4321, windowId: 1 })
  );
});

test('worker start-up with everything paused', async () => {
  const chrome = installAllPaused(makeTabs());

  // Loaded inside the measurement: the start-up work is chained off the init
  // gate, so it only runs once background.js is required.
  await measureCalls('worker start-up, 10k paused', chrome, async () => {
    const bg = requireSource('background.js');
    await bg.initPromise;
    await settle(50);
  });
});
