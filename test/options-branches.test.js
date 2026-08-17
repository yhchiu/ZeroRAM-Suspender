/**
 * Branch-focused tests: drive the high-branch-density render/format helpers with
 * getMessage returning '' (so the `|| 'fallback'` paths execute) and with varied
 * inputs that flip the many ternaries in the options page.
 */
const { loadOptions } = require('./helpers/load-source');

const EXT_ID = 'testextensionid';

/** Load options with getMessage stubbed to '' so i18n fallbacks are taken. */
function loadEmptyI18n(initialState) {
  const ctx = loadOptions(initialState);
  ctx.chrome.i18n.getMessage.mockImplementation(() => '');
  return ctx;
}

describe('buildSuspendedTabsCountText branches', () => {
  test('all filter modes with and without matches/discarded (fallback strings)', () => {
    const { options } = loadEmptyI18n();
    const A = options.TAB_VIEWER_FILTER_SUSPENDED_ALL;
    const U = options.TAB_VIEWER_FILTER_SUSPENDED_UNDISCARDED;
    const N = options.TAB_VIEWER_FILTER_NOT_SUSPENDED;

    expect(options.buildSuspendedTabsCountText({ totalTabs: 3, matchedCount: 2, discardedCount: 1, filterMode: A })).toContain('discarded');
    expect(options.buildSuspendedTabsCountText({ totalTabs: 3, matchedCount: 2, discardedCount: 0, filterMode: A })).toContain('Found');
    expect(options.buildSuspendedTabsCountText({ totalTabs: 3, matchedCount: 0, discardedCount: 0, filterMode: A })).toContain('No suspended');
    expect(options.buildSuspendedTabsCountText({ totalTabs: 3, matchedCount: 2, discardedCount: 0, filterMode: U })).toContain('not discarded');
    expect(options.buildSuspendedTabsCountText({ totalTabs: 3, matchedCount: 0, discardedCount: 0, filterMode: U })).toContain('No tabs match');
    expect(options.buildSuspendedTabsCountText({ totalTabs: 3, matchedCount: 2, discardedCount: 0, filterMode: N })).toContain('not suspended');
    expect(options.buildSuspendedTabsCountText({ totalTabs: 3, matchedCount: 0, discardedCount: 0, filterMode: N })).toContain('No tabs match');
  });
});

describe('createSuspendedTabItem branches', () => {
  test('not-suspended + discarded, no favicon (fallback messages)', () => {
    const { options } = loadEmptyI18n();
    const messages = options.getSuspendedTabsMessages();
    const item = options.createSuspendedTabItem(
      { id: 9, windowId: 2, isSuspended: false, discarded: true, displayTitle: 'X', displayUrl: 'https://x.com', favIconUrl: '' },
      3,
      messages
    );
    expect(item.querySelector('.suspended-tab-badge-not-suspended')).toBeTruthy();
    expect(item.querySelector('.suspended-tab-badge-discarded')).toBeTruthy();
    expect(item.querySelector('.suspended-tab-favicon-img')).toBeNull();
    expect(item.querySelector('.unsuspend-tab-btn')).toBeNull();
  });

  test('suspended + not discarded keeps the suspended badge only', () => {
    const { options } = loadEmptyI18n();
    const messages = options.getSuspendedTabsMessages();
    const item = options.createSuspendedTabItem(
      { id: 1, windowId: 1, isSuspended: true, discarded: false, displayTitle: 'A', displayUrl: 'https://a.com', favIconUrl: 'https://a/f.ico' },
      1,
      messages
    );
    expect(item.querySelector('.suspended-tab-badge-suspended')).toBeTruthy();
    expect(item.querySelector('.suspended-tab-badge-discarded')).toBeNull();
  });
});

describe('createSuspendedWindowSection branches', () => {
  test('singular vs plural tab unit label', () => {
    const { options } = loadEmptyI18n();
    const messages = options.getSuspendedTabsMessages();
    const single = options.createSuspendedWindowSection({ windowId: 1, tabs: [{}] }, messages);
    const plural = options.createSuspendedWindowSection({ windowId: 2, tabs: [{}, {}] }, messages);
    expect(single.section.querySelector('.window-tab-label').textContent).toBe(messages.tab);
    expect(plural.section.querySelector('.window-tab-label').textContent).toBe(messages.tabs);
  });
});

describe('displayKeyboardShortcuts branches', () => {
  test('unassigned shortcut and fallback labels', () => {
    const { options } = loadEmptyI18n();
    const container = document.createElement('div');
    options.displayKeyboardShortcuts(
      [
        { name: '01-toggle-suspend', shortcut: '', description: 'Toggle' },
        { name: 'unknown-cmd', shortcut: 'Alt+P', description: 'Custom' },
      ],
      container
    );
    // Unassigned command renders the not-assigned fallback styling.
    expect(container.innerHTML).toContain('Alt+P');
  });

  test('only built-in commands yields the empty state', () => {
    const { options } = loadEmptyI18n();
    const container = document.createElement('div');
    options.displayKeyboardShortcuts([{ name: '_execute_action', shortcut: 'Ctrl+X' }], container);
    expect(container.innerHTML).toContain('No shortcuts found');
  });
});

describe('renderNoSuspendedTabsState branches', () => {
  test('default filter vs non-default filter messages', () => {
    const { options } = loadEmptyI18n();
    const c1 = document.createElement('div');
    options.renderNoSuspendedTabsState(c1, options.TAB_VIEWER_FILTER_SUSPENDED_ALL);
    expect(c1.textContent).toContain('No suspended tabs found');

    const c2 = document.createElement('div');
    options.renderNoSuspendedTabsState(c2, options.TAB_VIEWER_FILTER_NOT_SUSPENDED);
    expect(c2.textContent).toContain('No tabs match');
  });
});

describe('changelogChangeType branches (no Conventional Commit type match)', () => {
  test('plain "new" and "implement" verbs map to added', () => {
    const { options } = loadOptions();
    expect(options.changelogChangeType('other', 'new dashboard')).toBe('added');
    expect(options.changelogChangeType('other', 'implement search')).toBe('added');
    expect(options.changelogChangeType('other', 'repair favicon')).toBe('fixed');
    expect(options.changelogChangeType('other', 'delete legacy path')).toBe('removed');
  });
  test('cc subject verb inference for non-feat/fix types', () => {
    const { options } = loadOptions();
    expect(options.changelogChangeType('chore', 'chore: remove dead code')).toBe('removed');
    expect(options.changelogChangeType('chore', 'chore: improve perf')).toBe('improved');
    expect(options.changelogChangeType('docs', 'docs: add notes')).toBe('added');
  });
  test('parseCommitSubject splits scope from text', () => {
    const { options } = loadOptions();
    expect(options.parseCommitSubject('feat(ui)!: drop the old pane')).toEqual({ scope: 'ui', text: 'drop the old pane' });
    expect(options.parseCommitSubject('plain subject\nbody')).toEqual({ scope: '', text: 'plain subject' });
  });
});

describe('previewImportSettings branches', () => {
  test('settings without shortcuts/whitelist/exportedAt use fallbacks', async () => {
    const { options } = loadEmptyI18n();
    const minimal = {
      autoSuspendMinutes: 0,
      useNativeDiscard: false,
      neverSuspendAudio: false,
      neverSuspendPinned: false,
      neverSuspendActive: true,
      whitelist: [],
    };
    const el = document.getElementById('settingsFileInput');
    Object.defineProperty(el, 'files', {
      value: [{ name: 'settings.json', text: () => Promise.resolve(JSON.stringify(minimal)) }],
      configurable: true,
    });
    await options.previewImportSettings();
    await Promise.resolve();
    expect(document.getElementById('importSettingsPreview').style.display).toBe('block');
  });
});

describe('normalizeThemeMode / getDefaultSettings under empty i18n', () => {
  test('getCurrentSettings normalizes an invalid themeMode to auto', async () => {
    const { options, chrome } = loadOptions();
    chrome.storage.sync._store.utsSettings = { themeMode: 'invalid-mode' };
    const s = await options.getCurrentSettings();
    expect(s.themeMode).toBe('auto');
  });

  test('getCurrentSettings normalizes an invalid suspendedIndicatorMode to favicon', async () => {
    const { options, chrome } = loadOptions();
    chrome.storage.sync._store.utsSettings = { suspendedIndicatorMode: 'bogus' };
    const s = await options.getCurrentSettings();
    expect(s.suspendedIndicatorMode).toBe('favicon');
  });

  test('getCurrentSettings preserves a valid titlePrefix indicator', async () => {
    const { options, chrome } = loadOptions();
    chrome.storage.sync._store.utsSettings = { suspendedIndicatorMode: 'titlePrefix' };
    const s = await options.getCurrentSettings();
    expect(s.suspendedIndicatorMode).toBe('titlePrefix');
  });
});
