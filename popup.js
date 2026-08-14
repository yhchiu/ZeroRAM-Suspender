// popup.js - build popup UI
(async () => {
  const STORAGE_KEY = 'utsSettings';
  // Mirrors background.js: the worker writes its in-memory temporary whitelist
  // back to session storage on every change, so the popup can read the same
  // data straight from there instead of asking the worker for it.
  const TEMP_KEY = 'utsTempWhitelist';
  // Synchronous mirror of the settings the popup renders from, cached the way
  // theme-boot.js caches the theme. chrome.storage.sync is disk-backed and so
  // is the slowest read here when the machine is busy; a warm cache lets the
  // first render go ahead without it. The authoritative read still runs and
  // reconciles right after, so the cache can never hold the UI wrong.
  const SETTINGS_CACHE_KEY = 'utsCacheSettings';
  // Progress titles, keyed by the action the worker reports.
  const BULK_TITLE_KEYS = {
    suspendAll: 'suspendingAllTabs',
    unsuspendAll: 'unsuspendingAllTabs',
    suspendWindow: 'suspendingWindowTabs',
    unsuspendWindow: 'unsuspendingWindowTabs'
  };

  // These reads are independent, so they leave together instead of as a serial
  // chain, and none of them touches the service worker. That is what matters
  // when the machine is busy: a sleeping worker has to spawn a process,
  // evaluate background.js and restore its whole state before it can answer a
  // message, and the popup used to sit on an empty frame for all of it.
  // Starting them before any other work gets the requests onto the browser
  // process as early as possible.
  const pendingTabs = chrome.tabs.query({ highlighted: true, currentWindow: true });
  const pendingTemp = chrome.storage.session.get(TEMP_KEY);
  const pendingSettings = chrome.storage.sync.get(STORAGE_KEY);

  const suspendedPrefix = chrome.runtime.getURL('suspended.html');
  const bannerEl = document.getElementById('banner');
  const menuEl = document.getElementById('menu');

  // Bulk progress UI elements
  const bulkBox = document.getElementById('bulkProgress');
  const bulkFill = document.getElementById('bulkProgressFill');
  const bulkText = document.getElementById('bulkProgressText');
  const bulkTitle = document.getElementById('bulkProgressTitle');
  const bulkLabel = document.getElementById('bulkProgressLabel');
  const bulkCancelBtn = document.getElementById('bulkCancelBtn');

  // Set version dynamically
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('version');
  if (versionEl) {
    versionEl.textContent = `v${manifest.version}`;
  }

  function isInternalUrl(url) {
    return (
      url.startsWith('chrome://') ||
      url.startsWith('edge://') ||
      url.startsWith('about://') ||
      url.startsWith('view-source:') ||
      url.startsWith('devtools://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('extension://')
    );
  }

  function getMatchedWhitelistEntry(url, settings) {
    if (!url) return null;
    const u = new URL(url);
    return (settings.whitelist || []).find(entry => {
      if (!entry) return false;
      if (entry.startsWith('http')) {
        return url.startsWith(entry);
      }
      return u.hostname === entry || u.hostname.endsWith('.' + entry);
    });
  }

  // Just the fields the popup renders from. Narrowing to these keeps the cache
  // small and keeps an unrelated option (say a favicon batch size) from
  // reading as a change worth acting on.
  function popupSettings(saved) {
    const cfg = saved || {};
    return {
      whitelist: Array.isArray(cfg.whitelist) ? cfg.whitelist : [],
      autoSuspendMinutes: cfg.autoSuspendMinutes,
      neverSuspendAudio: cfg.neverSuspendAudio,
    };
  }

  function readCachedSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return popupSettings(parsed);
    } catch (e) {
      // localStorage unavailable or the entry is corrupt - fall back to the
      // authoritative read below.
      return null;
    }
  }

  function writeCachedSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(popupSettings(settings)));
    } catch (e) {
      // Non-fatal: the next open just waits for chrome.storage.sync again.
    }
  }

  // Loading placeholders, drawn only once the reads above have taken longer
  // than a frame or two — a popup whose data lands immediately never flashes
  // them. The rows carry no click handlers, so a click that arrives while they
  // are up cannot land on the wrong menu entry once the real items replace them.
  const SKELETON_DELAY_MS = 120;
  const SKELETON_ROWS = 6;
  let skeletonShown = false;
  let skeletonStopped = false;
  const skeletonTimer = setTimeout(() => {
    skeletonShown = true;
    menuEl.setAttribute('aria-busy', 'true');
    for (let i = 0; i < SKELETON_ROWS; i++) {
      const placeholder = document.createElement('li');
      placeholder.className = 'skeleton';
      placeholder.setAttribute('aria-hidden', 'true');
      menuEl.appendChild(placeholder);
    }
  }, SKELETON_DELAY_MS);

  function stopSkeleton() {
    if (skeletonStopped) return;
    skeletonStopped = true;
    clearTimeout(skeletonTimer);
    if (skeletonShown) {
      menuEl.textContent = '';
      menuEl.removeAttribute('aria-busy');
    }
  }

  const [highlightedTabs, sessionData] = await Promise.all([pendingTabs, pendingTemp]);

  // A warm cache carries the first render; without one there is nothing to do
  // but wait for the authoritative read (first ever open, or no localStorage).
  let settings = readCachedSettings();
  const renderedFromCache = settings !== null;
  if (!settings) {
    settings = popupSettings((await pendingSettings)[STORAGE_KEY]);
  }

  // Chrome always highlights the active tab, so the query above already carries
  // it. The extra query is a safety net, not an expected path.
  let tab = highlightedTabs.find(t => t.active);
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }

  stopSkeleton();

  // No tab to describe: leave the popup as-is rather than throwing on tab.url.
  if (!tab) return;

  const selectedTabs = highlightedTabs;
  const hasMultipleSelected = selectedTabs.length > 1;
  const tempWhitelist = sessionData[TEMP_KEY];
  const tempWhite = Array.isArray(tempWhitelist) && tempWhitelist.includes(tab.url);

  const isPlaceholder = tab.url.startsWith(suspendedPrefix);
  const isInternal = isInternalUrl(tab.url);

  // Everything the render reads out of settings, for this tab. Comparing this
  // rather than the settings object keeps a whitelist edit for some other site
  // from rebuilding the menu under the user's cursor.
  function renderSignature(cfg) {
    return JSON.stringify([
      cfg.autoSuspendMinutes === 0,
      cfg.neverSuspendAudio !== false && tab.audible === true,
      getMatchedWhitelistEntry(tab.url, cfg) || null,
    ]);
  }

  let menuItems = [];

  function addItem(text, onClick, iconType = '', closeOnClick = true) {
    const li = document.createElement('li');
    li.textContent = text;
    li.setAttribute('role', 'menuitem');
    // Roving tabindex: only one menu item is a tab stop at a time
    li.tabIndex = -1;
    if (iconType) {
      li.setAttribute('data-icon', iconType);
    }
    const activate = async () => {
      await onClick();
      if (closeOnClick) {
        window.close();
      }
    };
    li.addEventListener('click', activate);
    li.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        await activate();
      }
    });
    menuEl.appendChild(li);
  }

  function addSeparator() {
    const hr = document.createElement('hr');
    hr.setAttribute('role', 'separator');
    menuEl.appendChild(hr);
  }

  // Draws banner and menu from scratch. Runs once from the cached settings and
  // again only if the authoritative read disagrees with what was drawn.
  function render(cfg) {
    // Drop whatever a previous pass added; the status indicator belongs to the
    // static markup and has to survive.
    for (const el of bannerEl.querySelectorAll('span, a')) el.remove();
    menuEl.textContent = '';

    const matchedWhitelistEntry = getMatchedWhitelistEntry(tab.url, cfg);
    const isWhitelistedUrl = Boolean(matchedWhitelistEntry);
    const isAudioProtected = cfg.neverSuspendAudio !== false && tab.audible === true;

    const bannerTextEl = document.createElement('span');
    bannerEl.appendChild(bannerTextEl);
    const actionLink = document.createElement('a');
    actionLink.href = '#';
    actionLink.style.color = 'var(--brand)';
    actionLink.style.fontWeight = '700';
    actionLink.style.marginLeft = '4px';
    bannerEl.appendChild(actionLink);

    if (isPlaceholder) {
      bannerTextEl.textContent = getMessage('tabSuspended');
      bannerEl.classList.remove('blue');
      bannerEl.classList.add('gray');
      actionLink.style.display = 'none';
    } else if (isInternal) {
      bannerTextEl.textContent = getMessage('cannotSuspend');
      bannerEl.classList.remove('blue');
      bannerEl.classList.add('gray');
      actionLink.style.display = 'none';
    } else if (isWhitelistedUrl) {
      bannerTextEl.textContent = getMessage('siteWhitelisted');
      bannerEl.classList.remove('blue');
      bannerEl.classList.add('gray');
      actionLink.textContent = getMessage('removeFromWhitelist');
      actionLink.style.display = 'inline';

      actionLink.addEventListener('click', async (e) => {
        e.preventDefault();
        if (matchedWhitelistEntry && confirm(getMessage('confirmRemoveFromWhitelist').replace('%s', matchedWhitelistEntry))) {
          await removeFromWhitelist(matchedWhitelistEntry);
          window.close();
        }
      });
    } else {
      if (cfg.autoSuspendMinutes === 0) {
        bannerTextEl.textContent = getMessage('autoSuspendDisabled');
        bannerEl.classList.remove('blue');
        bannerEl.classList.add('gray');
        actionLink.style.display = 'none';
      } else if (isAudioProtected) {
        bannerTextEl.textContent = getMessage('audioTabProtected');
        bannerEl.classList.remove('blue');
        bannerEl.classList.add('gray');
        actionLink.style.display = 'none';
      } else if (tempWhite) {
        // Temporarily excluded from suspension
        bannerTextEl.textContent = getMessage('autoSuspendPaused');
        bannerEl.classList.remove('blue');
        bannerEl.classList.add('gray');
        actionLink.textContent = getMessage('allowSuspend');
        actionLink.style.display = 'inline';
      } else {
        bannerTextEl.textContent = getMessage('tabWillSuspend');
        bannerEl.classList.remove('gray');
        bannerEl.classList.add('blue');
        actionLink.textContent = getMessage('notNow');
        actionLink.style.display = 'inline';
      }

      // Add click listener if applicable
      if (cfg.autoSuspendMinutes !== 0) {
        actionLink.addEventListener('click', async (e) => {
          e.preventDefault();
          const { whitelisted } = await chrome.runtime.sendMessage({ command: 'toggleTempWhitelist', url: tab.url });
          // Update UI based on new state
          if (whitelisted) {
            bannerTextEl.textContent = getMessage('autoSuspendPaused');
            bannerEl.classList.remove('blue');
            bannerEl.classList.add('gray');
            actionLink.textContent = getMessage('allowSuspend');
          } else {
            bannerTextEl.textContent = getMessage('tabWillSuspend');
            bannerEl.classList.remove('gray');
            bannerEl.classList.add('blue');
            actionLink.textContent = getMessage('notNow');
          }
        });
      }
    }

    // Menu items depending on state
    if (!isPlaceholder && !isInternal) {
      addItem(getMessage('suspendThisTab'), async () => {
        await chrome.runtime.sendMessage({ command: 'suspendTab', tabId: tab.id });
      }, 'suspend');
    }

    if (!isInternal && !isWhitelistedUrl) {
      addItem(getMessage('neverSuspendURL'), async () => {
        await modifyWhitelist(tab.url);
      }, 'never');
      addItem(getMessage('neverSuspendDomain'), async () => {
        const domain = new URL(tab.url).hostname;
        await modifyWhitelist(domain);
      }, 'never');
    }

    // Add separator before bulk actions if we have single tab actions
    if ((!isPlaceholder && !isInternal) || (!isInternal && !isWhitelistedUrl)) {
      addSeparator();
    }

    // Selected tabs actions (force suspend/unsuspend)
    if (hasMultipleSelected) {
      // Count suspendable and unsuspendable tabs
      const suspendableTabs = selectedTabs.filter(t => !isInternalUrl(t.url) && !t.url.startsWith(suspendedPrefix));
      const unsuspendableTabs = selectedTabs.filter(t => t.url.startsWith(suspendedPrefix));

      if (suspendableTabs.length > 0) {
        addItem(getMessage('suspendSelectedTabs') + ` (${suspendableTabs.length})`, async () => {
          await chrome.runtime.sendMessage({ command: 'suspendSelectedTabs', tabIds: suspendableTabs.map(t => t.id) });
        }, 'suspend');
      }

      if (unsuspendableTabs.length > 0) {
        addItem(getMessage('unsuspendSelectedTabs') + ` (${unsuspendableTabs.length})`, async () => {
          await chrome.runtime.sendMessage({ command: 'unsuspendSelectedTabs', tabIds: unsuspendableTabs.map(t => t.id) });
        }, 'wake');
      }

      // Add separator after selected tabs actions
      if (suspendableTabs.length > 0 || unsuspendableTabs.length > 0) {
        addSeparator();
      }
    }

    // Every bulk action opens the progress box before sending its command, and
    // keeps the popup open (the `false` below) so it can report the run. The
    // window-scoped pair needs this as much as the all-windows pair: both wait
    // on pages, so both take long enough to be worth watching and stopping.
    const startBulk = (titleKey) => {
      if (!bulkBox) return;
      bulkBox.style.display = 'block';
      if (bulkTitle) bulkTitle.textContent = getMessage(titleKey);
      if (bulkFill) bulkFill.style.width = '0%';
      if (bulkText) bulkText.textContent = '0/0';
      if (bulkLabel) bulkLabel.textContent = '';
      if (bulkCancelBtn) bulkCancelBtn.disabled = false;
    };

    addItem(getMessage('suspendOthers'), async () => {
      startBulk('suspendingWindowTabs');
      await chrome.runtime.sendMessage({ command: 'suspendOthers', tabId: tab.id, withProgress: true });
    }, 'others', false);
    addItem(getMessage('suspendAllOthersAllWindows'), async () => {
      startBulk('suspendingAllTabs');
      await chrome.runtime.sendMessage({ command: 'suspendAllOthersAllWindows', tabId: tab.id, withProgress: true });
    }, 'others', false);
    addItem(getMessage('unsuspendAllThisWindow'), async () => {
      startBulk('unsuspendingWindowTabs');
      await chrome.runtime.sendMessage({ command: 'unsuspendAllThisWindow', tabId: tab.id, withProgress: true });
    }, 'wake', false);
    addItem(getMessage('unsuspendAll'), async () => {
      startBulk('unsuspendingAllTabs');
      await chrome.runtime.sendMessage({ command: 'unsuspendAll', withProgress: true });
    }, 'wake', false);

    addSeparator();
    addItem(getMessage('settingsMenu'), async () => {
      await chrome.runtime.openOptionsPage();
    }, 'settings');

    // ARIA menu pattern: a single tab stop, with the arrow keys below moving
    // between items.
    menuItems = [...menuEl.querySelectorAll('li[role="menuitem"]')];
    if (menuItems.length > 0) {
      menuItems[0].tabIndex = 0;
    }
  }

  render(settings);

  // ArrowUp/ArrowDown/Home/End navigation (separators are skipped
  // automatically). Bound once: menuItems is refreshed by every render.
  menuEl.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || menuItems.length === 0) {
      return;
    }
    e.preventDefault();
    const current = menuItems.indexOf(document.activeElement);
    let next;
    if (e.key === 'ArrowDown') {
      next = current < 0 ? 0 : (current + 1) % menuItems.length;
    } else if (e.key === 'ArrowUp') {
      next = current < 0 ? menuItems.length - 1 : (current - 1 + menuItems.length) % menuItems.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else {
      next = menuItems.length - 1;
    }
    menuItems.forEach(item => { item.tabIndex = -1; });
    menuItems[next].tabIndex = 0;
    menuItems[next].focus();
  });

  // --- Bulk progress plumbing -------------------------------------------
  // Connecting the port is what wakes the service worker, so it happens after
  // the menu is on screen: bulk runs only start from a click, long after this
  // point, and connecting earlier would make the worker's cold start compete
  // with the popup's own rendering for CPU and browser-process time.
  const port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'bulkProgress') return;
    const { action, processed = 0, total = 0, done = false, cancelled = false } = msg;
    if (!bulkBox) return;
    bulkBox.style.display = 'block';

    // Titled from the action rather than from whatever this popup last set:
    // progress can arrive from a run it did not start, such as a keyboard
    // shortcut, and a window-scoped run must not claim to be doing all tabs.
    if (bulkTitle) {
      bulkTitle.textContent = getMessage(BULK_TITLE_KEYS[action] || 'bulkProgress');
    }

    const pct = total > 0 ? Math.floor((processed / total) * 100) : 0;
    if (bulkFill) bulkFill.style.width = `${pct}%`;
    if (bulkText) bulkText.textContent = `${processed}/${total}`;
    if (bulkLabel) bulkLabel.textContent = `${pct}%`;

    if (done) {
      // Snap to 100% and briefly indicate completion
      if (cancelled) {
        if (bulkLabel) bulkLabel.textContent = getMessage('bulkCancelled');
      } else {
        if (bulkFill) bulkFill.style.width = '100%';
        if (bulkText) bulkText.textContent = `${total}/${total}`;
        if (bulkLabel) bulkLabel.textContent = '100%';
        setTimeout(() => {
          if (bulkLabel) bulkLabel.textContent = getMessage('bulkDone');
        }, 100);
      }
      if (bulkCancelBtn) bulkCancelBtn.disabled = true;
    }
  });

  // Allow cancel during bulk operations
  if (bulkCancelBtn) {
    bulkCancelBtn.addEventListener('click', async () => {
      bulkCancelBtn.disabled = true;
      await chrome.runtime.sendMessage({ command: 'cancelBulk' });
    });
  }

  // --- Reconcile the cached render against the real settings -------------
  const freshSettings = popupSettings((await pendingSettings)[STORAGE_KEY]);
  if (renderedFromCache && renderSignature(freshSettings) !== renderSignature(settings)) {
    settings = freshSettings;
    render(settings);
  }
  writeCachedSettings(freshSettings);

  // --- helper to add to whitelist ---
  async function modifyWhitelist(entry) {
    const { [STORAGE_KEY]: cfg = {} } = await chrome.storage.sync.get(STORAGE_KEY);
    cfg.whitelist = cfg.whitelist || [];
    if (!cfg.whitelist.includes(entry)) {
      cfg.whitelist.push(entry);
      await chrome.storage.sync.set({ [STORAGE_KEY]: cfg });
      writeCachedSettings(cfg);
      await chrome.runtime.sendMessage({ command: 'updateSettings', settings: cfg });
    }
  }

  // --- helper to remove from whitelist ---
  async function removeFromWhitelist(entry) {
    const { [STORAGE_KEY]: cfg = {} } = await chrome.storage.sync.get(STORAGE_KEY);
    cfg.whitelist = cfg.whitelist || [];
    const index = cfg.whitelist.indexOf(entry);
    if (index > -1) {
      cfg.whitelist.splice(index, 1);
      await chrome.storage.sync.set({ [STORAGE_KEY]: cfg });
      writeCachedSettings(cfg);
      await chrome.runtime.sendMessage({ command: 'updateSettings', settings: cfg });
    }
  }
})();
