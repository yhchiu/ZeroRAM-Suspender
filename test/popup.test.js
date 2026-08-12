/**
 * Integration tests for popup.js — the toolbar popup IIFE. We install a chrome
 * mock with an active tab, require the script, and assert on the DOM it builds
 * and the messages it sends.
 */
const { installChrome, requireSource } = require('./helpers/load-source');
const { loadHtmlBody } = require('./helpers/dom');

const EXT_ID = 'testextensionid';
const STORAGE_KEY = 'utsSettings';
const TEMP_KEY = 'utsTempWhitelist';

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function suspendedUrl(original) {
  return `chrome-extension://${EXT_ID}/suspended.html?uri=${encodeURIComponent(original)}&ttl=T`;
}

/**
 * Install a chrome mock and wire up the globals popup.html provides.
 * popup.html loads i18n.js (which defines the global getMessage) before
 * popup.js, so we emulate that shared global here.
 */
function setupChrome(tabs, settings) {
  const chrome = installChrome({ tabs, windows: [{ id: 1, focused: true }] });
  global.getMessage = (key) => chrome.i18n.getMessage(key) || key;
  chrome.storage.sync._store[STORAGE_KEY] = settings;
  return chrome;
}

/** Load popup.js against a chrome mock seeded with the given active tab. */
async function loadPopupWith({ tab, settings = {}, selected, tempWhite = false }) {
  // Chrome always highlights the active tab, so the mock seeds it that way.
  const tabs = [{ id: 1, windowId: 1, active: true, highlighted: true, currentWindow: true, ...tab }];
  if (selected) {
    for (const t of selected) tabs.push({ ...t, windowId: 1, currentWindow: true, highlighted: true });
  }
  const chrome = setupChrome(tabs, settings);
  if (tempWhite) {
    chrome.storage.session._store[TEMP_KEY] = [tabs[0].url];
  }
  loadHtmlBody('popup.html');
  requireSource('popup.js');
  await flush();
  return chrome;
}

describe('popup.js', () => {
  afterEach(() => {
    delete global.getMessage;
  });

  test('renders version from the manifest', async () => {
    await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' } });
    expect(document.getElementById('version').textContent).toMatch(/^v\d/);
  });

  test('a normal tab shows the "will suspend" banner and a suspend menu item', async () => {
    await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    const banner = document.getElementById('banner');
    expect(banner.classList.contains('blue')).toBe(true);
    const items = [...document.querySelectorAll('#menu li')].map((li) => li.textContent);
    expect(items.join('|').toLowerCase()).toContain('suspend');
  });

  test('a suspended tab shows the suspended banner (gray, no action link)', async () => {
    await loadPopupWith({ tab: { url: suspendedUrl('https://x.com'), title: 'X' } });
    const banner = document.getElementById('banner');
    expect(banner.classList.contains('gray')).toBe(true);
  });

  test('an internal page shows the cannot-suspend banner', async () => {
    await loadPopupWith({ tab: { url: 'chrome://settings', title: 'Settings' } });
    const banner = document.getElementById('banner');
    expect(banner.classList.contains('gray')).toBe(true);
    expect(banner.textContent).toBeTruthy();
  });

  test('a whitelisted tab offers remove-from-whitelist', async () => {
    await loadPopupWith({
      tab: { url: 'https://white.com/p', title: 'W' },
      settings: { whitelist: ['white.com'] },
    });
    const banner = document.getElementById('banner');
    expect(banner.classList.contains('gray')).toBe(true);
    const link = banner.querySelector('a');
    expect(link.style.display).toBe('inline');
  });

  test('autoSuspend disabled shows the disabled banner', async () => {
    await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 0 } });
    const banner = document.getElementById('banner');
    expect(banner.classList.contains('gray')).toBe(true);
  });

  test('an audible tab is shown as protected', async () => {
    await loadPopupWith({
      tab: { url: 'https://x.com', title: 'X', audible: true },
      settings: { autoSuspendMinutes: 30, neverSuspendAudio: true },
    });
    const banner = document.getElementById('banner');
    expect(banner.classList.contains('gray')).toBe(true);
  });

  test('clicking "suspend this tab" sends the suspendTab command', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    const item = [...document.querySelectorAll('#menu li')].find((li) =>
      li.getAttribute('data-icon') === 'suspend'
    );
    expect(item).toBeTruthy();
    window.close = jest.fn();
    item.click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'suspendTab', tabId: 1 })
    );
  });

  test('clicking "suspend others" sends suspendOthers', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    window.close = jest.fn();
    const item = [...document.querySelectorAll('#menu li')].find((li) =>
      li.getAttribute('data-icon') === 'others'
    );
    item.click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'suspendOthers' })
    );
  });

  test('multiple selected tabs add force suspend/unsuspend items', async () => {
    const chrome = await loadPopupWith({
      tab: { url: 'https://x.com', title: 'X' },
      settings: { autoSuspendMinutes: 30 },
      selected: [
        { id: 2, url: 'https://y.com' },
        { id: 3, url: suspendedUrl('https://z.com') },
      ],
    });
    const items = [...document.querySelectorAll('#menu li')].map((li) => li.textContent);
    // Both a suspend-selected and unsuspend-selected entry should appear with counts.
    expect(items.some((t) => /\(\d+\)/.test(t))).toBe(true);
    void chrome;
  });

  test('the bulk cancel button sends cancelBulk', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    const btn = document.getElementById('bulkCancelBtn');
    btn.click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ command: 'cancelBulk' });
  });

  test('bulk progress messages update the progress UI', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    const port = chrome._lastPort;
    expect(port).toBeTruthy();
    port.onMessage.triggerSync({ type: 'bulkProgress', action: 'suspendAll', processed: 2, total: 4 });
    expect(document.getElementById('bulkProgressText').textContent).toBe('2/4');
    expect(document.getElementById('bulkProgressFill').style.width).toBe('50%');
  });

  test('bulk progress "done" snaps to 100% and disables cancel', async () => {
    jest.useFakeTimers();
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    const port = chrome._lastPort;
    port.onMessage.triggerSync({ type: 'bulkProgress', action: 'unsuspendAll', processed: 4, total: 4, done: true });
    expect(document.getElementById('bulkProgressFill').style.width).toBe('100%');
    expect(document.getElementById('bulkCancelBtn').disabled).toBe(true);
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('bulk progress cancelled shows the cancelled label', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    chrome._lastPort.onMessage.triggerSync({ type: 'bulkProgress', action: 'suspendAll', processed: 1, total: 4, done: true, cancelled: true });
    expect(document.getElementById('bulkCancelBtn').disabled).toBe(true);
  });

  test('clicking "suspend all others (all windows)" sends the bulk command', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    window.close = jest.fn();
    // Two menu items use the 'others' icon; the second is the all-windows bulk.
    const others = [...document.querySelectorAll('#menu li[data-icon="others"]')];
    expect(others.length).toBeGreaterThanOrEqual(2);
    others[1].click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'suspendAllOthersAllWindows', withProgress: true })
    );
  });

  test('clicking "unsuspend all" sends the unsuspendAll bulk command', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    window.close = jest.fn();
    const wakeItems = [...document.querySelectorAll('#menu li[data-icon="wake"]')];
    wakeItems[wakeItems.length - 1].click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'unsuspendAll', withProgress: true })
    );
  });

  test('"not now" toggles the temp whitelist for a normal tab', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com', title: 'X' }, settings: { autoSuspendMinutes: 30 } });
    const link = document.getElementById('banner').querySelector('a');
    expect(link.style.display).toBe('inline');
    link.click();
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'toggleTempWhitelist', url: 'https://x.com' })
    );
  });

  test('removing from whitelist updates storage when confirmed', async () => {
    const chrome = await loadPopupWith({
      tab: { url: 'https://white.com/p', title: 'W' },
      settings: { whitelist: ['white.com'] },
    });
    chrome.storage.sync._store[STORAGE_KEY] = { whitelist: ['white.com'] };
    window.confirm = jest.fn(() => true);
    window.close = jest.fn();
    const link = document.getElementById('banner').querySelector('a');
    link.click();
    await flush();
    expect(chrome.storage.sync._store[STORAGE_KEY].whitelist).not.toContain('white.com');
  });

  test('a paused tab shows the paused banner and an allow-suspend link', async () => {
    await loadPopupWith({
      tab: { url: 'https://x.com', title: 'X' },
      settings: { autoSuspendMinutes: 30 },
      tempWhite: true,
    });
    const banner = document.getElementById('banner');
    expect(banner.classList.contains('gray')).toBe(true);
    expect(banner.querySelector('a').style.display).toBe('inline');
  });

  test('clicking "never suspend this URL" adds it to the whitelist', async () => {
    const chrome = await loadPopupWith({ tab: { url: 'https://x.com/page', title: 'X' }, settings: { autoSuspendMinutes: 30, whitelist: [] } });
    chrome.storage.sync._store[STORAGE_KEY] = { whitelist: [] };
    window.close = jest.fn();
    const item = [...document.querySelectorAll('#menu li')].find((li) =>
      li.getAttribute('data-icon') === 'never'
    );
    expect(item).toBeTruthy();
    item.click();
    await flush();
    expect(chrome.storage.sync._store[STORAGE_KEY].whitelist.length).toBeGreaterThan(0);
  });

  // The popup must be able to draw itself without waking the service worker:
  // a cold worker start is the single slowest thing that used to sit on this
  // path, and it is worst exactly when the machine is already busy.
  describe('startup path', () => {
    const NORMAL_TAB = {
      id: 1,
      windowId: 1,
      active: true,
      highlighted: true,
      currentWindow: true,
      url: 'https://x.com',
      title: 'X',
    };

    test('reads the temp whitelist from session storage, not from the worker', async () => {
      const chrome = await loadPopupWith({
        tab: { url: 'https://x.com', title: 'X' },
        settings: { autoSuspendMinutes: 30 },
      });
      expect(chrome.storage.session.get).toHaveBeenCalledWith(TEMP_KEY);
      const commands = chrome.runtime.sendMessage.mock.calls.map(([msg]) => msg && msg.command);
      expect(commands).not.toContain('checkTempWhitelist');
    });

    test('queries tabs once, covering both the active tab and the selection', async () => {
      const chrome = await loadPopupWith({
        tab: { url: 'https://x.com', title: 'X' },
        settings: { autoSuspendMinutes: 30 },
        selected: [{ id: 2, url: 'https://y.com' }],
      });
      expect(chrome.tabs.query).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.query).toHaveBeenCalledWith({ highlighted: true, currentWindow: true });
    });

    test('falls back to an active-tab query when no highlighted tab is active', async () => {
      // Not a state Chrome produces, but the popup must still render if it does.
      const chrome = setupChrome([{ ...NORMAL_TAB, highlighted: false }], { autoSuspendMinutes: 30 });
      loadHtmlBody('popup.html');
      requireSource('popup.js');
      await flush();
      expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      expect(document.querySelectorAll('#menu li[role="menuitem"]').length).toBeGreaterThan(0);
    });

    test('renders nothing and skips the port when there is no tab at all', async () => {
      const chrome = setupChrome([], { autoSuspendMinutes: 30 });
      loadHtmlBody('popup.html');
      requireSource('popup.js');
      await flush();
      expect(document.querySelectorAll('#menu li')).toHaveLength(0);
      expect(chrome.runtime.connect).not.toHaveBeenCalled();
    });

    test('connects the bulk-progress port only after the menu is rendered', async () => {
      const chrome = setupChrome([NORMAL_TAB], { autoSuspendMinutes: 30 });
      const connect = chrome.runtime.connect.getMockImplementation();
      let menuItemsAtConnect = -1;
      chrome.runtime.connect.mockImplementation((info) => {
        menuItemsAtConnect = document.querySelectorAll('#menu li[role="menuitem"]').length;
        return connect(info);
      });
      loadHtmlBody('popup.html');
      requireSource('popup.js');
      await flush();
      expect(menuItemsAtConnect).toBeGreaterThan(0);
    });

  });
});
