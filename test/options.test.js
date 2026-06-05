/** Tests for options.js — settings page logic (parsers + DOM helpers). */
const { loadOptions, installChrome, requireSource } = require('./helpers/load-source');
const { loadHtmlBody } = require('./helpers/dom');

const EXT_ID = 'testextensionid';
const STORAGE_KEY = 'utsSettings';

function load(initialState) {
  return loadOptions(initialState);
}

describe('pure helpers', () => {
  test('normalizeThemeMode keeps valid values and defaults to auto', () => {
    const { options } = load();
    expect(options.normalizeThemeMode('dark')).toBe('dark');
    expect(options.normalizeThemeMode('light')).toBe('light');
    expect(options.normalizeThemeMode('auto')).toBe('auto');
    expect(options.normalizeThemeMode('bogus')).toBe('auto');
    expect(options.normalizeThemeMode(undefined)).toBe('auto');
  });

  test('normalizeIndicatorMode keeps valid values and defaults to favicon', () => {
    const { options } = load();
    expect(options.normalizeIndicatorMode('favicon')).toBe('favicon');
    expect(options.normalizeIndicatorMode('titlePrefix')).toBe('titlePrefix');
    expect(options.normalizeIndicatorMode('bogus')).toBe('favicon');
    expect(options.normalizeIndicatorMode(undefined)).toBe('favicon');
  });

  test('escapeHtml escapes markup', () => {
    const { options } = load();
    expect(options.escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;"\'&lt;/b&gt;');
    expect(options.escapeHtml('plain')).toBe('plain');
  });

  test('getMessage proxies chrome.i18n', () => {
    const { options, chrome } = load();
    chrome.i18n.getMessage.mockImplementation((k) => `M:${k}`);
    expect(options.getMessage('foo')).toBe('M:foo');
  });

  test('getDefaultSettings returns the documented defaults', () => {
    const { options } = load();
    const d = options.getDefaultSettings();
    expect(d).toMatchObject({
      autoSuspendMinutes: 30,
      useNativeDiscard: true,
      neverSuspendAudio: true,
      neverSuspendPinned: true,
      neverSuspendActive: false,
      rememberLastActiveTab: true,
      clickAnywhereToUnsuspend: false,
      whitelist: [],
      themeMode: 'auto',
      suspendedIndicatorMode: 'favicon',
      fixFaviconEnabled: true,
      fixFaviconMaxRetries: 5,
      suspendBatchConcurrency: 5,
    });
  });

  test('validateSettingsData requires the core fields', () => {
    const { options } = load();
    const valid = {
      autoSuspendMinutes: 30,
      useNativeDiscard: true,
      neverSuspendAudio: true,
      neverSuspendPinned: true,
      neverSuspendActive: false,
      whitelist: [],
    };
    expect(options.validateSettingsData(valid)).toBe(true);
    expect(options.validateSettingsData({})).toBe(false);
    expect(options.validateSettingsData(null)).toBe(false);
    expect(options.validateSettingsData('str')).toBe(false);
    const missing = { ...valid };
    delete missing.whitelist;
    expect(options.validateSettingsData(missing)).toBe(false);
  });

  test('getChangeIcon / getChangeColor map types with fallbacks', () => {
    const { options } = load();
    expect(options.getChangeIcon('added')).toBe('✨');
    expect(options.getChangeIcon('fixed')).toBe('🐛');
    expect(options.getChangeIcon('mystery')).toBe('📝');
    expect(options.getChangeColor('added')).toBe('#28a745');
    expect(options.getChangeColor('mystery')).toBe('#6c757d');
  });
});

describe('migration parsers', () => {
  test('parseMarvellousTab parses hash-format suspended urls', () => {
    const { options } = load();
    const url = `chrome-extension://abcdefghijklmnop/suspended.html#ttl=${encodeURIComponent('My Title')}&uri=${encodeURIComponent('https://x.com')}&pos=3`;
    const parsed = options.parseMarvellousTab(url);
    expect(parsed).toMatchObject({
      title: 'My Title',
      originalUrl: 'https://x.com',
      position: 3,
      extensionId: 'abcdefghijklmnop',
    });
  });

  test('parseMarvellousTab rejects non-matching urls', () => {
    const { options } = load();
    expect(options.parseMarvellousTab('https://x.com')).toBeNull();
    expect(options.parseMarvellousTab('chrome-extension://abc/suspended.html#')).toBeNull();
    expect(options.parseMarvellousTab(null)).toBeNull();
  });

  test('parseTabSuspenderTab parses both known variants', () => {
    const { options } = load();
    const v1 = `chrome-extension://fiabciakcmgepblmdkmemdbbkilneeeh/park.html?title=${encodeURIComponent('A')}&url=${encodeURIComponent('https://a.com')}`;
    expect(options.parseTabSuspenderTab(v1)).toMatchObject({
      title: 'A',
      originalUrl: 'https://a.com',
      extensionId: 'fiabciakcmgepblmdkmemdbbkilneeeh',
    });
    const v2 = `chrome-extension://laameccjpleogmfhilmffpdbiibgbekf/suspended.html?title=${encodeURIComponent('B')}&url=${encodeURIComponent('https://b.com')}`;
    expect(options.parseTabSuspenderTab(v2)).toMatchObject({
      extensionId: 'laameccjpleogmfhilmffpdbiibgbekf',
    });
    expect(options.parseTabSuspenderTab('chrome-extension://other/park.html?x=1')).toBeNull();
  });

  test('parseCustomTab parses query and hash separators', () => {
    const { options } = load();
    document.getElementById('customExtensionId').value = 'mycustomid';
    document.getElementById('customPath').value = 'suspend.html';
    document.getElementById('customSeparator').value = '?';
    document.getElementById('customTitleParam').value = 'title';
    document.getElementById('customUrlParam').value = 'uri';

    const queryUrl = `chrome-extension://mycustomid/suspend.html?title=${encodeURIComponent('Q')}&uri=${encodeURIComponent('https://q.com')}`;
    expect(options.parseCustomTab(queryUrl)).toMatchObject({ title: 'Q', originalUrl: 'https://q.com' });

    document.getElementById('customSeparator').value = '#';
    const hashUrl = `chrome-extension://mycustomid/suspend.html#title=${encodeURIComponent('H')}&uri=${encodeURIComponent('https://h.com')}`;
    expect(options.parseCustomTab(hashUrl)).toMatchObject({ title: 'H', originalUrl: 'https://h.com' });
  });

  test('createCustomConfig reads the form inputs', () => {
    const { options } = load();
    document.getElementById('customExtensionId').value = ' id ';
    document.getElementById('customPath').value = ' park.html ';
    document.getElementById('customSeparator').value = '?';
    document.getElementById('customTitleParam').value = ' t ';
    document.getElementById('customUrlParam').value = ' u ';
    expect(options.createCustomConfig()).toEqual({
      extensionId: 'id',
      path: 'park.html',
      separator: '?',
      titleParam: 't',
      urlParam: 'u',
    });
  });

  test('isKnownExtensionTab recognizes known marvellous ids', () => {
    const { options } = load();
    const url = 'chrome-extension://klbibkeccnjlkjkiokjodocebajanakg/suspended.html#ttl=A&uri=https://x';
    expect(options.isKnownExtensionTab(url, 'marvellous')).toBe(true);
    expect(options.isKnownExtensionTab('https://x.com', 'marvellous')).toBe(false);
  });
});

describe('changelog parsing', () => {
  function commit(message, sha = 'abcdef1234567', date = '2024-01-02T00:00:00Z') {
    return { commit: { message, author: { date } }, sha, html_url: `https://gh/${sha}` };
  }

  test('parseCommitMessage classifies Conventional Commit types', () => {
    const { options } = load();
    expect(options.parseCommitMessage('feat: add thing', commit('feat: add thing')).type).toBe('added');
    expect(options.parseCommitMessage('fix: repair', commit('fix: repair')).type).toBe('fixed');
    expect(options.parseCommitMessage('perf: speed', commit('perf: speed')).type).toBe('improved');
    expect(options.parseCommitMessage('revert: x', commit('revert: x')).type).toBe('removed');
  });

  test('parseCommitMessage adds scope and capitalizes', () => {
    const { options } = load();
    const r = options.parseCommitMessage('feat(ui): new button', commit('feat(ui): new button'));
    expect(r.description).toBe('[ui] New button');
    expect(r.type).toBe('added');
  });

  test('parseCommitMessage skips version/merge commits', () => {
    const { options } = load();
    expect(options.parseCommitMessage('chore: update version to 1.2.3', commit('x'))).toBeNull();
    expect(options.parseCommitMessage('Merge branch main', commit('x'))).toBeNull();
  });

  test('parseCommitMessage infers type from plain message verbs', () => {
    const { options } = load();
    expect(options.parseCommitMessage('Add feature', commit('Add feature')).type).toBe('added');
    expect(options.parseCommitMessage('Remove cruft', commit('Remove cruft')).type).toBe('removed');
    expect(options.parseCommitMessage('Improve speed', commit('Improve speed')).type).toBe('improved');
    expect(options.parseCommitMessage('Tweak stuff', commit('Tweak stuff')).type).toBe('changed');
  });

  test('parseCommitsToChangelog groups by version', () => {
    const { options } = load();
    const commits = [
      commit('chore: update version to 1.2.0', 'v120'),
      commit('feat: add A', 'a1'),
      commit('fix: bug B', 'b2'),
      commit('chore: update version to 1.1.0', 'v110'),
      commit('feat: old feature', 'o1'),
    ];
    const log = options.parseCommitsToChangelog(commits);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0].version).toBe('1.2.0');
    expect(log[0].changes.map((c) => c.type)).toEqual(expect.arrayContaining(['added', 'fixed']));
  });
});

describe('session & tab parsing', () => {
  test('parseSuspendedTab extracts original info from our suspended url', () => {
    const { options, chrome } = load();
    chrome.runtime.getURL.mockImplementation((p) => `chrome-extension://${EXT_ID}/${p}`);
    const url = `chrome-extension://${EXT_ID}/suspended.html?uri=${encodeURIComponent('https://x.com')}&ttl=${encodeURIComponent('Title')}`;
    expect(options.parseSuspendedTab(url)).toEqual({ url: 'https://x.com', title: 'Title', isSuspended: true });
    expect(options.parseSuspendedTab('https://other.com')).toBeNull();
  });

  test('parseSessionFile parses JSON sessions', () => {
    const { options } = load();
    const data = [[{ title: 'A', url: 'https://a.com' }]];
    expect(options.parseSessionFile(JSON.stringify(data), 'session.json')).toEqual(data);
  });

  test('parseSessionFile rejects malformed JSON', () => {
    const { options } = load();
    expect(() => options.parseSessionFile('{bad', 'x.json')).toThrow('Invalid JSON format');
    expect(() => options.parseSessionFile(JSON.stringify([{ not: 'array' }]), 'x.json')).toThrow();
  });

  test('parseSessionFile parses TXT sessions split into windows by blank lines', () => {
    const { options } = load();
    const txt = 'https://a.com\nhttps://b.com\n\nhttps://c.com';
    const windows = options.parseSessionFile(txt, 'session.txt');
    expect(windows).toHaveLength(2);
    expect(windows[0]).toHaveLength(2);
    expect(windows[1][0].url).toBe('https://c.com');
  });
});

describe('tab viewer view-model', () => {
  test('shouldIncludeTabInView respects each filter mode', () => {
    const { options } = load();
    const A = options.TAB_VIEWER_FILTER_SUSPENDED_ALL;
    const U = options.TAB_VIEWER_FILTER_SUSPENDED_UNDISCARDED;
    const N = options.TAB_VIEWER_FILTER_NOT_SUSPENDED;
    expect(options.shouldIncludeTabInView(true, false, A)).toBe(true);
    expect(options.shouldIncludeTabInView(false, false, A)).toBe(false);
    expect(options.shouldIncludeTabInView(true, true, U)).toBe(false);
    expect(options.shouldIncludeTabInView(true, false, U)).toBe(true);
    expect(options.shouldIncludeTabInView(false, false, N)).toBe(true);
    expect(options.shouldIncludeTabInView(true, false, N)).toBe(false);
  });

  test('buildSuspendedTabsViewModel computes counts and groups by window', () => {
    const { options, chrome } = load();
    const prefix = `chrome-extension://${EXT_ID}/suspended.html`;
    chrome.runtime.getURL.mockImplementation((p) => `chrome-extension://${EXT_ID}/${p}`);
    const tabs = [
      { id: 1, windowId: 1, url: `${prefix}?uri=${encodeURIComponent('https://a.com')}&ttl=A`, discarded: false },
      { id: 2, windowId: 1, url: `${prefix}?uri=${encodeURIComponent('https://b.com')}&ttl=B`, discarded: true },
      { id: 3, windowId: 2, url: 'https://normal.com', discarded: false },
    ];
    const vm = options.buildSuspendedTabsViewModel(tabs, prefix, options.TAB_VIEWER_FILTER_SUSPENDED_ALL);
    expect(vm.totalTabs).toBe(3);
    expect(vm.suspendedCount).toBe(2);
    expect(vm.discardedCount).toBe(1);
    expect(vm.unsuspendedCount).toBe(1);
    expect(vm.matchedCount).toBe(2);
    expect(vm.windows).toHaveLength(1); // only window 1 has matched (suspended) tabs
    expect(vm.windows[0].tabs[0].displayUrl).toBe('https://a.com');
  });

  test('buildSuspendedTabsCountText varies by filter and counts', () => {
    const { options, chrome } = load();
    chrome.i18n.getMessage.mockImplementation(() => ''); // use built-in fallbacks
    const base = {
      totalTabs: 5,
      matchedCount: 2,
      discardedCount: 1,
      filterMode: options.TAB_VIEWER_FILTER_SUSPENDED_ALL,
    };
    expect(options.buildSuspendedTabsCountText(base)).toContain('Total tabs: 5');
    expect(options.buildSuspendedTabsCountText({ ...base, matchedCount: 0 })).toContain('No suspended tabs');
    expect(
      options.buildSuspendedTabsCountText({ ...base, filterMode: options.TAB_VIEWER_FILTER_NOT_SUSPENDED })
    ).toContain('not suspended');
  });
});

describe('DOM helpers', () => {
  test('showNotice appends a notice element', () => {
    jest.useFakeTimers();
    const { options } = load();
    options.showNotice('Saved!', 'success', 1000);
    const notice = document.querySelector('.notice');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('Saved!');
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('initNavigation switches active section and toggles the action bar', () => {
    const { options } = load();
    options.initNavigation();
    const aboutLink = document.querySelector('.nav-link[data-section="about"]');
    const basicLink = document.querySelector('.nav-link[data-section="basic"]');
    const actionBar = document.querySelector('.action-bar');

    if (aboutLink) {
      aboutLink.click();
      expect(document.getElementById('about').classList.contains('active')).toBe(true);
      expect(actionBar.style.display).toBe('none');
    }
    if (basicLink) {
      basicLink.click();
      expect(document.getElementById('basic').classList.contains('active')).toBe(true);
      expect(actionBar.style.display).toBe('flex');
    }
  });

  test('displayKeyboardShortcuts filters _execute_ commands and renders rows', () => {
    const { options, chrome } = load();
    chrome.i18n.getMessage.mockImplementation((k) => k);
    const container = document.createElement('div');
    options.displayKeyboardShortcuts(
      [
        { name: '01-toggle-suspend', shortcut: 'Ctrl+Shift+Z', description: 'Toggle' },
        { name: '_execute_action', shortcut: 'Ctrl+X', description: 'builtin' },
      ],
      container
    );
    expect(container.innerHTML).toContain('Ctrl+Shift+Z');
    expect(container.innerHTML).not.toContain('Ctrl+X');
  });

  test('displayKeyboardShortcuts shows empty state when no commands', () => {
    const { options } = load();
    const container = document.createElement('div');
    options.displayKeyboardShortcuts([], container);
    expect(container.innerHTML).toContain('noShortcutsFound');
  });

  test('load() populates form fields from storage', (done) => {
    const { options, chrome } = load();
    chrome.storage.sync._store[STORAGE_KEY] = { autoSuspendMinutes: 45, useNativeDiscard: false, whitelist: ['x.com'] };
    options.initializeElements();
    options.load();
    setTimeout(() => {
      expect(document.getElementById('autoSuspend').value).toBe('45');
      expect(document.getElementById('nativeDiscard').checked).toBe(false);
      expect(document.getElementById('whitelistList').value).toBe('x.com');
      done();
    }, 0);
  });

  test('save() writes the active section settings and notifies the background', (done) => {
    jest.useRealTimers();
    const { options, chrome } = load();
    options.initializeElements();
    // Make the basic section active.
    document.querySelectorAll('.content-section').forEach((s) => s.classList.remove('active'));
    document.getElementById('basic').classList.add('active');
    document.getElementById('autoSuspend').value = '15';
    document.getElementById('nativeDiscard').checked = true;
    document.getElementById('neverSuspendAudio').checked = true;
    document.getElementById('neverSuspendPinned').checked = true;
    document.getElementById('neverSuspendActive').checked = false;
    document.getElementById('rememberLastActiveTab').checked = true;
    document.getElementById('clickAnywhereToUnsuspend').checked = false;

    options.save();
    setTimeout(() => {
      expect(chrome.storage.sync._store[STORAGE_KEY].autoSuspendMinutes).toBe(15);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'updateSettings' })
      );
      done();
    }, 0);
  });
});

describe('ProgressBarUtils', () => {
  test('updateProgress writes text and fill width', () => {
    const { options } = load();
    document.body.innerHTML = `
      <div id="c"><span id="t"></span><div id="f"></div></div>
    `;
    const ok = options.ProgressBarUtils.updateProgress({
      completed: 3,
      total: 6,
      containerSelector: '#c',
      textSelector: '#t',
      fillSelector: '#f',
    });
    expect(ok).toBe(true);
    expect(document.getElementById('t').textContent).toBe('3/6');
    expect(document.getElementById('f').style.width).toBe('50%');
  });

  test('updateProgress returns false when elements are missing', () => {
    const { options } = load();
    expect(
      options.ProgressBarUtils.updateProgress({ containerSelector: '#nope', textSelector: '#nope2', fillSelector: '#nope3' })
    ).toBe(false);
  });
});
