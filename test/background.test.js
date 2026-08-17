/**
 * Tests for background.js — the MV3 service worker core.
 * Each test re-loads the module with a fresh chrome mock so module-level state
 * is isolated. Fake timers drive the various debounce/timeout paths.
 */
const { loadBackground, installChrome, requireSource } = require('./helpers/load-source');

const STORAGE_KEY = 'utsSettings';

// Generous default: handlers now await the cold-start init gate, whose restore
// chain adds ~10 microtask generations in front of each handler body.
async function flush(times = 40) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Trigger the async onMessage handler and resolve its sendResponse. */
async function sendMessage(chrome, msg, sender = {}) {
  const sendResponse = jest.fn();
  chrome.runtime.onMessage.triggerSync(msg, sender, sendResponse);
  await flush();
  return sendResponse;
}

/** Session-storage writes touching one key, ignoring unrelated bookkeeping. */
function sessionWrites(chrome, key) {
  return chrome.storage.session.set.mock.calls.filter(
    ([items]) => items && key in items
  );
}

/**
 * Report the pages a bulk unsuspend is waiting on as loaded, the way Chrome
 * would once the restored tab finishes navigating.
 */
async function completeLoads(chrome, tabIds) {
  for (const tabId of tabIds) {
    const tab = chrome._getTab(tabId);
    if (!tab) continue;
    await chrome.tabs.onUpdated.trigger(tabId, { status: 'complete' }, tab);
  }
  await flush();
}

/** Keep reporting loads until a paced bulk run has worked through its queue. */
async function drainLoads(chrome, tabIds, passes = 6) {
  for (let i = 0; i < passes; i++) await completeLoads(chrome, tabIds);
}

function suspendedUrl(chrome, original, title = 'T', favicon) {
  let u = `chrome-extension://${chrome._extId}/suspended.html?uri=${encodeURIComponent(original)}&ttl=${encodeURIComponent(title)}`;
  if (favicon) u += `&favicon=${encodeURIComponent(favicon)}`;
  return u;
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('pure helpers', () => {
  test('isInternalUrl recognizes internal schemes', () => {
    const { bg } = loadBackground();
    for (const u of [
      'chrome://settings',
      'edge://flags',
      'about:blank',
      'about://blank',
      'view-source:https://a.com',
      'devtools://x',
      'chrome-extension://abc/p',
      'extension://abc',
    ]) {
      expect(bg.isInternalUrl(u)).toBe(true);
    }
    expect(bg.isInternalUrl('https://example.com')).toBe(false);
    expect(bg.isInternalUrl('http://example.com')).toBe(false);
  });

  test('isTabGoneError matches gone-tab messages only', () => {
    const { bg } = loadBackground();
    expect(bg.isTabGoneError(new Error('No tab with id: 5'))).toBe(true);
    expect(bg.isTabGoneError(new Error('Invalid tab ID 7'))).toBe(true);
    expect(bg.isTabGoneError('No tab with id: 9')).toBe(true);
    expect(bg.isTabGoneError(new Error('network down'))).toBe(false);
    expect(bg.isTabGoneError(null)).toBe(false);
  });

  test('isSuspendedTab checks the suspended prefix', () => {
    const { bg, chrome } = loadBackground();
    expect(bg.isSuspendedTab({ url: bg.SUSPENDED_PREFIX + '?uri=x' })).toBe(true);
    expect(bg.isSuspendedTab({ url: 'https://x.com' })).toBe(false);
    expect(bg.isSuspendedTab(null)).toBeFalsy();
    expect(bg.isSuspendedTab({})).toBeFalsy();
    void chrome;
  });

  test('whitelist: domain, subdomain, url-prefix, loose-prefix, internal, temp', () => {
    const { bg } = loadBackground();
    const settings = {
      whitelist: ['example.com', 'https://foo.com/keep', 'httpweird'],
    };
    expect(bg.isWhitelisted('https://example.com/p', settings)).toBe(true);
    expect(bg.isWhitelisted('https://sub.example.com/p', settings)).toBe(true);
    expect(bg.isWhitelisted('https://foo.com/keep/page', settings)).toBe(true);
    expect(bg.isWhitelisted('https://foo.com/other', settings)).toBe(false);
    expect(bg.isWhitelisted('https://other.com', settings)).toBe(false);
    // loose prefix entry that fails URL parsing keeps startsWith semantics
    expect(bg.isWhitelisted('httpweird-stuff', settings)).toBe(true);
    // internal pages are always "whitelisted"
    expect(bg.isWhitelisted('chrome://settings', settings)).toBe(true);
    // empty url
    expect(bg.isWhitelisted('', settings)).toBe(false);
  });

  test('whitelist: temp whitelist matches exact url', () => {
    const { bg } = loadBackground();
    bg.setTempWhitelistFromStorageValue(['https://temp.com/a']);
    expect(bg.isWhitelisted('https://temp.com/a', { whitelist: [] })).toBe(true);
    expect(bg.isWhitelisted('https://temp.com/b', { whitelist: [] })).toBe(false);
  });

  test('isHostnameWhitelisted walks up domain labels', () => {
    const { bg } = loadBackground();
    bg.compileWhitelist(['example.com']);
    expect(bg.isHostnameWhitelisted('a.b.example.com')).toBe(true);
    expect(bg.isHostnameWhitelisted('example.org')).toBe(false);
    expect(bg.isHostnameWhitelisted('')).toBe(false);
  });

  test('ensureCompiledWhitelist recompiles when the array reference changes', () => {
    const { bg } = loadBackground();
    const s1 = { whitelist: ['a.com'] };
    bg.ensureCompiledWhitelist(s1);
    expect(bg.isWhitelisted('https://a.com', s1)).toBe(true);
    const s2 = { whitelist: ['b.com'] };
    bg.ensureCompiledWhitelist(s2);
    expect(bg.isWhitelisted('https://a.com', s2)).toBe(false);
    expect(bg.isWhitelisted('https://b.com', s2)).toBe(true);
  });

  test('stripFaviconUrlSuffix removes query/hash', () => {
    const { bg } = loadBackground();
    expect(bg.stripFaviconUrlSuffix('a?b=1')).toBe('a');
    expect(bg.stripFaviconUrlSuffix('a#frag')).toBe('a');
    expect(bg.stripFaviconUrlSuffix('a?b#c')).toBe('a');
    expect(bg.stripFaviconUrlSuffix('a#c?b')).toBe('a');
    expect(bg.stripFaviconUrlSuffix('plain')).toBe('plain');
    expect(bg.stripFaviconUrlSuffix('')).toBe('');
  });

  test('isExtensionDefaultFaviconUrl recognizes manifest icons', () => {
    const { bg, chrome } = loadBackground();
    const iconUrl = `chrome-extension://${chrome._extId}/icons/icon16.png`;
    expect(bg.isExtensionDefaultFaviconUrl(iconUrl)).toBe(true);
    expect(bg.isExtensionDefaultFaviconUrl(iconUrl + '?v=2')).toBe(true);
    expect(bg.isExtensionDefaultFaviconUrl('https://x.com/fav.ico')).toBe(false);
    expect(bg.isExtensionDefaultFaviconUrl('')).toBe(false);
  });

  test('hasUsableSuspendedFavicon / needsSuspendedFaviconFix', () => {
    const { bg, chrome } = loadBackground();
    const defIcon = `chrome-extension://${chrome._extId}/icons/icon16.png`;
    expect(bg.hasUsableSuspendedFavicon({ favIconUrl: 'https://x/f.ico' })).toBe(true);
    expect(bg.hasUsableSuspendedFavicon({ favIconUrl: defIcon })).toBe(false);
    expect(bg.hasUsableSuspendedFavicon({})).toBe(false);

    const susp = bg.SUSPENDED_PREFIX + '?uri=x';
    expect(bg.needsSuspendedFaviconFix({ url: susp, active: false, favIconUrl: defIcon })).toBe(true);
    expect(bg.needsSuspendedFaviconFix({ url: susp, active: false })).toBe(true);
    expect(bg.needsSuspendedFaviconFix({ url: susp, active: true })).toBe(false);
    expect(bg.needsSuspendedFaviconFix({ url: 'https://x', active: false })).toBe(false);
  });

  test('parseOriginalUrlFromSuspended extracts the uri param', () => {
    const { bg } = loadBackground();
    const orig = 'https://example.com/path?q=1';
    const u = bg.SUSPENDED_PREFIX + '?uri=' + encodeURIComponent(orig) + '&ttl=Hello';
    expect(bg.parseOriginalUrlFromSuspended(u)).toBe(orig);
    expect(bg.parseOriginalUrlFromSuspended('https://not-suspended.com')).toBeNull();
    expect(bg.parseOriginalUrlFromSuspended(null)).toBeNull();
  });

  test('markTabSeen records numeric ids only', () => {
    const { bg } = loadBackground();
    expect(bg.markTabSeen(5, 123)).toBe(true);
    expect(bg.__getInternals().seenTimestamps[5]).toBe(123);
    expect(bg.markTabSeen('x', 1)).toBe(false);
  });

  test('getExtensionIconPaths returns unique manifest icon paths', () => {
    const { bg } = loadBackground();
    const paths = bg.getExtensionIconPaths();
    expect(paths).toEqual(expect.arrayContaining(['icons/icon16.png', 'icons/icon128.png']));
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('suspendWithPlaceholder omits a missing title instead of encoding undefined', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com/a', windowId: 1 }],
    });
    await bg.suspendWithPlaceholder(chrome._getTab(1));
    expect(chrome._getTab(1).url).toContain('suspended.html?uri=');
    expect(chrome._getTab(1).url).not.toContain('undefined');
  });

  test('suspendWithPlaceholder builds the suspended URL and updates the tab', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com/a', title: 'Title', favIconUrl: 'https://x.com/f.ico', windowId: 1 }],
    });
    await bg.suspendWithPlaceholder(chrome._getTab(1));
    const updated = chrome._getTab(1);
    expect(chrome.tabs.update).toHaveBeenCalled();
    expect(updated.url).toContain('suspended.html?uri=');
    expect(updated.url).toContain(encodeURIComponent('https://x.com/a'));
    expect(updated.url).toContain('favicon=');
  });
});

describe('settings & storage', () => {
  test('getSettings merges stored values over defaults', async () => {
    const { bg, chrome } = loadBackground();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 10 };
    const s = await bg.getSettings();
    expect(s.autoSuspendMinutes).toBe(10);
    expect(s.useNativeDiscard).toBe(true); // default preserved
  });

  test('getSettingsCached caches within the TTL and refreshes after expiry', async () => {
    const { bg, chrome } = loadBackground();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 5 };
    chrome.storage.sync.get.mockClear();

    await bg.getSettingsCached();
    await bg.getSettingsCached();
    expect(chrome.storage.sync.get).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(6000);
    await bg.getSettingsCached();
    expect(chrome.storage.sync.get).toHaveBeenCalledTimes(2);
  });

  test('storage.onChanged refreshes the settings cache', async () => {
    const { bg, chrome } = loadBackground();
    await bg.saveSettings({ autoSuspendMinutes: 99 });
    await flush();
    expect(bg.__getInternals().cachedSettings.autoSuspendMinutes).toBe(99);
  });

  test('setTempWhitelistFromStorageValue cleans non-strings; non-array clears', () => {
    const { bg } = loadBackground();
    bg.setTempWhitelistFromStorageValue(['a', '', 3, 'b']);
    expect([...bg.__getInternals().tempWhitelist]).toEqual(['a', 'b']);
    bg.setTempWhitelistFromStorageValue('nope');
    expect(bg.__getInternals().tempWhitelist.size).toBe(0);
  });

  test('persistTempWhitelist / saveLastActiveTab write to session storage', async () => {
    const { bg, chrome } = loadBackground();
    bg.setTempWhitelistFromStorageValue(['u']);
    await bg.persistTempWhitelist();
    expect(chrome.storage.session._store.utsTempWhitelist).toEqual(['u']);
    bg.__setState({ lastActiveTabId: 42 });
    await bg.saveLastActiveTab();
    expect(chrome.storage.session._store.utsLastActiveTab).toBe(42);
  });

  test('saveSeenTimestamps debounces and flushSeenTimestampsNow forces a write', () => {
    const { bg, chrome } = loadBackground();
    bg.markTabSeen(1, 111);
    chrome.storage.session.set.mockClear();
    bg.saveSeenTimestamps();
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2000);
    expect(chrome.storage.session.set).toHaveBeenCalledWith({ 'utsSeen:1': 111 });

    bg.markTabSeen(2, 222);
    bg.saveSeenTimestamps();
    chrome.storage.session.set.mockClear();
    bg.flushSeenTimestampsNow();
    expect(chrome.storage.session.set).toHaveBeenCalledWith({ 'utsSeen:2': 222 });
  });

  test('only the tabs that moved are written, and closed tabs are removed', () => {
    const { bg, chrome } = loadBackground();
    bg.markTabSeen(1, 111);
    bg.markTabSeen(2, 222);
    bg.flushSeenTimestampsNow();
    chrome.storage.session.set.mockClear();

    // One stamp changes: the other tab's key is left alone rather than
    // rewritten as part of a whole-map dump.
    bg.markTabSeen(2, 333);
    bg.flushSeenTimestampsNow();
    expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.session.set).toHaveBeenCalledWith({ 'utsSeen:2': 333 });

    bg.forgetTabSeen(1);
    bg.flushSeenTimestampsNow();
    expect(chrome.storage.session.remove).toHaveBeenCalledWith(['utsSeen:1']);
    expect('utsSeen:1' in chrome.storage.session._store).toBe(false);
    expect(chrome.storage.session._store['utsSeen:2']).toBe(333);
  });

  test('marking a tab after forgetting it writes the stamp instead of removing it', () => {
    const { bg, chrome } = loadBackground();
    bg.markTabSeen(1, 111);
    bg.flushSeenTimestampsNow();
    chrome.storage.session.set.mockClear();
    chrome.storage.session.remove.mockClear();

    bg.forgetTabSeen(1);
    bg.markTabSeen(1, 222);
    bg.flushSeenTimestampsNow();

    expect(chrome.storage.session.set).toHaveBeenCalledWith({ 'utsSeen:1': 222 });
    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
    expect(chrome.storage.session._store['utsSeen:1']).toBe(222);
  });

  test('nothing is written when no stamp has moved', () => {
    const { bg, chrome } = loadBackground();
    bg.markTabSeen(1, 111);
    bg.flushSeenTimestampsNow();
    chrome.storage.session.set.mockClear();

    bg.flushSeenTimestampsNow();
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });

  test('start-up restores per-tab stamps and folds in an older whole-map key', async () => {
    const chrome = installChrome();
    chrome.storage.session._store['utsSeen:5'] = 555;
    chrome.storage.session._store['utsSeen:6'] = 100;
    // Left by a worker from before the per-tab layout.
    chrome.storage.session._store.utsSeen = { 6: 666, 7: 777 };

    const bg = requireSource('background.js');
    await bg.initPromise;

    const seen = bg.__getInternals().seenTimestamps;
    expect(seen[5]).toBe(555);
    expect(seen[6]).toBe(666); // the newer of the two wins
    expect(seen[7]).toBe(777);
    expect('utsSeen' in chrome.storage.session._store).toBe(false);
    // Legacy values must land as per-tab keys before the whole-map key is
    // dropped, or the next worker start would find neither copy.
    expect(chrome.storage.session._store['utsSeen:5']).toBe(555);
    expect(chrome.storage.session._store['utsSeen:6']).toBe(666);
    expect(chrome.storage.session._store['utsSeen:7']).toBe(777);
  });

  test('loadLastActiveTabPerWindow restores the map from session', async () => {
    const { bg, chrome } = loadBackground();
    chrome.storage.session._store.utsLastActiveTabPerWindow = { 1: { tabId: 7, timestamp: 5 } };
    await bg.loadLastActiveTabPerWindow();
    expect(bg.__getInternals().lastActiveTabPerWindow.get(1)).toEqual({ tabId: 7, timestamp: 5 });
  });
});

describe('suspendTab lifecycle', () => {
  test('skips internal pages', async () => {
    const { bg, chrome } = loadBackground();
    await bg.suspendTab({ id: 1, url: 'chrome://settings', active: false }, { useNativeDiscard: false });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  test('active tab is suspended without discard', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', title: 'X', active: true, windowId: 1 }],
    });
    await bg.suspendTab(chrome._getTab(1), { useNativeDiscard: true });
    expect(chrome.tabs.update).toHaveBeenCalled();
    expect(chrome.tabs.discard).not.toHaveBeenCalled();
  });

  test('inactive tab is suspended and then discarded once ready', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', title: 'X', favIconUrl: 'https://x.com/f.ico', active: false, status: 'complete', windowId: 1 }],
    });
    const p = bg.suspendTab(chrome._getTab(1), { useNativeDiscard: true });
    await flush();
    await p;
    expect(chrome.tabs.discard).toHaveBeenCalledWith(1);
  });

  test('inactive tab discards via timeout fallback', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', title: 'X', active: false, windowId: 1 }],
    });
    const p = bg.suspendTab(chrome._getTab(1), { useNativeDiscard: true });
    await flush();
    jest.advanceTimersByTime(10000); // DISCARD_READY_TIMEOUT_MS
    await flush();
    await p;
    expect(chrome.tabs.discard).toHaveBeenCalledWith(1);
  });

  test('rethrows and cancels the wait when placeholder update fails', async () => {
    const { bg } = loadBackground(); // tab id 99 not present -> update rejects
    await expect(
      bg.suspendTab({ id: 99, url: 'https://x.com', title: 'X', active: false }, { useNativeDiscard: true })
    ).rejects.toBeTruthy();
  });

  test('revalidation skips a tab that became audible after the snapshot', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', active: false, audible: true, windowId: 1 }],
    });
    // Snapshot taken before the audio started playing.
    const snapshot = { id: 1, url: 'https://x.com', active: false, audible: false };
    await bg.suspendTab(snapshot, { useNativeDiscard: false, neverSuspendAudio: true, whitelist: [] }, true);
    expect(chrome._getTab(1).url).toBe('https://x.com');
  });

  test('revalidation skips a tab that became the focused window\'s active tab', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', active: true, windowId: 1 }],
      windows: [{ id: 1, focused: true }],
    });
    const snapshot = { id: 1, url: 'https://x.com', active: false };
    await bg.suspendTab(snapshot, { useNativeDiscard: false, whitelist: [] }, true);
    expect(chrome._getTab(1).url).toBe('https://x.com');
  });

  test('revalidation still suspends an active tab in an unfocused window', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', title: 'X', active: true, windowId: 2 }],
      windows: [{ id: 2, focused: false }],
    });
    const snapshot = { id: 1, url: 'https://x.com', active: true };
    await bg.suspendTab(snapshot, { useNativeDiscard: false, whitelist: [] }, true);
    expect(chrome._getTab(1).url).toContain('suspended.html');
  });

  test('revalidation silently skips a closed tab instead of throwing', async () => {
    const { bg, chrome } = loadBackground();
    await bg.suspendTab(
      { id: 99, url: 'https://x.com', active: false },
      { useNativeDiscard: false, whitelist: [] },
      true
    );
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  test('revalidation skips a tab that navigated to a whitelisted url', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://safe.com/page', active: false, windowId: 1 }],
    });
    const snapshot = { id: 1, url: 'https://other.com', active: false };
    await bg.suspendTab(snapshot, { useNativeDiscard: false, whitelist: ['safe.com'] }, true);
    expect(chrome._getTab(1).url).toBe('https://safe.com/page');
  });

  test('markSuspendedFaviconReady resolves a pending discard wait', async () => {
    const { bg } = loadBackground({ tabs: [{ id: 5, url: 'placeholder', windowId: 1 }] });
    bg.beginSuspendedReadyWait(5);
    const internals = bg.__getInternals();
    const pending = internals.pendingDiscardTabs.get(5);
    pending.pageComplete = true; // page already done; favicon is the missing piece
    bg.markSuspendedFaviconReady(5);
    jest.advanceTimersByTime(bg.FAVICON_CAPTURE_DELAY_MS);
    await expect(pending.promise).resolves.toEqual({ timedOut: false });
    expect(internals.suspendedFaviconReadyTabs.has(5)).toBe(true);
  });
});

describe('single-tab unsuspend / toggle', () => {
  test('unsuspendTabById restores the original url for a suspended tab', async () => {
    const orig = 'https://x.com/p';
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'placeholder', windowId: 1 }],
    });
    chrome._getTab(1).url = suspendedUrl(chrome, orig);
    const result = await bg.unsuspendTabById(1);
    expect(result).toBe(true);
    expect(chrome._getTab(1).url).toBe(orig);
    expect(bg.__getInternals().unsuspendingTabs.has(1)).toBe(true);
  });

  test('unsuspendTabById returns false for a non-suspended tab', async () => {
    const { bg, chrome } = loadBackground({ tabs: [{ id: 1, url: 'https://x.com', windowId: 1 }] });
    expect(await bg.unsuspendTabById(1)).toBe(false);
    void chrome;
  });

  test('toggleTabSuspension suspends a normal tab and unsuspends a suspended one', async () => {
    const orig = 'https://x.com/p';
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://x.com', title: 'X', active: true, windowId: 1 },
        { id: 2, url: suspendedUrl({ _extId: 'testextensionid' }, orig), windowId: 1 },
      ],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { useNativeDiscard: false };

    expect(await bg.toggleTabSuspension(chrome._getTab(1))).toBe(true);
    expect(chrome._getTab(1).url).toContain('suspended.html');

    expect(await bg.toggleTabSuspension(chrome._getTab(2))).toBe(true);
    expect(chrome._getTab(2).url).toBe(orig);

    expect(await bg.toggleTabSuspension({ url: 'chrome://x' })).toBe(false);
  });
});

describe('bulk operations', () => {
  function bulkTabs(extId) {
    return [
      { id: 1, url: 'https://current.com', active: true, windowId: 1, currentWindow: true },
      { id: 2, url: 'https://idle.com', active: false, windowId: 1 },
      { id: 3, url: 'https://pin.com', active: false, pinned: true, windowId: 1 },
      { id: 4, url: 'https://audio.com', active: false, audible: true, windowId: 1 },
      { id: 5, url: suspendedUrl({ _extId: extId }, 'https://already.com'), active: false, windowId: 1 },
      { id: 6, url: 'https://white.com', active: false, windowId: 1 },
    ];
  }

  test('suspendOthersInWindow suspends only eligible tabs', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: bulkTabs(extId),
      windows: [{ id: 1, focused: true }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = {
      useNativeDiscard: false,
      whitelist: ['white.com'],
    };
    await bg.suspendOthersInWindow(1);
    expect(chrome._getTab(2).url).toContain('suspended.html'); // idle -> suspended
    expect(chrome._getTab(3).url).toBe('https://pin.com'); // pinned skipped
    expect(chrome._getTab(4).url).toBe('https://audio.com'); // audio skipped
    expect(chrome._getTab(6).url).toBe('https://white.com'); // whitelisted skipped
  });

  test('suspendOthersInWindow reports progress and can be cancelled', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://current.com', active: true, windowId: 1 },
        { id: 2, url: 'https://a.com', active: false, windowId: 1 },
        { id: 3, url: 'https://b.com', active: false, windowId: 1 },
      ],
      windows: [{ id: 1, focused: true }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = {
      useNativeDiscard: false,
      suspendBatchConcurrency: 1,
    };

    const port = { name: 'popup', onDisconnect: { addListener: jest.fn() }, postMessage: jest.fn() };
    chrome.runtime.onConnect.triggerSync(port);

    // Cancel from inside the run, right as the first tab is navigated: the
    // mock finishes a suspension instantly, so there is no window to do it
    // from outside.
    const realUpdate = chrome.tabs.update.getMockImplementation();
    chrome.tabs.update.mockImplementationOnce((tabId, props) => {
      bg.cancelBulkNow();
      return realUpdate(tabId, props);
    });

    await bg.suspendOthersInWindow(1, true);

    const progress = port.postMessage.mock.calls.map((call) => call[0]);
    expect(progress[0]).toMatchObject({ type: 'bulkProgress', action: 'suspendWindow' });
    expect(progress.find((msg) => msg.done)).toMatchObject({
      action: 'suspendWindow',
      done: true,
      cancelled: true,
    });
    // The cancel landed before the whole window was processed.
    expect(chrome._getTab(3).url).toBe('https://b.com');
  });

  test('the window-scoped unsuspend reports its own progress action', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: suspendedUrl({ _extId: extId }, 'https://a.com'), windowId: 1 }],
    });

    const port = { name: 'popup', onDisconnect: { addListener: jest.fn() }, postMessage: jest.fn() };
    chrome.runtime.onConnect.triggerSync(port);

    const done = bg.unsuspendAllTabsInWindow(1, true);
    await flush();
    await completeLoads(chrome, [1]);
    await done;

    const doneMsg = port.postMessage.mock.calls.map((call) => call[0]).find((m) => m.done);
    expect(doneMsg).toMatchObject({ action: 'unsuspendWindow', done: true, total: 1 });
  });

  test('suspendOthersInAllWindows reports progress and suspends across windows', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://current.com', active: true, windowId: 1 },
        { id: 2, url: 'https://a.com', active: false, windowId: 1 },
        { id: 3, url: 'https://b.com', active: false, windowId: 2 },
      ],
      windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { useNativeDiscard: false };

    const port = { name: 'popup', onDisconnect: { addListener: jest.fn() }, postMessage: jest.fn() };
    chrome.runtime.onConnect.triggerSync(port);

    await bg.suspendOthersInAllWindows(1, true);
    expect(chrome._getTab(2).url).toContain('suspended.html');
    expect(chrome._getTab(3).url).toContain('suspended.html');
    const doneMsg = port.postMessage.mock.calls.map((c) => c[0]).find((m) => m.done);
    expect(doneMsg).toMatchObject({ type: 'bulkProgress', action: 'suspendAll', done: true });
  });

  test('unsuspendAllTabs restores every suspended tab', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: suspendedUrl({ _extId: extId }, 'https://a.com'), windowId: 1 },
        { id: 2, url: suspendedUrl({ _extId: extId }, 'https://b.com'), windowId: 1 },
        { id: 3, url: 'https://normal.com', windowId: 1 },
      ],
    });
    const done = bg.unsuspendAllTabs(false);
    await flush();
    await completeLoads(chrome, [1, 2]);
    await done;

    expect(chrome._getTab(1).url).toBe('https://a.com');
    expect(chrome._getTab(2).url).toBe('https://b.com');
    expect(chrome._getTab(3).url).toBe('https://normal.com');
  });

  test('unsuspendAllTabsInWindow restores only that window', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: suspendedUrl({ _extId: extId }, 'https://a.com'), windowId: 1 },
        { id: 2, url: suspendedUrl({ _extId: extId }, 'https://b.com'), windowId: 2 },
      ],
    });
    const done = bg.unsuspendAllTabsInWindow(1);
    await flush();
    await completeLoads(chrome, [1]);
    await done;

    expect(chrome._getTab(1).url).toBe('https://a.com');
    expect(chrome._getTab(2).url).toContain('suspended.html'); // other window untouched
  });

  test('bulk unsuspend keeps a fixed number of pages loading at once', async () => {
    const extId = 'testextensionid';
    const tabs = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      url: suspendedUrl({ _extId: extId }, `https://site${i}.com`),
      windowId: 1,
    }));
    const { bg, chrome } = loadBackground({ tabs });
    chrome.storage.sync._store[STORAGE_KEY] = { suspendBatchConcurrency: 5 };

    const done = bg.unsuspendAllTabs(false);
    await flush();

    // Five slots are filled; the rest of the session is not handed to Chrome.
    expect(chrome.tabs.update).toHaveBeenCalledTimes(5);

    // One page comes back, so exactly one more starts: the window slides
    // rather than waiting for the whole group.
    await completeLoads(chrome, [1]);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(6);

    await completeLoads(chrome, [2, 3]);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(8);

    await drainLoads(chrome, tabs.map((tab) => tab.id));
    await done;
    expect(chrome.tabs.update).toHaveBeenCalledTimes(12);
    expect(chrome._getTab(12).url).toBe('https://site11.com');
  });

  test('a slow page costs its own slot, not the whole window', async () => {
    const extId = 'testextensionid';
    const tabs = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      url: suspendedUrl({ _extId: extId }, `https://site${i}.com`),
      windowId: 1,
    }));
    const { bg, chrome } = loadBackground({ tabs });
    chrome.storage.sync._store[STORAGE_KEY] = { suspendBatchConcurrency: 2 };

    const done = bg.unsuspendAllTabs(false);
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);

    // Tab 1 never reports back. Its neighbour's slot keeps turning over
    // regardless, which fixed batches could not do.
    await completeLoads(chrome, [2]);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(3);
    await completeLoads(chrome, [3]);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(4);

    // The stuck slot is freed by its own timeout, and the run finishes.
    jest.advanceTimersByTime(bg.UNSUSPEND_LOAD_TIMEOUT_MS);
    await drainLoads(chrome, tabs.map((tab) => tab.id));
    jest.advanceTimersByTime(bg.UNSUSPEND_LOAD_TIMEOUT_MS);
    await drainLoads(chrome, tabs.map((tab) => tab.id));
    await done;

    expect(chrome.tabs.update).toHaveBeenCalledTimes(6);
    expect(chrome._getTab(1).url).toBe('https://site0.com');
  });

  test('a page that never loads times out instead of stalling the queue', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: suspendedUrl({ _extId: extId }, 'https://slow.com'), windowId: 1 },
        { id: 2, url: suspendedUrl({ _extId: extId }, 'https://b.com'), windowId: 1 },
      ],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { suspendBatchConcurrency: 1 };

    const done = bg.unsuspendAllTabs(false);
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);

    // Tab 1 never reports back; the wait gives up and the queue moves on.
    jest.advanceTimersByTime(bg.UNSUSPEND_LOAD_TIMEOUT_MS);
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);

    await completeLoads(chrome, [2]);
    await done;
  });

  test('cancelling a bulk unsuspend stops it at the current batch', async () => {
    const extId = 'testextensionid';
    const tabs = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      url: suspendedUrl({ _extId: extId }, `https://site${i}.com`),
      windowId: 1,
    }));
    const { bg, chrome } = loadBackground({ tabs });
    chrome.storage.sync._store[STORAGE_KEY] = { suspendBatchConcurrency: 5 };

    const port = { name: 'popup', onDisconnect: { addListener: jest.fn() }, postMessage: jest.fn() };
    chrome.runtime.onConnect.triggerSync(port);

    const done = bg.unsuspendAllTabs(true);
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(5);

    // Cancelling settles the waits too, so the run does not have to sit out
    // the rest of the batch it is on.
    bg.cancelBulkNow();
    await done;

    expect(chrome.tabs.update).toHaveBeenCalledTimes(5);
    const doneMsg = port.postMessage.mock.calls.map((c) => c[0]).find((m) => m.done);
    expect(doneMsg).toMatchObject({ action: 'unsuspendAll', done: true, cancelled: true });
  });

  test('the window-scoped unsuspend can be cancelled too', async () => {
    const extId = 'testextensionid';
    const tabs = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      url: suspendedUrl({ _extId: extId }, `https://site${i}.com`),
      windowId: 1,
    }));
    const { bg, chrome } = loadBackground({ tabs });
    chrome.storage.sync._store[STORAGE_KEY] = { suspendBatchConcurrency: 5 };

    const done = bg.unsuspendAllTabsInWindow(1);
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(5);

    bg.cancelBulkNow();
    await done;
    expect(chrome.tabs.update).toHaveBeenCalledTimes(5);
  });

  test('a tab closed mid-restore does not hold up its batch', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: suspendedUrl({ _extId: extId }, 'https://a.com'), windowId: 1 },
        { id: 2, url: suspendedUrl({ _extId: extId }, 'https://b.com'), windowId: 1 },
      ],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { suspendBatchConcurrency: 1 };

    const done = bg.unsuspendAllTabs(false);
    await flush();

    chrome.tabs.remove(1);
    await chrome.tabs.onRemoved.trigger(1, { windowId: 1 });
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);

    await completeLoads(chrome, [2]);
    await done;
    expect(chrome._getTab(2).url).toBe('https://b.com');
  });

  test('suspendSelectedTabs force-suspends, skipping internal pages', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', windowId: 1 },
        { id: 2, url: 'chrome://settings', windowId: 1 },
      ],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { useNativeDiscard: false };
    await bg.suspendSelectedTabs([1, 2, 999]);
    expect(chrome._getTab(1).url).toContain('suspended.html');
    expect(chrome._getTab(2).url).toBe('chrome://settings');
  });

  test('unsuspendSelectedTabs unsuspends each id and tolerates failures', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: suspendedUrl({ _extId: extId }, 'https://a.com'), windowId: 1 }],
    });
    await bg.unsuspendSelectedTabs([1, 999]);
    expect(chrome._getTab(1).url).toBe('https://a.com');
  });

  test('cancelBulkNow flags the token and resolves pending discards', async () => {
    const { bg } = loadBackground();
    const token = bg.newCancelToken();
    bg.beginSuspendedReadyWait(3);
    const pending = bg.__getInternals().pendingDiscardTabs.get(3);
    bg.cancelBulkNow();
    expect(token.cancelled).toBe(true);
    await expect(pending.promise).resolves.toBeDefined();
  });
});

describe('event listeners', () => {
  test('onMessage: updateSettings saves and responds done', async () => {
    const { chrome } = loadBackground();
    const resp = await sendMessage(chrome, { command: 'updateSettings', settings: { autoSuspendMinutes: 7 } });
    expect(chrome.storage.sync._store[STORAGE_KEY]).toEqual({ autoSuspendMinutes: 7 });
    expect(resp).toHaveBeenCalledWith({ done: true });
  });

  test('onMessage: toggleTempWhitelist toggles and reports state', async () => {
    const { bg, chrome } = loadBackground();
    await flush(); // let the cold-start IIFE finish reassigning tempWhitelist
    const r1 = await sendMessage(chrome, { command: 'toggleTempWhitelist', url: 'https://t.com' });
    expect(r1).toHaveBeenCalledWith({ whitelisted: true });
    expect(bg.__getInternals().tempWhitelist.has('https://t.com')).toBe(true);
    const r2 = await sendMessage(chrome, { command: 'toggleTempWhitelist', url: 'https://t.com' });
    expect(r2).toHaveBeenCalledWith({ whitelisted: false });
  });

  test('onMessage: suspendTab on a missing tab responds with a gone error', async () => {
    const { chrome } = loadBackground();
    const r = await sendMessage(chrome, { command: 'suspendTab', tabId: 12345 });
    expect(r).toHaveBeenCalledWith({ done: false, error: 'Tab no longer exists' });
  });

  test('onMessage: unknown command responds with an error', async () => {
    const { chrome } = loadBackground();
    const r = await sendMessage(chrome, { command: 'nope' });
    expect(r).toHaveBeenCalledWith({ done: false, error: 'Unknown command' });
  });

  test('onMessage: startUnsuspending tracks the sender tab', async () => {
    const { bg, chrome } = loadBackground();
    await sendMessage(chrome, { command: 'startUnsuspending' }, { tab: { id: 8 } });
    expect(bg.__getInternals().unsuspendingTabs.has(8)).toBe(true);
  });

  test('onMessage: faviconReady confirms readiness once Chrome reports a real favicon', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 9, url: suspendedUrl({ _extId: extId }, 'https://x.com'),
               favIconUrl: 'https://x.com/f.ico', active: false, status: 'complete', windowId: 1 }],
    });
    await sendMessage(chrome, { command: 'faviconReady' }, { tab: { id: 9 } });
    jest.advanceTimersByTime(200);
    await flush();
    expect(bg.__getInternals().suspendedFaviconReadyTabs.has(9)).toBe(true);
  });

  test('onMessage: faviconReady waits for the real favicon and does not mark ready while the extension default icon is showing', async () => {
    const extId = 'testextensionid';
    const defIcon = `chrome-extension://${extId}/icons/icon16.png`;
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 9, url: suspendedUrl({ _extId: extId }, 'https://x.com'),
               favIconUrl: defIcon, active: false, status: 'complete', windowId: 1 }],
    });
    await sendMessage(chrome, { command: 'faviconReady' }, { tab: { id: 9 } });
    jest.advanceTimersByTime(200);
    await flush();
    // Chrome has not captured a real favicon yet → must not be discarded.
    expect(bg.__getInternals().suspendedFaviconReadyTabs.has(9)).toBe(false);
    // The real favicon lands a little later; the next poll confirms it.
    chrome._getTab(9).favIconUrl = 'https://x.com/f.ico';
    jest.advanceTimersByTime(200);
    await flush();
    expect(bg.__getInternals().suspendedFaviconReadyTabs.has(9)).toBe(true);
  });

  test('onMessage: faviconReady marks ready as a best effort after the confirmation cap', async () => {
    const extId = 'testextensionid';
    const defIcon = `chrome-extension://${extId}/icons/icon16.png`;
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 9, url: suspendedUrl({ _extId: extId }, 'https://x.com'),
               favIconUrl: defIcon, active: false, status: 'complete', windowId: 1 }],
    });
    await sendMessage(chrome, { command: 'faviconReady' }, { tab: { id: 9 } });
    // Drive the async reschedule chain one interval at a time up to its cap.
    for (let i = 0; i < bg.FAVICON_CONFIRM_MAX_ATTEMPTS; i++) {
      await jest.advanceTimersByTimeAsync(bg.FAVICON_CONFIRM_INTERVAL_MS);
    }
    // Favicon never became usable, but the tab must still be allowed to discard.
    expect(bg.__getInternals().suspendedFaviconReadyTabs.has(9)).toBe(true);
  });

  test('bulk faviconReady keeps confirm-polling bounded (one chain per tab) and stops once Chrome reports favicons', async () => {
    const extId = 'testextensionid';
    const N = 50; // a "bulk suspend" burst: many pages signal faviconReady at once
    const defIcon = `chrome-extension://${extId}/icons/icon16.png`;
    const tabs = [];
    for (let i = 1; i <= N; i++) {
      tabs.push({
        id: i,
        url: suspendedUrl({ _extId: extId }, `https://x${i}.com`),
        favIconUrl: defIcon, // not a real favicon yet → a naive poll would keep retrying
        active: false,
        status: 'complete',
        windowId: 1,
      });
    }
    const { bg, chrome } = loadBackground({ tabs });

    for (let i = 1; i <= N; i++) {
      await sendMessage(chrome, { command: 'faviconReady' }, { tab: { id: i } });
    }

    // One poll tick issues exactly one chrome.tabs.get per chain: the number of
    // concurrent chains is bounded by the count of signalling tabs (N), never
    // multiplied — there is no per-chain fan-out, so it does not blow up at scale.
    const beforeTick = chrome.tabs.get.mock.calls.length;
    await jest.advanceTimersByTimeAsync(bg.FAVICON_CONFIRM_INTERVAL_MS);
    expect(chrome.tabs.get.mock.calls.length - beforeTick).toBe(N);

    // Chrome now reports a real favicon for every tab (the authoritative signal).
    for (let i = 1; i <= N; i++) {
      const real = `https://x${i}.com/f.ico`;
      chrome._getTab(i).favIconUrl = real;
      await chrome.tabs.onUpdated.trigger(i, { favIconUrl: real }, chrome._getTab(i));
    }
    expect(bg.__getInternals().suspendedFaviconReadyTabs.size).toBe(N);

    // Every chain must now self-terminate at its guard: advancing far past the
    // per-chain cap issues no further gets (they do NOT each keep polling to the
    // cap once readiness is confirmed). This is what keeps cost ~0 at 5k+ tabs.
    const afterReady = chrome.tabs.get.mock.calls.length;
    await jest.advanceTimersByTimeAsync(
      bg.FAVICON_CONFIRM_INTERVAL_MS * (bg.FAVICON_CONFIRM_MAX_ATTEMPTS + 1)
    );
    expect(chrome.tabs.get.mock.calls.length).toBe(afterReady);
  });

  test('onUpdated favIconUrl marks a suspended tab ready and resolves a pending discard', async () => {
    const extId = 'testextensionid';
    const susp = suspendedUrl({ _extId: extId }, 'https://x.com');
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 4, url: susp, favIconUrl: '', active: false, status: 'complete', windowId: 1 }],
    });
    bg.beginSuspendedReadyWait(4);
    await flush();
    const pending = bg.__getInternals().pendingDiscardTabs.get(4);
    expect(pending.pageComplete).toBe(true);
    expect(pending.faviconReady).toBe(false);
    // Chrome's browser process reports the real favicon — the authoritative signal.
    chrome._getTab(4).favIconUrl = 'https://x.com/f.ico';
    const triggerPromise = chrome.tabs.onUpdated.trigger(4, { favIconUrl: 'https://x.com/f.ico' }, chrome._getTab(4));
    await flush();
    jest.advanceTimersByTime(bg.FAVICON_CAPTURE_DELAY_MS);
    await triggerPromise;
    await expect(pending.promise).resolves.toEqual({ timedOut: false });
    expect(bg.__getInternals().suspendedFaviconReadyTabs.has(4)).toBe(true);
  });

  test('onUpdated favIconUrl ignores the auto-populated extension default icon', async () => {
    const extId = 'testextensionid';
    const defIcon = `chrome-extension://${extId}/icons/icon16.png`;
    const susp = suspendedUrl({ _extId: extId }, 'https://x.com');
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 4, url: susp, favIconUrl: defIcon, active: false, status: 'complete', windowId: 1 }],
    });
    await chrome.tabs.onUpdated.trigger(4, { favIconUrl: defIcon }, chrome._getTab(4));
    expect(bg.__getInternals().suspendedFaviconReadyTabs.has(4)).toBe(false);
  });

  test('onMessage: unsuspendNavigate updates the tab url', async () => {
    const { chrome } = loadBackground({ tabs: [{ id: 4, url: 'placeholder', windowId: 1 }] });
    const r = await sendMessage(chrome, { command: 'unsuspendNavigate', url: 'file:///x' }, { tab: { id: 4 } });
    expect(chrome._getTab(4).url).toBe('file:///x');
    expect(r).toHaveBeenCalledWith({ done: true });
  });

  test('onActivated updates timestamps and tracking', async () => {
    // Window 1 must exist: the init gate runs before the handler and prunes
    // per-window entries whose window is gone.
    const { bg, chrome } = loadBackground({ windows: [{ id: 1 }] });
    bg.setLastActiveTabInWindow(1, { tabId: 100, timestamp: 1 });
    await chrome.tabs.onActivated.trigger({ tabId: 200, windowId: 1 });
    const internals = bg.__getInternals();
    expect(internals.seenTimestamps[200]).toBeGreaterThan(0);
    expect(internals.seenTimestamps[100]).toBeGreaterThan(0); // previous tab stamped
    expect(internals.lastActiveTabId).toBe(200);
    expect(internals.lastActiveTabPerWindow.get(1).tabId).toBe(200);
  });

  test('onUpdated complete stamps the tab and clears unsuspending tracking', async () => {
    const { bg, chrome } = loadBackground({ tabs: [{ id: 1, url: 'https://x.com', windowId: 1 }] });
    bg.markTabUnsuspending(1);
    await chrome.tabs.onUpdated.trigger(1, { status: 'complete' }, chrome._getTab(1));
    expect(bg.__getInternals().seenTimestamps[1]).toBeGreaterThan(0);
    expect(bg.__getInternals().unsuspendingTabs.has(1)).toBe(false);
  });

  test('onUpdated url change cancels a pending discard wait', async () => {
    const { bg, chrome } = loadBackground({ tabs: [{ id: 1, url: 'https://x.com', windowId: 1 }] });
    bg.beginSuspendedReadyWait(1);
    const pending = bg.__getInternals().pendingDiscardTabs.get(1);
    await chrome.tabs.onUpdated.trigger(1, { url: 'https://elsewhere.com' }, chrome._getTab(1));
    await expect(pending.promise).resolves.toBeDefined();
  });

  test('onCreated stamps opener and tracks an active new tab', async () => {
    const { bg, chrome } = loadBackground();
    await chrome.tabs.onCreated.trigger({ id: 50, windowId: 1, active: true, openerTabId: 40 });
    const internals = bg.__getInternals();
    expect(internals.seenTimestamps[40]).toBeGreaterThan(0);
    expect(internals.lastActiveTabId).toBe(50);
  });

  test('onRemoved cleans up all tracking for the tab', async () => {
    // Window 2 must exist so the init gate keeps the per-window entry and the
    // handler's own cleanup path is what removes it.
    const { bg, chrome } = loadBackground({ windows: [{ id: 2 }] });
    const internals = bg.__getInternals();
    bg.markTabUnsuspending(7);
    internals.fixFaviconTabs.add(7);
    internals.seenTimestamps[7] = 1;
    bg.setLastActiveTabInWindow(2, { tabId: 7, timestamp: 1 });
    await chrome.tabs.onRemoved.trigger(7, { windowId: 2 });
    // Re-fetch internals: the restore swaps in a fresh per-window map object.
    const after = bg.__getInternals();
    expect(after.unsuspendingTabs.has(7)).toBe(false);
    expect(after.fixFaviconTabs.has(7)).toBe(false);
    expect(7 in after.seenTimestamps).toBe(false);
    expect(after.lastActiveTabPerWindow.has(2)).toBe(false);
  });

  test('onReplaced migrates timestamps and tracking to the new tab id', async () => {
    const { bg, chrome } = loadBackground({ windows: [{ id: 1 }] });
    bg.__getInternals().seenTimestamps[10] = 1234;
    bg.markTabUnsuspending(10);
    bg.setLastActiveTabInWindow(1, { tabId: 10, timestamp: 1234 });
    chrome.storage.session._store.utsLastActiveTab = 10;
    await chrome.tabs.onReplaced.trigger(20, 10);
    const after = bg.__getInternals();
    expect(after.seenTimestamps[20]).toBe(1234);
    expect(10 in after.seenTimestamps).toBe(false);
    expect(after.unsuspendingTabs.has(20)).toBe(true);
    expect(after.unsuspendingTabs.has(10)).toBe(false);
    expect(after.lastActiveTabPerWindow.get(1).tabId).toBe(20);
    expect(after.lastActiveTabId).toBe(20);
  });

  test('onDetached drops the per-window entry for the moved tab', async () => {
    const { bg, chrome } = loadBackground({ windows: [{ id: 1 }] });
    bg.setLastActiveTabInWindow(1, { tabId: 7, timestamp: 1 });
    await chrome.tabs.onDetached.trigger(7, { oldWindowId: 1, oldPosition: 0 });
    expect(bg.__getInternals().lastActiveTabPerWindow.has(1)).toBe(false);
  });

  test('onDetached keeps the entry when a different tab was moved', async () => {
    const { bg, chrome } = loadBackground({ windows: [{ id: 1 }] });
    bg.setLastActiveTabInWindow(1, { tabId: 7, timestamp: 1 });
    await chrome.tabs.onDetached.trigger(8, { oldWindowId: 1, oldPosition: 0 });
    expect(bg.__getInternals().lastActiveTabPerWindow.get(1).tabId).toBe(7);
  });

  test('windows.onRemoved drops the per-window entry for the closed window', async () => {
    const { bg, chrome } = loadBackground({ windows: [{ id: 2 }] });
    bg.setLastActiveTabInWindow(2, { tabId: 9, timestamp: 1 });
    await chrome.windows.onRemoved.trigger(2);
    expect(bg.__getInternals().lastActiveTabPerWindow.has(2)).toBe(false);
  });

  test('onFocusChanged WINDOW_ID_NONE persists last active tab', async () => {
    const { chrome } = loadBackground();
    await chrome.windows.onFocusChanged.trigger(-1);
    expect(chrome.storage.session.set).toHaveBeenCalled();
  });

  test('onFocusChanged to a window updates the active-tab tracking', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 5, url: 'https://x.com', active: true, windowId: 3 }],
      windows: [{ id: 3, focused: true }],
    });
    await chrome.windows.onFocusChanged.trigger(3);
    expect(bg.__getInternals().lastActiveTabPerWindow.get(3).tabId).toBe(5);
  });

  test('alarms.onAlarm runs checkTabs only for the matching alarm name', async () => {
    const { bg, chrome } = loadBackground();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 0 }; // checkTabs early-returns
    await chrome.alarms.onAlarm.trigger({ name: 'somethingElse' });
    await chrome.alarms.onAlarm.trigger({ name: 'utsAutoCheck' });
    expect(bg.__getInternals().running).toBe(false);
  });

  test('commands.onCommand toggles suspend for the current tab', async () => {
    const { chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', title: 'X', active: true, windowId: 1 }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { useNativeDiscard: false };
    await chrome.commands.onCommand.trigger('01-toggle-suspend', chrome._getTab(1));
    expect(chrome._getTab(1).url).toContain('suspended.html');
  });

  test('commands.onCommand toggles pause for the current tab', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', title: 'X', active: true, windowId: 1 }],
    });
    expect(bg.__getInternals().tempWhitelist.has('https://x.com')).toBe(false);
    
    await chrome.commands.onCommand.trigger('06-toggle-pause-current-tab', chrome._getTab(1));
    expect(bg.__getInternals().tempWhitelist.has('https://x.com')).toBe(true);
    
    await chrome.commands.onCommand.trigger('06-toggle-pause-current-tab', chrome._getTab(1));
    expect(bg.__getInternals().tempWhitelist.has('https://x.com')).toBe(false);
  });

  test('commands.onCommand toggles pause for all tabs in current window', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', title: 'A', active: true, windowId: 1 },
        { id: 2, url: 'https://b.com', title: 'B', active: false, windowId: 1 },
        { id: 3, url: 'https://c.com', title: 'C', active: false, windowId: 2 },
      ],
    });
    
    await chrome.commands.onCommand.trigger('07-toggle-pause-window', chrome._getTab(1));
    expect(bg.__getInternals().tempWhitelist.has('https://a.com')).toBe(true);
    expect(bg.__getInternals().tempWhitelist.has('https://b.com')).toBe(true);
    expect(bg.__getInternals().tempWhitelist.has('https://c.com')).toBe(false);
    
    await chrome.commands.onCommand.trigger('07-toggle-pause-window', chrome._getTab(1));
    expect(bg.__getInternals().tempWhitelist.has('https://a.com')).toBe(false);
    expect(bg.__getInternals().tempWhitelist.has('https://b.com')).toBe(false);
  });

  test('commands.onCommand toggles pause for all tabs across all windows', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', title: 'A', active: true, windowId: 1 },
        { id: 2, url: 'https://b.com', title: 'B', active: false, windowId: 2 },
      ],
    });
    
    await chrome.commands.onCommand.trigger('08-toggle-pause-all', chrome._getTab(1));
    expect(bg.__getInternals().tempWhitelist.has('https://a.com')).toBe(true);
    expect(bg.__getInternals().tempWhitelist.has('https://b.com')).toBe(true);
    
    await chrome.commands.onCommand.trigger('08-toggle-pause-all', chrome._getTab(1));
    expect(bg.__getInternals().tempWhitelist.has('https://a.com')).toBe(false);
    expect(bg.__getInternals().tempWhitelist.has('https://b.com')).toBe(false);
  });

  test('onConnect registers and removes popup ports', () => {
    const { bg, chrome } = loadBackground();
    let disconnectCb;
    const port = {
      name: 'popup',
      onDisconnect: { addListener: (cb) => { disconnectCb = cb; } },
      postMessage: jest.fn(),
    };
    chrome.runtime.onConnect.triggerSync(port);
    expect(bg.__getInternals().popupPorts.has(port)).toBe(true);
    disconnectCb();
    expect(bg.__getInternals().popupPorts.has(port)).toBe(false);
  });
});

describe('pause shortcut regressions', () => {
  test('getPausableUrl maps suspended placeholders and rejects internal URLs', () => {
    const { bg, chrome } = loadBackground();
    const original = 'https://suspended.example/page';

    expect(bg.getPausableUrl({
      url: suspendedUrl(chrome, original),
    })).toBe(original);
    expect(bg.getPausableUrl({ url: 'chrome://settings' })).toBeNull();
    expect(bg.getPausableUrl({ url: bg.SUSPENDED_PREFIX })).toBeNull();
    expect(bg.getPausableUrl(null)).toBeNull();
  });

  test('command 06 pauses a suspended tab by original URL and persists it', async () => {
    const original = 'https://suspended.example/page';
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'about:blank', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    chrome._getTab(1).url = suspendedUrl(chrome, original);

    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );

    expect([...bg.__getInternals().tempWhitelist]).toEqual([original]);
    expect(chrome.storage.session._store.utsTempWhitelist).toEqual([original]);
  });

  test.each(['window', 'all'])(
    '%s bulk pause includes suspended original URLs and persists once',
    async (scope) => {
      const { bg, chrome } = loadBackground({
        tabs: [
          { id: 1, url: 'https://a.com', active: true, windowId: 1 },
          { id: 2, url: 'about:blank', active: false, windowId: 1 },
        ],
      });
      await bg.initPromise;
      chrome._getTab(2).url = suspendedUrl(chrome, 'https://b.com');
      chrome.storage.session.set.mockClear();

      if (scope === 'window') {
        await bg.toggleWindowPauseState(1);
      } else {
        await bg.toggleAllWindowsPauseState();
      }

      expect([...bg.__getInternals().tempWhitelist]).toEqual([
        'https://a.com',
        'https://b.com',
      ]);
      expect(chrome.storage.session._store.utsTempWhitelist).toEqual([
        'https://a.com',
        'https://b.com',
      ]);
      expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
    }
  );

  test('null-tab dispatch skips command 07 but still runs and persists command 08', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    chrome.storage.session.set.mockClear();

    await chrome.commands.onCommand.trigger('07-toggle-pause-window', null);

    expect(bg.__getInternals().tempWhitelist.size).toBe(0);
    expect(chrome.storage.session.set).not.toHaveBeenCalled();

    await chrome.commands.onCommand.trigger('08-toggle-pause-all', null);

    expect([...bg.__getInternals().tempWhitelist]).toEqual(['https://a.com']);
    expect(chrome.storage.session._store.utsTempWhitelist).toEqual([
      'https://a.com',
    ]);
    // Counted by key: the badge feedback writes to session storage too.
    expect(sessionWrites(chrome, 'utsTempWhitelist')).toHaveLength(1);
  });

  test.each([
    ['window', false],
    ['all', true],
  ])(
    'mixed %s pause state becomes fully paused and persists',
    async (scope, includesOtherWindow) => {
      const { bg, chrome } = loadBackground({
        tabs: [
          { id: 1, url: 'https://a.com', active: true, windowId: 1 },
          { id: 2, url: 'https://b.com', active: false, windowId: 1 },
          { id: 3, url: 'https://c.com', active: false, windowId: 2 },
        ],
      });
      await bg.initPromise;
      bg.setTempWhitelistFromStorageValue(['https://a.com']);
      chrome.storage.session.set.mockClear();

      if (scope === 'window') {
        await bg.toggleWindowPauseState(1);
      } else {
        await bg.toggleAllWindowsPauseState();
      }

      expect(bg.__getInternals().tempWhitelist.has('https://a.com')).toBe(true);
      expect(bg.__getInternals().tempWhitelist.has('https://b.com')).toBe(true);
      expect(bg.__getInternals().tempWhitelist.has('https://c.com'))
        .toBe(includesOtherWindow);
      expect(chrome.storage.session._store.utsTempWhitelist).toEqual(
        includesOtherWindow
          ? ['https://a.com', 'https://b.com', 'https://c.com']
          : ['https://a.com', 'https://b.com']
      );
      expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
    }
  );
});

describe('persistent pause badge', () => {
  test('a paused tab keeps its badge and tooltip well past the flash window', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );

    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(chrome.action._badgeColor.get(1)).toBe(bg.BADGE_PAUSED_COLOR);
    expect(chrome.action._getTitle(1)).toBe(bg.ACTION_TITLE_PAUSED);
    // Scoped to the paused tab: other tabs keep the empty global badge.
    expect(chrome.action._getBadgeText(99)).toBe('');

    // A pause needs no flash, so nothing is scheduled to take the badge away.
    expect(bg.BADGE_PENDING_KEY in chrome.storage.session._store).toBe(false);
    jest.advanceTimersByTime(bg.BADGE_DURATION_MS * 4);
    await flush();
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);
  });

  test('the active tab of every window is painted, background tabs are not', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: true, windowId: 1 },
        { id: 2, url: 'https://a.com', active: true, windowId: 2 },
        // Same paused URL, but out of view: Chrome would draw this badge
        // nowhere, so it is left unpainted until the user switches to it.
        { id: 3, url: 'https://a.com', active: false, windowId: 2 },
      ],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );

    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(chrome.action._getBadgeText(3)).toBe('');
    expect([...bg.__getInternals().badgedTabWindows.keys()]).toEqual([1, 2]);
  });

  test('switching to a paused tab paints it, and leaving it drops the badge', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: true, windowId: 1 },
        { id: 2, url: 'https://paused.example', active: false, windowId: 1 },
      ],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);

    chrome._getTab(1).active = false;
    chrome._getTab(2).active = true;
    await chrome.tabs.onActivated.trigger({ tabId: 2, windowId: 1 });
    await flush();
    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);

    // Leaving the tab drops the override immediately, so a worker restart
    // cannot leave a stale OFF on a background tab.
    chrome._getTab(2).active = false;
    chrome._getTab(1).active = true;
    await chrome.tabs.onActivated.trigger({ tabId: 1, windowId: 1 });
    await flush();

    expect(chrome.action._getBadgeText(2)).toBe('');
    expect(bg.__getInternals().badgedTabWindows.has(2)).toBe(false);
  });

  test('a badge left by a dead worker is cleared when its tab is left', async () => {
    // The usual order of events: the user watches a paused tab for longer than
    // the 30s idle teardown, so the switch away is the event that starts the
    // next worker — which knows nothing of the badge its predecessor painted.
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: false, windowId: 1 },
        { id: 2, url: 'https://paused.example', active: true, windowId: 1 },
      ],
      windows: [{ id: 1, focused: true }],
    });
    chrome.storage.session._store.utsTempWhitelist = ['https://paused.example'];
    chrome.storage.session._store.utsLastActiveTabPerWindow = {
      1: { tabId: 2, timestamp: Date.now() },
    };
    // What the previous worker left on screen.
    chrome.action._badgeText.set(2, bg.BADGE_PAUSED_TEXT);
    chrome.action._title.set(2, bg.ACTION_TITLE_PAUSED);

    chrome._getTab(2).active = false;
    chrome._getTab(1).active = true;
    await chrome.tabs.onActivated.trigger({ tabId: 1, windowId: 1 });
    await flush();

    // Nothing in the bookkeeping says tab 2 was badged, so the clear has to go
    // through to the API regardless: the tab is out of view, and a later resume
    // would otherwise flash this OFF the moment the user came back.
    expect(chrome.action._getBadgeText(2)).toBe('');
    expect(chrome.action._getTitle(2)).toBe(bg.ACTION_TITLE_DEFAULT);
    expect(bg.__getInternals().badgedTabWindows.has(2)).toBe(false);
  });

  test('leaving a paused tab clears it even with no tracking for the window', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://paused.example', active: true, windowId: 1 },
        { id: 2, url: 'https://a.com', active: false, windowId: 1 },
      ],
      windows: [{ id: 1, focused: true }],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);
    await bg.refreshVisibleBadges();
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);

    // No per-window entry to name the leaving tab: the window was painted by a
    // whitelist change without ever being activated or focused, or a detach
    // dropped its entry. The badge is still ours to take down.
    bg.__getInternals().lastActiveTabPerWindow.delete(1);

    chrome._getTab(1).active = false;
    chrome._getTab(2).active = true;
    await chrome.tabs.onActivated.trigger({ tabId: 2, windowId: 1 });
    await flush();

    expect(chrome.action._getBadgeText(1)).toBe('');
    expect(bg.__getInternals().badgedTabWindows.has(1)).toBe(false);
  });

  test('a paused tab dragged into another window keeps its badge', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: false, windowId: 1 },
        { id: 2, url: 'https://paused.example', active: true, windowId: 1 },
        { id: 3, url: 'https://b.com', active: true, windowId: 2 },
      ],
      windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);
    await bg.refreshVisibleBadges();
    bg.setLastActiveTabInWindow(1, { tabId: 2, timestamp: Date.now() });
    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);

    // Tab 2 is dragged to window 2, where it becomes the active tab; window 1
    // falls back to tab 1. The source window's onActivated can arrive before
    // onDetached has dropped our tracking entry, so it must not take the badge
    // off a tab that is now on screen in the other window.
    chrome._setTabs([
      { id: 1, url: 'https://a.com', active: true, windowId: 1 },
      { id: 2, url: 'https://paused.example', active: true, windowId: 2 },
      { id: 3, url: 'https://b.com', active: false, windowId: 2 },
    ]);
    await chrome.tabs.onActivated.trigger({ tabId: 1, windowId: 1 });
    await flush();

    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(bg.__getInternals().badgedTabWindows.has(2)).toBe(true);
  });

  test('a replaced active tab is painted under the new id', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 10, url: 'https://paused.example', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);
    await bg.refreshVisibleBadges();
    expect(chrome.action._getBadgeText(10)).toBe(bg.BADGE_PAUSED_TEXT);

    chrome._setTabs([{ id: 20, url: 'https://paused.example', active: true, windowId: 1 }]);
    await chrome.tabs.onReplaced.trigger(20, 10);
    await flush();

    expect(chrome.action._getBadgeText(20)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(bg.__getInternals().badgedTabWindows.has(20)).toBe(true);
    expect(bg.__getInternals().badgedTabWindows.has(10)).toBe(false);
  });

  test('replacing a background tab does not paint a badge', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: true, windowId: 1 },
        { id: 10, url: 'https://paused.example', active: false, windowId: 1 },
      ],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);
    chrome.action.setBadgeText.mockClear();

    chrome._setTabs([
      { id: 1, url: 'https://a.com', active: true, windowId: 1 },
      { id: 20, url: 'https://paused.example', active: false, windowId: 1 },
    ]);
    await chrome.tabs.onReplaced.trigger(20, 10);
    await flush();

    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
    expect(bg.__getInternals().badgedTabWindows.has(20)).toBe(false);
  });

  test('focusing a window paints its active tab', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: true, windowId: 1 },
        { id: 2, url: 'https://paused.example', active: true, windowId: 2 },
      ],
      windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);

    await chrome.windows.onFocusChanged.trigger(2);
    await flush();

    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);
  });

  test('focusing a window does not clear the other window\'s badge', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://paused.example', active: true, windowId: 1 },
        { id: 2, url: 'https://paused.example', active: true, windowId: 2 },
      ],
      windows: [{ id: 1, focused: true }, { id: 2, focused: false }],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);
    await bg.refreshVisibleBadges();
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);

    await chrome.windows.onFocusChanged.trigger(2);
    await flush();

    // Window 1 still shows its active tab; that override must stay.
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);
  });

  test('a suspended tab is badged by the URL it was suspended from', async () => {
    const original = 'https://suspended.example/page';
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: false, windowId: 1 },
        { id: 2, url: 'about:blank', active: true, windowId: 1 },
      ],
    });
    await bg.initPromise;
    await flush();
    chrome._getTab(2).url = suspendedUrl(chrome, original);

    bg.setTempWhitelistFromStorageValue([original]);
    await bg.refreshVisibleBadges();

    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(chrome.action._getBadgeText(1)).toBe('');
  });

  test('the popup toggle badges the tab too', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();

    await sendMessage(chrome, {
      command: 'toggleTempWhitelist',
      url: 'https://a.com',
    });
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);

    await sendMessage(chrome, {
      command: 'toggleTempWhitelist',
      url: 'https://a.com',
    });
    expect(chrome.action._getBadgeText(1)).toBe('');
    expect(chrome.action._getTitle(1)).toBe(bg.ACTION_TITLE_DEFAULT);
  });

  test('navigation re-applies and drops the badge, since Chrome resets it', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://other.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://a.com']);

    const tab = chrome._getTab(1);
    tab.url = 'https://a.com';
    await chrome.tabs.onUpdated.trigger(1, { url: 'https://a.com' }, tab);
    await flush();
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);

    tab.url = 'https://other.com';
    await chrome.tabs.onUpdated.trigger(1, { url: 'https://other.com' }, tab);
    await flush();
    expect(chrome.action._getBadgeText(1)).toBe('');
  });

  test('a background tab navigating costs no badge call at all', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: true, windowId: 1 },
        { id: 2, url: 'https://other.com', active: false, windowId: 1 },
      ],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://paused.example']);
    chrome.action.setBadgeText.mockClear();

    const tab = chrome._getTab(2);
    tab.url = 'https://paused.example';
    await chrome.tabs.onUpdated.trigger(2, { url: 'https://paused.example' }, tab);
    await flush();

    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
    expect(bg.__getInternals().badgedTabWindows.has(2)).toBe(false);
  });

  test('a closed tab is dropped from the badge bookkeeping', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );
    expect(bg.__getInternals().badgedTabWindows.has(1)).toBe(true);

    chrome._setTabs([]);
    await chrome.tabs.onRemoved.trigger(1, { windowId: 1 });
    await flush();

    expect(bg.__getInternals().badgedTabWindows.has(1)).toBe(false);
  });

  test('a failing tab query costs the badges, not the pause itself', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    chrome.tabs.query.mockRejectedValueOnce(new Error('shutting down'));

    bg.setTempWhitelistFromStorageValue(['https://a.com']);
    await bg.persistTempWhitelist();

    expect(chrome.storage.session._store.utsTempWhitelist).toEqual([
      'https://a.com',
    ]);
    expect(chrome.action._getBadgeText(1)).toBe('');
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  test('start-up paints the tabs in view and no others', async () => {
    const chrome = installChrome({
      tabs: [
        { id: 5, url: 'https://a.com', active: true, windowId: 1 },
        // Same paused URL, out of view, plus an unpaused tab in view.
        { id: 6, url: 'https://a.com', active: false, windowId: 1 },
        { id: 7, url: 'https://b.com', active: true, windowId: 2 },
      ],
    });
    chrome.storage.session._store.utsTempWhitelist = ['https://a.com'];

    const bg = requireSource('background.js');
    await bg.initPromise;
    await flush();

    expect(chrome.action._getBadgeText(5)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(chrome.action._getTitle(5)).toBe(bg.ACTION_TITLE_PAUSED);
    expect(chrome.action._getBadgeText(6)).toBe('');
    expect(chrome.action._getBadgeText(7)).toBe('');
    // Only the one paused tab in view was written to.
    expect(chrome.action.setBadgeText).toHaveBeenCalledTimes(1);
  });
});

describe('shortcut badge flash', () => {
  test('resuming a tab clears the badge and flashes ON, then settles', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );
    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );

    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_RESUMED_TEXT);
    expect(chrome.action._badgeColor.get(1)).toBe(bg.BADGE_RESUMED_COLOR);
    // The tooltip already reports the settled state during the flash.
    expect(chrome.action._getTitle(1)).toBe(bg.ACTION_TITLE_DEFAULT);
    expect(chrome.storage.session._store[bg.BADGE_PENDING_KEY]).toBe(1);

    jest.advanceTimersByTime(bg.BADGE_DURATION_MS);
    await flush();

    expect(chrome.action._getBadgeText(1)).toBe('');
    expect(bg.BADGE_PENDING_KEY in chrome.storage.session._store).toBe(false);
  });

  test('an unpausable tab flashes a red cross', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'chrome://settings', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );

    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_FAILURE_TEXT);
    expect(chrome.action._badgeColor.get(1)).toBe(bg.BADGE_FAILURE_COLOR);
    expect(bg.__getInternals().tempWhitelist.size).toBe(0);

    jest.advanceTimersByTime(bg.BADGE_DURATION_MS);
    await flush();
    expect(chrome.action._getBadgeText(1)).toBe('');
  });

  test('a window with no pausable tabs flashes a cross', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'chrome://settings', active: true, windowId: 1 },
        { id: 2, url: 'about:blank', active: false, windowId: 1 },
      ],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger(
      '07-toggle-pause-window',
      chrome._getTab(1)
    );

    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_FAILURE_TEXT);
  });

  test('a pause that misses the acting tab still flashes it', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'chrome://settings', active: true, windowId: 1 },
        { id: 2, url: 'https://b.com', active: false, windowId: 1 },
      ],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger(
      '07-toggle-pause-window',
      chrome._getTab(1)
    );

    // The internal page cannot be paused, so the flash is the only report the
    // user gets: the tab that was paused is out of view and stays unpainted.
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(chrome.action._getTitle(1)).toBe(bg.ACTION_TITLE_DEFAULT);
    expect(chrome.action._getBadgeText(2)).toBe('');

    jest.advanceTimersByTime(bg.BADGE_DURATION_MS);
    await flush();

    expect(chrome.action._getBadgeText(1)).toBe('');
    expect(bg.__getInternals().tempWhitelist.has('https://b.com')).toBe(true);
  });

  test('a thrown command error flashes a cross', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    chrome.tabs.query.mockRejectedValueOnce(new Error('boom'));

    await chrome.commands.onCommand.trigger(
      '07-toggle-pause-window',
      chrome._getTab(1)
    );

    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_FAILURE_TEXT);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('the all-windows shortcut without a tab flashes globally', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();

    await chrome.commands.onCommand.trigger('08-toggle-pause-all', null);

    expect(chrome.action._getBadgeText()).toBe(bg.BADGE_PAUSED_TEXT);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({
      text: bg.BADGE_PAUSED_TEXT,
    });
    expect(chrome.storage.session._store[bg.BADGE_PENDING_KEY]).toBeNull();

    jest.advanceTimersByTime(bg.BADGE_DURATION_MS);
    await flush();

    // The global flash goes away; the paused tab keeps its own badge.
    expect(chrome.action._getBadgeText()).toBe('');
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_PAUSED_TEXT);
  });

  test('a second press in another window restores the first tab', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://a.com', active: true, windowId: 1 },
        { id: 2, url: 'https://b.com', active: true, windowId: 2 },
      ],
    });
    await bg.initPromise;
    await flush();
    // Tab 1 is paused, then resumed, so it is flashing ON.
    bg.setTempWhitelistFromStorageValue(['https://a.com']);
    await bg.refreshVisibleBadges();
    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    );
    expect(chrome.action._getBadgeText(1)).toBe(bg.BADGE_RESUMED_TEXT);

    // Second press lands while the first flash is still on screen.
    jest.advanceTimersByTime(bg.BADGE_DURATION_MS / 2);
    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(2)
    );

    expect(chrome.action._getBadgeText(1)).toBe('');
    expect(chrome.action._getBadgeText(2)).toBe(bg.BADGE_PAUSED_TEXT);
  });

  test('a tab closed before the reset timer does not break the worker', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await bg.initPromise;
    await flush();
    bg.setTempWhitelistFromStorageValue(['https://a.com']);

    await chrome.commands.onCommand.trigger(
      '06-toggle-pause-current-tab',
      chrome._getTab(1)
    ); // resume, so a flash is on screen
    chrome._setTabs([]); // tab goes away; setBadgeText now rejects
    jest.advanceTimersByTime(bg.BADGE_DURATION_MS);
    await flush();

    expect(bg.BADGE_PENDING_KEY in chrome.storage.session._store).toBe(false);
  });

  test('a tab that vanishes before the badge is drawn is swallowed', async () => {
    const { bg, chrome } = loadBackground();
    await bg.initPromise;
    await flush();
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Tab id 42 is not in the mock's tab list, so the badge calls reject.
    await chrome.commands.onCommand.trigger('06-toggle-pause-current-tab', {
      id: 42,
      url: 'https://a.com',
      windowId: 1,
    });

    // The pause itself still went through; only the feedback was lost.
    expect([...bg.__getInternals().tempWhitelist]).toEqual(['https://a.com']);
    expect(bg.BADGE_PENDING_KEY in chrome.storage.session._store).toBe(false);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  test('a flash left by a dead worker gives way to the persistent badge', async () => {
    const chrome = installChrome({
      tabs: [{ id: 7, url: 'https://a.com', active: true, windowId: 1 }],
    });
    // Simulate the previous worker dying mid-flash on a tab that is paused.
    chrome.storage.session._store.utsTempWhitelist = ['https://a.com'];
    chrome.storage.session._store.utsPendingBadgeTab = 7;
    chrome.action._badgeText.set(7, '✕');

    const bg = requireSource('background.js');
    await bg.initPromise;
    await flush();

    expect(chrome.action._getBadgeText(7)).toBe(bg.BADGE_PAUSED_TEXT);
    expect(bg.BADGE_PENDING_KEY in chrome.storage.session._store).toBe(false);
  });

  test('a flash left on a tab that is not paused is wiped on start-up', async () => {
    const chrome = installChrome({
      tabs: [{ id: 7, url: 'https://a.com', active: true, windowId: 1 }],
    });
    chrome.storage.session._store.utsPendingBadgeTab = 7;
    chrome.action._badgeText.set(7, '✕');

    const bg = requireSource('background.js');
    await bg.initPromise;
    await flush();

    expect(chrome.action._getBadgeText(7)).toBe('');
    expect(bg.BADGE_PENDING_KEY in chrome.storage.session._store).toBe(false);
  });

  test('start-up touches no badge when nothing is paused or pending', async () => {
    const { chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://a.com', active: true, windowId: 1 }],
    });
    await flush();
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
  });
});

describe('checkTabs', () => {
  test('returns early when auto-suspend is disabled', async () => {
    const { chrome } = loadBackground();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 0 };
    await bgCheck(chrome);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  test('suspends an idle, unprotected tab', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 1, url: 'https://active.com', active: true, windowId: 1, lastAccessed: Date.now() },
        { id: 2, url: 'https://idle.com', active: false, windowId: 1, lastAccessed: old },
      ],
      windows: [{ id: 1, focused: true }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 30, useNativeDiscard: false, fixFaviconEnabled: false };
    await bg.checkTabs();
    expect(chrome._getTab(2).url).toContain('suspended.html');
    expect(chrome._getTab(1).url).toBe('https://active.com');
  });

  test('audible protection refreshes the idle timestamp so a flicker does not suspend', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://music.com', active: false, audible: true, windowId: 1, lastAccessed: old }],
      windows: [{ id: 1, focused: true }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 30, useNativeDiscard: false, fixFaviconEnabled: false };

    await bg.checkTabs();
    expect(chrome._getTab(1).url).toBe('https://music.com'); // protected by audio
    expect(bg.__getInternals().seenTimestamps[1]).toBeGreaterThan(old);

    // Audio flickers off (e.g. between tracks): the refreshed timestamp must
    // start a fresh idle countdown instead of suspending immediately.
    chrome._getTab(1).audible = false;
    await bg.checkTabs();
    expect(chrome._getTab(1).url).toBe('https://music.com');

    // Once genuinely idle past the deadline, it suspends normally.
    jest.advanceTimersByTime(31 * 60 * 1000);
    await bg.checkTabs();
    expect(chrome._getTab(1).url).toContain('suspended.html');
  });

  test('suspends a large idle backlog fully, processed in concurrent batches', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    const tabs = [];
    for (let i = 1; i <= 12; i++) {
      tabs.push({ id: i, url: `https://idle${i}.com`, active: false, windowId: 1, lastAccessed: old });
    }
    const { bg, chrome } = loadBackground({ tabs, windows: [{ id: 1, focused: true }] });
    chrome.storage.sync._store[STORAGE_KEY] = {
      autoSuspendMinutes: 30,
      useNativeDiscard: false,
      fixFaviconEnabled: false,
      suspendBatchConcurrency: 5, // 12 targets -> batches of 5, 5, 2
    };
    await bg.checkTabs();
    for (let i = 1; i <= 12; i++) {
      expect(chrome._getTab(i).url).toContain('suspended.html');
    }
  });

  test('unsuspending protection expires after its TTL', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://x.com', active: false, windowId: 1, lastAccessed: old }],
      windows: [{ id: 1, focused: true }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 30, useNativeDiscard: false, fixFaviconEnabled: false };
    // A failed unsuspend navigation left the tab marked: protected while fresh.
    bg.markTabUnsuspending(1);
    await bg.checkTabs();
    expect(chrome._getTab(1).url).toBe('https://x.com');
    // After the TTL the stale mark no longer exempts the idle tab.
    jest.advanceTimersByTime(6 * 60 * 1000);
    await bg.checkTabs();
    expect(chrome._getTab(1).url).toContain('suspended.html');
  });

  test('the focused window\'s active tab is stamped on every scan', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: 'https://work.com', active: true, windowId: 1, lastAccessed: old }],
      windows: [{ id: 1, focused: true }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 30, useNativeDiscard: false, fixFaviconEnabled: false };
    await bg.checkTabs();
    expect(chrome._getTab(1).url).toBe('https://work.com');
    expect(bg.__getInternals().seenTimestamps[1]).toBeGreaterThan(old);
  });

  test('the remembered last active tab is stamped while the browser is unfocused', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 42, url: 'https://keep.com', active: true, windowId: 1, lastAccessed: old }],
      windows: [{ id: 1, focused: false }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = {
      autoSuspendMinutes: 30,
      useNativeDiscard: false,
      fixFaviconEnabled: false,
      rememberLastActiveTab: true,
    };
    chrome.storage.session._store.utsLastActiveTab = 42;
    await chrome.alarms.onAlarm.trigger({ name: 'utsAutoCheck' });
    expect(chrome._getTab(42).url).toBe('https://keep.com');
    expect(bg.__getInternals().seenTimestamps[42]).toBeGreaterThan(old);
  });

  async function bgCheck(chrome) {
    // helper to run checkTabs via the exported function on a freshly loaded module
    const mod = require('../background.js');
    await mod.checkTabs();
  }
});

describe('cold-start initialization gate', () => {
  test('onActivated stamps the previous tab using state restored from session', async () => {
    const oldTs = Date.now() - 60 * 60 * 1000;
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 100, url: 'https://a.com', active: true, windowId: 1 }],
      windows: [{ id: 1, focused: true }],
    });
    // Persisted state from the previous service worker life: tab 100 was the
    // active tab of window 1, last seen an hour ago. The activation event that
    // wakes the worker arrives before the async restore has finished.
    chrome.storage.session._store.utsSeen = { 100: oldTs };
    chrome.storage.session._store.utsLastActiveTabPerWindow = {
      1: { tabId: 100, timestamp: oldTs },
    };
    await chrome.tabs.onActivated.trigger({ tabId: 200, windowId: 1 });
    const internals = bg.__getInternals();
    expect(internals.initDone).toBe(true);
    // The handler must have seen the restored per-window map and stamped the
    // previously active tab as just-left — not left it an hour stale.
    expect(internals.seenTimestamps[100]).toBeGreaterThan(oldTs);
    expect(internals.lastActiveTabId).toBe(200);
  });

  test('alarm-driven checkTabs sees the restored last active tab when no window is focused', async () => {
    const old = Date.now() - 60 * 60 * 1000;
    const { chrome } = loadBackground({
      tabs: [{ id: 42, url: 'https://keep.com', active: true, windowId: 1, lastAccessed: old }],
      windows: [{ id: 1, focused: false }], // user is in another application
    });
    chrome.storage.sync._store[STORAGE_KEY] = {
      autoSuspendMinutes: 30,
      useNativeDiscard: false,
      fixFaviconEnabled: false,
      rememberLastActiveTab: true,
    };
    chrome.storage.session._store.utsLastActiveTab = 42;
    await chrome.alarms.onAlarm.trigger({ name: 'utsAutoCheck' });
    // Without the gate checkTabs raced the restore, saw lastActiveTabId=null,
    // and suspended the remembered tab.
    expect(chrome._getTab(42).url).toBe('https://keep.com');
  });

  test('onFocusChanged persists the focused window id', async () => {
    const { chrome } = loadBackground({ windows: [{ id: 5 }] });
    await chrome.windows.onFocusChanged.trigger(5);
    expect(chrome.storage.session._store.utsLastFocusedWindow).toBe(5);
  });

  test('cold-started focus switch stamps the previously focused window\'s active tab', async () => {
    const { bg, chrome } = loadBackground({
      tabs: [
        { id: 10, url: 'https://a.com', active: true, windowId: 1 },
        { id: 20, url: 'https://b.com', active: true, windowId: 2 },
      ],
      // By the time the worker wakes, Chrome already reports window 2 focused.
      windows: [{ id: 1, focused: false }, { id: 2, focused: true }],
    });
    // The previous worker life recorded window 1 as the focused window.
    chrome.storage.session._store.utsLastFocusedWindow = 1;
    await chrome.windows.onFocusChanged.trigger(2);
    const internals = bg.__getInternals();
    // Window 1's active tab must be stamped as just-left; only the persisted
    // focused-window id can identify window 1 (the live query reports 2).
    expect(internals.seenTimestamps[10]).toBeGreaterThan(0);
    expect(internals.lastFocusedWindowId).toBe(2);
  });

  test('a failed restore opens the gate so handlers still run', async () => {
    const chrome = installChrome({});
    chrome.storage.session.get.mockImplementation(() => Promise.reject(new Error('boom')));
    const bg = requireSource('background.js');
    await chrome.tabs.onActivated.trigger({ tabId: 1, windowId: 1 });
    expect(bg.__getInternals().initDone).toBe(true);
    expect(bg.__getInternals().seenTimestamps[1]).toBeGreaterThan(0);
  });
});

describe('re-discard queue & favicon processor', () => {
  test('processQueuedReDiscardTabs clears queues when native discard is off', async () => {
    const { bg, chrome } = loadBackground();
    chrome.storage.sync._store[STORAGE_KEY] = { useNativeDiscard: false };
    bg.__getInternals().pendingReDiscardTabIds.add(1);
    await bg.processQueuedReDiscardTabs();
    expect(bg.__getInternals().pendingReDiscardTabIds.size).toBe(0);
  });

  test('processQueuedReDiscardTabs discards a queued suspended inactive tab', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: suspendedUrl({ _extId: extId }, 'https://a.com'), active: false, discarded: false, status: 'complete', favIconUrl: 'https://a.com/f.ico', windowId: 1 }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { useNativeDiscard: true, fixFaviconBatchSize: 0, fixFaviconMaxRetries: 5 };
    bg.__getInternals().pendingReDiscardTabIds.add(1);
    await bg.processQueuedReDiscardTabs();
    await flush();
    expect(chrome.tabs.discard).toHaveBeenCalledWith(1);
  });

  test('fixFaviconProcessor reloads and discards an inactive suspended tab', async () => {
    const extId = 'testextensionid';
    const { bg, chrome } = loadBackground({
      tabs: [{ id: 1, url: suspendedUrl({ _extId: extId }, 'https://a.com'), active: false, status: 'complete', favIconUrl: 'https://a.com/f.ico', windowId: 1 }],
    });
    chrome.storage.sync._store[STORAGE_KEY] = { fixFaviconEnabled: true, useNativeDiscard: true };
    bg.__getInternals().fixFaviconTabs.add(1);
    bg.fixFaviconProcessor.start();
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();
    expect(chrome.tabs.reload).toHaveBeenCalledWith(1);
    bg.fixFaviconProcessor.stop();
    expect(bg.fixFaviconProcessor.isRunning).toBe(false);
  });
});
