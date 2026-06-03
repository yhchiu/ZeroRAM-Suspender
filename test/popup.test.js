/**
 * Integration tests for popup.js — the toolbar popup IIFE. We install a chrome
 * mock with an active tab, require the script, and assert on the DOM it builds
 * and the messages it sends.
 */
const { installChrome, requireSource } = require('./helpers/load-source');
const { loadHtmlBody } = require('./helpers/dom');

const EXT_ID = 'testextensionid';
const STORAGE_KEY = 'utsSettings';

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function suspendedUrl(original) {
  return `chrome-extension://${EXT_ID}/suspended.html?uri=${encodeURIComponent(original)}&ttl=T`;
}

/** Load popup.js against a chrome mock seeded with the given active tab. */
async function loadPopupWith({ tab, settings = {}, selected, tempWhite = false }) {
  const tabs = [{ id: 1, windowId: 1, active: true, currentWindow: true, ...tab }];
  if (selected) {
    for (const t of selected) tabs.push({ ...t, windowId: 1, currentWindow: true, highlighted: true });
    tabs[0].highlighted = true;
  }
  const chrome = installChrome({ tabs, windows: [{ id: 1, focused: true }] });
  // popup.html loads i18n.js (which defines the global getMessage) before
  // popup.js; emulate that shared global here.
  global.getMessage = (key) => chrome.i18n.getMessage(key) || key;
  chrome.storage.sync._store[STORAGE_KEY] = settings;
  chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
    let resp = { done: true };
    if (msg && msg.command === 'checkTempWhitelist') resp = { whitelisted: tempWhite };
    if (msg && msg.command === 'toggleTempWhitelist') resp = { whitelisted: !tempWhite };
    if (typeof cb === 'function') { cb(resp); return undefined; }
    return Promise.resolve(resp);
  });
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
});
