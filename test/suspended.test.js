/**
 * Integration tests for suspended.js — the placeholder page IIFE. We set the
 * page URL (so query params parse), install the chrome mock, require the
 * script, and assert on DOM, favicon handling, and unsuspend behaviour.
 */
const { installChrome, requireSource } = require('./helpers/load-source');
const { loadHtmlBody } = require('./helpers/dom');

const EXT_ID = 'testextensionid';
const STORAGE_KEY = 'utsSettings';

async function flush(times = 25) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Point the document at a suspended.html URL carrying the given params. */
function setLocation(params) {
  const qs = new URLSearchParams(params).toString();
  window.history.replaceState({}, '', `/suspended.html?${qs}`);
}

async function loadSuspendedWith(params, { settings = {}, fetchOk = true } = {}) {
  const chrome = installChrome({ tabs: [] });
  chrome.storage.sync._store[STORAGE_KEY] = settings;
  if (!fetchOk) {
    global.fetch.mockImplementation(() => Promise.resolve({ ok: false, status: 404 }));
  }
  loadHtmlBody('suspended.html');
  setLocation(params);
  requireSource('suspended.js');
  await flush();
  return chrome;
}

describe('suspended.js', () => {
  const ORIG = 'https://example.com/page';

  test('populates title and original URL from query params', async () => {
    await loadSuspendedWith({ uri: ORIG, ttl: 'My Page' });
    expect(document.title).toBe('My Page');
    expect(document.getElementById('origTitle').textContent).toBe('My Page');
    const urlEl = document.getElementById('origUrl');
    expect(urlEl.textContent).toBe(ORIG);
    expect(urlEl.href).toBe(ORIG);
  });

  test('fetched favicon is drawn to canvas and faviconReady is sent', async () => {
    global.__MockImage.mode = 'load';
    const chrome = await loadSuspendedWith({ uri: ORIG, ttl: 'X' });
    await flush();
    const link = document.querySelector('link[rel="icon"]');
    expect(link).toBeTruthy();
    expect(link.href).toContain('data:image/png'); // transparent canvas output
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ command: 'faviconReady' });
  });

  test('title-prefix mode adds the sleep emoji and keeps the real favicon (no transparency)', async () => {
    const chrome = await loadSuspendedWith(
      { uri: ORIG, ttl: 'My Page', favicon: 'https://example.com/fav.ico' },
      { settings: { suspendedIndicatorMode: 'titlePrefix' } }
    );
    await flush();
    // Tab strip title gets the sleep prefix; the page still shows the clean title.
    expect(document.title).toBe('💤 My Page');
    expect(document.getElementById('origTitle').textContent).toBe('My Page');
    const link = document.querySelector('link[rel="icon"]');
    expect(link).toBeTruthy();
    // Real favicon via the _favicon API, never a transparent canvas data: URL.
    expect(link.href).toContain('/_favicon/');
    expect(link.href).not.toContain('data:image/png');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ command: 'faviconReady' });
  });

  test('favicon mode is the default when no indicator setting is stored', async () => {
    global.__MockImage.mode = 'load';
    await loadSuspendedWith({ uri: ORIG, ttl: 'Y' }); // no settings → default
    await flush();
    expect(document.title).toBe('Y'); // no sleep prefix
    const link = document.querySelector('link[rel="icon"]');
    expect(link.href).toContain('data:image/png'); // transparent favicon
  });

  test('falls back to provided favicon when fetch fails', async () => {
    const chrome = await loadSuspendedWith(
      { uri: ORIG, ttl: 'X', favicon: 'https://example.com/fav.ico' },
      { fetchOk: false }
    );
    await flush();
    const link = document.querySelector('link[rel="icon"]');
    expect(link).toBeTruthy();
    expect(link.href).toBe('https://example.com/fav.ico');
    void chrome;
  });

  test('falls back when the favicon image errors', async () => {
    global.__MockImage.mode = 'error';
    await loadSuspendedWith({ uri: ORIG, ttl: 'X', favicon: 'https://example.com/fav.ico' });
    await flush();
    const link = document.querySelector('link[rel="icon"]');
    expect(link.href).toBe('https://example.com/fav.ico');
  });

  test('applies click-anywhere setting to the body class', async () => {
    await loadSuspendedWith({ uri: ORIG, ttl: 'X' }, { settings: { clickAnywhereToUnsuspend: true } });
    await flush();
    expect(document.body.classList.contains('click-anywhere-unsuspend')).toBe(true);
  });

  test('Ctrl+Shift+Z navigates to the original (http) URL', async () => {
    jest.useFakeTimers();
    const chrome = await loadSuspendedWith({ uri: ORIG, ttl: 'X' });
    const evt = new window.KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'Z' });
    document.dispatchEvent(evt);
    jest.advanceTimersByTime(200);
    // startUnsuspending notification is sent to the background.
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'startUnsuspending' })
    );
    jest.useRealTimers();
  });

  test('mousedown outside origSection triggers unsuspend', async () => {
    jest.useFakeTimers();
    const chrome = await loadSuspendedWith({ uri: ORIG, ttl: 'X' });
    const evt = new window.MouseEvent('mousedown', { buttons: 1, bubbles: true });
    Object.defineProperty(evt, 'target', { value: document.body });
    document.dispatchEvent(evt);
    jest.advanceTimersByTime(200);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'startUnsuspending' })
    );
    jest.useRealTimers();
  });

  test('falls back to original favicon when the canvas is tainted', async () => {
    global.__MockImage.mode = 'load';
    HTMLCanvasElement.prototype.toDataURL = jest.fn(() => {
      throw new Error('tainted canvas');
    });
    await loadSuspendedWith({ uri: ORIG, ttl: 'X', favicon: 'https://example.com/fav.ico' });
    await flush();
    const link = document.querySelector('link[rel="icon"]');
    expect(link.href).toBe('https://example.com/fav.ico');
  });

  test('mousedown inside origSection does not unsuspend by default', async () => {
    jest.useFakeTimers();
    const chrome = await loadSuspendedWith({ uri: ORIG, ttl: 'X' });
    chrome.runtime.sendMessage.mockClear();
    const origSection = document.getElementById('origSection');
    const evt = new window.MouseEvent('mousedown', { buttons: 1, bubbles: true });
    Object.defineProperty(evt, 'target', { value: origSection });
    document.dispatchEvent(evt);
    jest.advanceTimersByTime(200);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'startUnsuspending' })
    );
    jest.useRealTimers();
  });

  test('non-primary mouse button is ignored', async () => {
    jest.useFakeTimers();
    const chrome = await loadSuspendedWith({ uri: ORIG, ttl: 'X' });
    chrome.runtime.sendMessage.mockClear();
    const evt = new window.MouseEvent('mousedown', { buttons: 2, bubbles: true });
    Object.defineProperty(evt, 'target', { value: document.body });
    document.dispatchEvent(evt);
    jest.advanceTimersByTime(200);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('click-anywhere mode unsuspends from inside origSection', async () => {
    jest.useFakeTimers();
    const chrome = await loadSuspendedWith({ uri: ORIG, ttl: 'X' }, { settings: { clickAnywhereToUnsuspend: true } });
    await flush();
    chrome.runtime.sendMessage.mockClear();
    const origSection = document.getElementById('origSection');
    const evt = new window.MouseEvent('mousedown', { buttons: 1, bubbles: true });
    Object.defineProperty(evt, 'target', { value: origSection });
    document.dispatchEvent(evt);
    jest.advanceTimersByTime(200);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'startUnsuspending' })
    );
    jest.useRealTimers();
  });

  test('file:// URLs unsuspend via the unsuspendNavigate command', async () => {
    jest.useFakeTimers();
    const chrome = await loadSuspendedWith({ uri: 'file:///C:/doc.pdf', ttl: 'Doc' });
    chrome.runtime.sendMessage.mockClear();
    const evt = new window.KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'Z' });
    document.dispatchEvent(evt);
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'unsuspendNavigate', url: 'file:///C:/doc.pdf' }),
      expect.any(Function)
    );
    jest.useRealTimers();
  });
});
