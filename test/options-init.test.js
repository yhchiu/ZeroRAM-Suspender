/**
 * Tests for options.js startup wiring and the remaining flows: the
 * DOMContentLoaded initializer, changelog loading, session/settings preview &
 * import, and the suspended-tab viewer click/error handlers.
 */
const { loadOptions } = require('./helpers/load-source');

const EXT_ID = 'testextensionid';
const STORAGE_KEY = 'utsSettings';

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function suspendedUrl(original, title = 'T') {
  return `chrome-extension://${EXT_ID}/suspended.html?uri=${encodeURIComponent(original)}&ttl=${encodeURIComponent(title)}`;
}

function fileWith(name, content) {
  return { name, text: () => Promise.resolve(content) };
}

function setInputFiles(id, files) {
  const el = document.getElementById(id);
  Object.defineProperty(el, 'files', { value: files, configurable: true });
  return el;
}

describe('startup initialization', () => {
  test('DOMContentLoaded wires navigation, version, and settings load', async () => {
    const { chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 20 };

    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flush();

    // setVersion populated the version element from the manifest.
    expect(document.getElementById('version').textContent).toBeTruthy();
    // load() populated the auto-suspend field.
    expect(document.getElementById('autoSuspend').value).toBe('20');
    // Save button is present and wired (no throw on click path).
    expect(document.getElementById('saveBtn')).toBeTruthy();
  });
});

describe('changelog', () => {
  test('loadChangelog fetches CHANGELOG.json and renders version cards', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    const commits = [
      { commit: { message: 'chore: update version to 1.5.0', author: { date: '2024-03-01T00:00:00Z' } }, sha: 'aaaaaaa', html_url: 'https://gh/a' },
      { commit: { message: 'feat: add cool thing', author: { date: '2024-03-01T00:00:00Z' } }, sha: 'bbbbbbb', html_url: 'https://gh/b' },
      { commit: { message: 'fix: squash bug', author: { date: '2024-03-01T00:00:00Z' } }, sha: 'ccccccc', html_url: 'https://gh/c' },
    ];
    global.fetch.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(commits) })
    );
    await options.loadChangelog();
    await flush();
    const content = document.getElementById('changelogContent');
    expect(content.innerHTML).toContain('1.5.0');
    expect(content.innerHTML.toLowerCase()).toContain('cool thing');
  });

  test('loadChangelog shows an error state when the fetch fails', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    global.fetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500 }));
    await options.loadChangelog();
    await flush();
    expect(document.getElementById('changelogContent').innerHTML).toContain('failedToLoadChanges');
  });
});

describe('session preview', () => {
  test('previewSession renders a parsed JSON session', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    const json = JSON.stringify([[{ title: 'Page A', url: 'https://a.com' }]]);
    setInputFiles('sessionFileInput', [fileWith('s.json', json)]);
    await options.previewSession();
    await flush();
    const preview = document.getElementById('sessionPreviewContent');
    expect(preview.innerHTML).toContain('Page A');
    expect(document.getElementById('sessionPreview').style.display).toBe('block');
  });

  test('previewSession warns when no file is selected', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    setInputFiles('sessionFileInput', []);
    await options.previewSession();
    await flush();
    // No preview shown.
    expect(document.getElementById('sessionPreview').style.display).not.toBe('block');
  });
});

describe('settings import', () => {
  const validSettings = {
    autoSuspendMinutes: 25,
    useNativeDiscard: true,
    neverSuspendAudio: true,
    neverSuspendPinned: true,
    neverSuspendActive: false,
    whitelist: ['x.com'],
    themeMode: 'dark',
    version: '1.6.0',
    exportedAt: '2024-01-01T00:00:00Z',
    shortcuts: [{ name: '01-toggle-suspend', shortcut: 'Ctrl+Shift+Z' }],
  };

  test('previewImportSettings renders a human-readable summary', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    setInputFiles('settingsFileInput', [fileWith('settings.json', JSON.stringify(validSettings))]);
    await options.previewImportSettings();
    await flush();
    const content = document.getElementById('importSettingsPreviewContent');
    expect(content.textContent).toContain('1.6.0');
    expect(document.getElementById('importSettingsPreview').style.display).toBe('block');
  });

  test('previewImportSettings rejects an invalid settings file', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    setInputFiles('settingsFileInput', [fileWith('settings.json', JSON.stringify({ nope: true }))]);
    await options.previewImportSettings();
    await flush();
    expect(document.getElementById('importSettingsPreview').style.display).not.toBe('block');
  });

  test('importSettings persists every exported setting key and reloads the form', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    options.initializeElements();
    const expectedSettings = {
      ...options.getDefaultSettings(),
      autoSuspendMinutes: 25,
      whitelist: ['x.com'],
      themeMode: 'dark',
    };
    const exportedSettings = {
      ...expectedSettings,
      version: '1.6.0',
      exportedAt: '2024-01-01T00:00:00Z',
      shortcuts: [{ name: '01-toggle-suspend', shortcut: 'Ctrl+Shift+Z' }],
    };
    setInputFiles('settingsFileInput', [fileWith('settings.json', JSON.stringify(exportedSettings))]);
    await options.importSettings();
    await flush();
    const storedSettings = chrome.storage.sync._store[STORAGE_KEY];
    expect(Object.keys(storedSettings).sort()).toEqual(Object.keys(options.getDefaultSettings()).sort());
    expect(storedSettings).toEqual(expectedSettings);
    expect(document.getElementById('autoSuspend').value).toBe('25');
  });

  test('importSettings reports an error for a malformed file', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    options.initializeElements();
    setInputFiles('settingsFileInput', [fileWith('settings.json', '{bad json')]);
    await options.importSettings();
    await flush();
    expect(chrome.storage.sync._store[STORAGE_KEY]).toBeUndefined();
  });
});

describe('viewer click & error handlers', () => {
  async function renderViewer() {
    jest.useFakeTimers();
    const { options, chrome } = loadOptions({
      tabs: [{ id: 1, url: suspendedUrl('https://a.com', 'A'), windowId: 1, discarded: false }],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.runtime.getURL.mockImplementation((p) => `chrome-extension://${EXT_ID}/${p}`);
    const promise = options.showSuspendedTabs();
    await jest.runAllTimersAsync();
    await promise;
    jest.useRealTimers();
    return { options, chrome };
  }

  test('clicking an unsuspend button sends unsuspendTab and removes the row', async () => {
    const { options, chrome } = await renderViewer();
    const btn = document.querySelector('.unsuspend-tab-btn');
    expect(btn).toBeTruthy();
    const evt = { target: btn, preventDefault: jest.fn() };
    await options.handleSuspendedTabsListClick(evt);
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'unsuspendTab', tabId: 1 })
    );
    expect(document.querySelectorAll('.suspended-tab-item').length).toBe(0);
  });

  test('clicking outside an unsuspend button is a no-op', async () => {
    const { options, chrome } = await renderViewer();
    chrome.runtime.sendMessage.mockClear();
    const evt = { target: document.body, preventDefault: jest.fn() };
    await options.handleSuspendedTabsListClick(evt);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('favicon error handler hides the broken image', () => {
    const { options } = loadOptions();
    const img = document.createElement('img');
    img.className = 'suspended-tab-favicon-img';
    options.handleSuspendedTabFaviconError({ target: img });
    expect(img.style.display).toBe('none');
  });

  test('resetSuspendedTabsInfo hides the viewer panel', () => {
    const { options } = loadOptions();
    const info = document.getElementById('suspendedTabsInfo');
    info.style.display = 'block';
    options.resetSuspendedTabsInfo();
    expect(info.style.display).toBe('none');
  });
});

describe('misc resets & loaders', () => {
  test('resetSessionPreviews and resetSettingsPreviews hide their panels', () => {
    const { options } = loadOptions();
    options.resetSessionPreviews();
    options.resetSettingsPreviews();
    expect(document.getElementById('sessionPreview').style.display).toBe('none');
    expect(document.getElementById('settingsPreview').style.display).toBe('none');
  });

  test('loadKeyboardShortcuts renders shortcuts from chrome.commands', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.commands.getAll = jest.fn(() =>
      Promise.resolve([{ name: '01-toggle-suspend', shortcut: 'Ctrl+Shift+Z', description: 'Toggle' }])
    );
    await options.loadKeyboardShortcuts();
    await flush();
    expect(document.getElementById('shortcutsContainer').innerHTML).toContain('Ctrl+Shift+Z');
  });

  test('loadWhitelist populates the whitelist textarea', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    options.initializeElements();
    chrome.storage.sync._store[STORAGE_KEY] = { whitelist: ['a.com', 'b.com'] };
    options.loadWhitelist(false);
    await flush();
    expect(document.getElementById('whitelistList').value).toBe('a.com\nb.com');
  });
});
