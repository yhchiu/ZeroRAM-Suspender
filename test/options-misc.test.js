/**
 * Additional coverage for the custom-migration path and assorted wrappers.
 */
const { loadOptions } = require('./helpers/load-source');

const EXT_ID = 'testextensionid';

function setCustomForm({ id = 'cust1234567890', path = 'park.html', sep = '?', title = 'title', url = 'url' } = {}) {
  document.getElementById('customExtensionId').value = id;
  document.getElementById('customPath').value = path;
  document.getElementById('customSeparator').value = sep;
  document.getElementById('customTitleParam').value = title;
  document.getElementById('customUrlParam').value = url;
}

describe('custom migration', () => {
  test('testCustomPattern succeeds for a well-formed config', () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    setCustomForm();
    options.testCustomPattern();
    // A success notice is shown (no exception, notice element appended).
    expect(document.querySelector('.notice')).toBeTruthy();
  });

  test('testCustomPattern warns when fields are missing', () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    setCustomForm({ id: '' });
    options.testCustomPattern();
    const notice = document.querySelector('.notice');
    expect(notice.className).toContain('notice-warning');
  });

  test('scanForCustomTabs finds matching custom tabs', async () => {
    const customUrl = `chrome-extension://cust1234567890/park.html?title=${encodeURIComponent('C')}&url=${encodeURIComponent('https://c.com')}`;
    const { options, chrome } = loadOptions({ tabs: [{ id: 1, url: customUrl, windowId: 1 }] });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    setCustomForm();
    await options.scanForCustomTabs();
    await Promise.resolve();
    const container = document.getElementById('customTabsContainer');
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(1);
  });
});

describe('assorted wrappers', () => {
  test('getNoticeContainer creates and reuses a single container', () => {
    const { options } = loadOptions();
    const c1 = options.getNoticeContainer();
    const c2 = options.getNoticeContainer();
    expect(c1).toBe(c2);
    expect(c1.id).toBe('notice-container');
  });

  test('getCurrentActiveSection returns the active section id', () => {
    const { options } = loadOptions();
    document.querySelectorAll('.content-section').forEach((s) => s.classList.remove('active'));
    document.getElementById('whitelist').classList.add('active');
    expect(options.getCurrentActiveSection()).toBe('whitelist');
  });

  test('handleExport delegates to exportSession using the format dropdown', async () => {
    const { options, chrome } = loadOptions({
      tabs: [{ id: 1, url: 'https://a.com', title: 'A', windowId: 1 }],
      windows: [{ id: 1 }],
    });
    chrome.i18n.getMessage.mockImplementation((k) => k);
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    document.getElementById('exportFormat').value = 'txt';
    options.handleExport();
    await Promise.resolve();
    await Promise.resolve();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  test('resetMigrationState clears all extension migration UI', () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    const status = document.getElementById('migrationStatus');
    status.textContent = 'stale';
    options.resetMigrationState();
    expect(status.textContent).toBe('');
  });

  test('updateSuspendedTabsCountDisplay writes the count text', () => {
    const { options, chrome } = loadOptions();
    chrome.i18n.getMessage.mockImplementation(() => '');
    options.suspendedTabsViewerState.stats = {
      totalTabs: 4,
      matchedCount: 2,
      discardedCount: 0,
      filterMode: options.TAB_VIEWER_FILTER_SUSPENDED_ALL,
    };
    options.updateSuspendedTabsCountDisplay();
    const el = document.getElementById('suspendedTabsCount');
    expect(el.textContent).toContain('Total tabs: 4');
  });
});
