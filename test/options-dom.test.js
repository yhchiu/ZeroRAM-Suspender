/**
 * Integration tests for options.js DOM/async flows: migration scan & migrate,
 * session export/import, settings export/preview/reset, and the suspended-tab
 * viewer rendering. These drive the high-level entry points so the helper
 * functions they call are exercised transitively.
 */
const { loadOptions } = require('./helpers/load-source');

const EXT_ID = 'testextensionid';
const STORAGE_KEY = 'utsSettings';

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function readBlobText(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function suspendedUrl(original, title = 'T') {
  return `chrome-extension://${EXT_ID}/suspended.html?uri=${encodeURIComponent(original)}&ttl=${encodeURIComponent(title)}`;
}

describe('migration flows', () => {
  test('scanForExtensionTabs finds Marvellous tabs and renders them', async () => {
    const url = `chrome-extension://klbibkeccnjlkjkiokjodocebajanakg/suspended.html#ttl=${encodeURIComponent('Old Tab')}&uri=${encodeURIComponent('https://old.com')}`;
    const { options, chrome } = loadOptions({
      tabs: [
        { id: 1, url, windowId: 1 },
        { id: 2, url: 'https://normal.com', windowId: 1 },
      ],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    await options.scanForExtensionTabs('marvellous');
    await flush();
    const container = document.getElementById('tabsContainer');
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(1);
    const status = document.getElementById('migrationStatus');
    expect(status.textContent).toBeTruthy();
  });

  test('scanForExtensionTabs reports when nothing matches', async () => {
    const { options, chrome } = loadOptions({
      tabs: [{ id: 1, url: 'https://normal.com', windowId: 1 }],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    await options.scanForExtensionTabs('marvellous');
    await flush();
    const tabsList = document.getElementById('tabsList');
    expect(tabsList.style.display).toBe('none');
  });

  test('migrateSelectedTabs converts checked tabs to our suspended format', async () => {
    jest.useFakeTimers();
    const url = `chrome-extension://klbibkeccnjlkjkiokjodocebajanakg/suspended.html#ttl=${encodeURIComponent('Old')}&uri=${encodeURIComponent('https://old.com')}`;
    const { options, chrome } = loadOptions({ tabs: [{ id: 7, url, windowId: 1 }] });
    chrome.i18n.getMessage.mockImplementation((k) => k);

    await options.scanForExtensionTabs('marvellous');
    await Promise.resolve();
    const promise = options.migrateSelectedTabs('marvellous');
    await jest.runAllTimersAsync();
    await promise;

    expect(chrome.tabs.update).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ url: expect.stringContaining('suspended.html?uri=') })
    );
    jest.useRealTimers();
  });
});

describe('session flows', () => {
  test('getAllTabs maps suspended tabs back to their original info', async () => {
    const { options, chrome } = loadOptions({
      tabs: [
        { id: 1, url: suspendedUrl('https://a.com', 'A'), windowId: 1, title: 'sus' },
        { id: 2, url: 'https://b.com', title: 'B', windowId: 1 },
      ],
      windows: [{ id: 1 }],
    });
    chrome.runtime.getURL.mockImplementation((p) => `chrome-extension://${EXT_ID}/${p}`);
    const windowTabs = await options.getAllTabs();
    expect(windowTabs).toHaveLength(1);
    expect(windowTabs[0][0]).toMatchObject({ url: 'https://a.com', wasSuspended: true });
    expect(windowTabs[0][1]).toMatchObject({ url: 'https://b.com', wasSuspended: false });
  });

  test('previewExport renders TXT content', async () => {
    const { options, chrome } = loadOptions({
      tabs: [{ id: 1, url: 'https://a.com', title: 'A', windowId: 1 }],
      windows: [{ id: 1 }],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    document.getElementById('exportFormat').value = 'txt';
    await options.previewExport();
    await flush();
    expect(document.getElementById('exportPreviewContent').textContent).toContain('https://a.com');
  });

  test('exportSession triggers an anchor download', async () => {
    const { options, chrome } = loadOptions({
      tabs: [{ id: 1, url: 'https://a.com', title: 'A', windowId: 1 }],
      windows: [{ id: 1 }],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await options.exportSession('json');
    await flush();
    expect(global.URL.createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  test('importSession creates windows/tabs from a parsed file', async () => {
    jest.useFakeTimers();
    const { options, chrome } = loadOptions({ windows: [] });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.windows.create = jest.fn(() => Promise.resolve({ id: 99 }));

    const sessionJson = JSON.stringify([
      [
        { title: 'A', url: 'https://a.com' },
        { title: 'B', url: 'https://b.com' },
      ],
    ]);
    document.getElementById('importAsSuspended').checked = true;
    const fileInput = document.getElementById('sessionFileInput');
    Object.defineProperty(fileInput, 'files', {
      value: [{ name: 'session.json', text: () => Promise.resolve(sessionJson) }],
      configurable: true,
    });

    const promise = options.importSession();
    await jest.runAllTimersAsync();
    await promise;

    expect(chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('suspended.html') })
    );
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 99 })
    );
    jest.useRealTimers();
  });

  test('updateImportProgress / showImportProgress manipulate the progress UI', () => {
    const { options } = loadOptions();
    options.showImportProgress(true);
    expect(document.getElementById('importProgressContainer').style.display).toBe('block');
    options.updateImportProgress(2, 4);
    expect(document.getElementById('importProgressText').textContent).toBe('2/4');
    expect(document.getElementById('importProgressFill').style.width).toBe('50%');
    options.showImportProgress(false);
    expect(document.getElementById('importProgressContainer').style.display).toBe('none');
  });
});

describe('settings flows', () => {
  test('getCurrentSettings merges stored values over defaults', async () => {
    const { options, chrome } = loadOptions();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 12, neverSuspendActive: true };
    const s = await options.getCurrentSettings();
    expect(s.autoSuspendMinutes).toBe(12);
    expect(s.neverSuspendActive).toBe(true);
    expect(s.useNativeDiscard).toBe(true); // default preserved
  });

  test('previewSettings renders the settings JSON', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.commands.getAll = jest.fn(() => Promise.resolve([{ name: '01-toggle-suspend', shortcut: 'Ctrl+Shift+Z' }]));
    await options.previewSettings();
    await flush();
    const content = document.getElementById('settingsPreviewContent').textContent;
    expect(content).toContain('autoSuspendMinutes');
    expect(content).toContain('Ctrl+Shift+Z');
  });

  test('exportSettings downloads a settings file', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 12 };
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await options.exportSettings();
    await flush();
    const blob = global.URL.createObjectURL.mock.calls[0][0];
    const exportedSettings = JSON.parse(await readBlobText(blob));
    const missingSettingKeys = Object.keys(options.getDefaultSettings())
      .filter(key => !(key in exportedSettings));
    expect(missingSettingKeys).toEqual([]);
    expect(exportedSettings.autoSuspendMinutes).toBe(12);
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  test('resetSettings writes defaults and reloads the form', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    options.initializeElements();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 5 };
    await options.resetSettings();
    await flush();
    expect(chrome.storage.sync._store[STORAGE_KEY].autoSuspendMinutes).toBe(30);
  });

  test('confirmResetSettings calls resetSettings only when confirmed', async () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    options.initializeElements();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 5 };
    global.confirm = jest.fn(() => false);
    options.confirmResetSettings();
    await flush();
    expect(chrome.storage.sync._store[STORAGE_KEY].autoSuspendMinutes).toBe(5); // unchanged
    global.confirm = jest.fn(() => true);
    options.confirmResetSettings();
    await flush();
    expect(chrome.storage.sync._store[STORAGE_KEY].autoSuspendMinutes).toBe(30);
  });
});

describe('suspended-tab viewer', () => {
  test('createSuspendedWindowSection builds a header with a tab count', () => {
    const { options } = loadOptions();
    const messages = options.getSuspendedTabsMessages();
    const { section, body } = options.createSuspendedWindowSection(
      { windowId: 3, tabs: [{}, {}] },
      messages
    );
    expect(section.dataset.windowId).toBe('3');
    expect(section.querySelector('.window-tab-count').textContent).toBe('2');
    expect(body.className).toBe('suspended-window-body');
  });

  test('createSuspendedTabItem renders a suspended row with an unsuspend button', () => {
    const { options } = loadOptions();
    const messages = options.getSuspendedTabsMessages();
    const item = options.createSuspendedTabItem(
      { id: 5, windowId: 1, isSuspended: true, discarded: true, displayTitle: 'T', displayUrl: 'https://x.com', favIconUrl: 'https://x.com/f.ico' },
      1,
      messages
    );
    expect(item.dataset.tabId).toBe('5');
    expect(item.querySelector('.unsuspend-tab-btn')).toBeTruthy();
    expect(item.querySelector('.suspended-tab-favicon-img')).toBeTruthy();
  });

  test('renderNoSuspendedTabsState shows the empty state', () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    const container = document.createElement('div');
    options.renderNoSuspendedTabsState(container, options.TAB_VIEWER_FILTER_SUSPENDED_ALL);
    expect(container.querySelector('.suspended-tabs-empty-state')).toBeTruthy();
  });

  test('displaySuspendedTabsList renders window sections and tab rows', async () => {
    jest.useFakeTimers();
    const { options } = loadOptions();
    options.suspendedTabsViewerState.renderToken = 1;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewModel = {
      filterMode: options.TAB_VIEWER_FILTER_SUSPENDED_ALL,
      matchedCount: 2,
      windows: [
        {
          windowId: 1,
          tabs: [
            { id: 1, windowId: 1, isSuspended: true, discarded: false, displayTitle: 'A', displayUrl: 'https://a.com', favIconUrl: '' },
            { id: 2, windowId: 1, isSuspended: true, discarded: false, displayTitle: 'B', displayUrl: 'https://b.com', favIconUrl: '' },
          ],
        },
      ],
    };
    const promise = options.displaySuspendedTabsList(viewModel, container, 1);
    await jest.runAllTimersAsync();
    await promise;
    expect(container.querySelectorAll('.suspended-tab-item').length).toBe(2);
    jest.useRealTimers();
  });

  test('showSuspendedTabs queries tabs and populates the viewer', async () => {
    jest.useFakeTimers();
    const { options, chrome } = loadOptions({
      tabs: [
        { id: 1, url: suspendedUrl('https://a.com', 'A'), windowId: 1, discarded: false },
        { id: 2, url: 'https://b.com', windowId: 1, discarded: false },
      ],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.runtime.getURL.mockImplementation((p) => `chrome-extension://${EXT_ID}/${p}`);

    const promise = options.showSuspendedTabs();
    await jest.runAllTimersAsync();
    await promise;

    expect(document.getElementById('suspendedTabsInfo').style.display).toBe('block');
    expect(document.querySelectorAll('#suspendedTabsList .suspended-tab-item').length).toBe(1);
    jest.useRealTimers();
  });

  test('getSelectedTabViewerFilter reads the filter dropdown', () => {
    const { options } = loadOptions();
    const filterEl = document.getElementById('suspendedTabsFilter');
    if (filterEl) {
      filterEl.value = options.TAB_VIEWER_FILTER_NOT_SUSPENDED;
      expect(options.getSelectedTabViewerFilter()).toBe(options.TAB_VIEWER_FILTER_NOT_SUSPENDED);
    }
    expect(options.getSelectedTabViewerFilter()).toBeTruthy();
  });

  test('removeSuspendedTabRow drops a row and updates stats', async () => {
    jest.useFakeTimers();
    const { options, chrome } = loadOptions({
      tabs: [{ id: 1, url: suspendedUrl('https://a.com', 'A'), windowId: 1, discarded: false }],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    chrome.runtime.getURL.mockImplementation((p) => `chrome-extension://${EXT_ID}/${p}`);
    const promise = options.showSuspendedTabs();
    await jest.runAllTimersAsync();
    await promise;

    expect(document.querySelectorAll('#suspendedTabsList .suspended-tab-item').length).toBe(1);
    const removed = options.removeSuspendedTabRow(1);
    expect(removed).toBe(true);
    expect(document.querySelectorAll('#suspendedTabsList .suspended-tab-item').length).toBe(0);
    jest.useRealTimers();
  });
});
