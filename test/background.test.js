/**
 * Tests for background.js — the MV3 service worker core.
 * Each test re-loads the module with a fresh chrome mock so module-level state
 * is isolated. Fake timers drive the various debounce/timeout paths.
 */
const { loadBackground } = require('./helpers/load-source');

const STORAGE_KEY = 'utsSettings';

async function flush(times = 14) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Trigger the async onMessage handler and resolve its sendResponse. */
async function sendMessage(chrome, msg, sender = {}) {
  const sendResponse = jest.fn();
  chrome.runtime.onMessage.triggerSync(msg, sender, sendResponse);
  await flush();
  return sendResponse;
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
    expect(chrome.storage.session.set).toHaveBeenCalledWith({ utsSeen: expect.objectContaining({ 1: 111 }) });

    bg.markTabSeen(2, 222);
    bg.saveSeenTimestamps();
    chrome.storage.session.set.mockClear();
    bg.flushSeenTimestampsNow();
    expect(chrome.storage.session.set).toHaveBeenCalled();
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
    await bg.unsuspendAllTabs(false);
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
    await bg.unsuspendAllTabsInWindow(1);
    expect(chrome._getTab(1).url).toBe('https://a.com');
    expect(chrome._getTab(2).url).toContain('suspended.html'); // other window untouched
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

  test('onMessage: checkTempWhitelist reports membership', async () => {
    const { bg, chrome } = loadBackground();
    bg.setTempWhitelistFromStorageValue(['https://t.com']);
    const r = await sendMessage(chrome, { command: 'checkTempWhitelist', url: 'https://t.com' });
    expect(r).toHaveBeenCalledWith({ whitelisted: true });
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
    const { bg, chrome } = loadBackground();
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
    bg.__getInternals().unsuspendingTabs.add(1);
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
    const { bg, chrome } = loadBackground();
    const internals = bg.__getInternals();
    internals.unsuspendingTabs.add(7);
    internals.fixFaviconTabs.add(7);
    internals.seenTimestamps[7] = 1;
    bg.setLastActiveTabInWindow(2, { tabId: 7, timestamp: 1 });
    await chrome.tabs.onRemoved.trigger(7, { windowId: 2 });
    expect(internals.unsuspendingTabs.has(7)).toBe(false);
    expect(internals.fixFaviconTabs.has(7)).toBe(false);
    expect(7 in internals.seenTimestamps).toBe(false);
    expect(internals.lastActiveTabPerWindow.has(2)).toBe(false);
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

  async function bgCheck(chrome) {
    // helper to run checkTabs via the exported function on a freshly loaded module
    const mod = require('../background.js');
    await mod.checkTabs();
  }
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
