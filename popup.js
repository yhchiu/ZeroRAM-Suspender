// popup.js - build popup UI
(async () => {
  const STORAGE_KEY = 'utsSettings';
  // Mirrors background.js: the worker writes its in-memory temporary whitelist
  // back to session storage on every change, so the popup can read the same
  // data straight from there instead of asking the worker for it.
  const TEMP_KEY = 'utsTempWhitelist';

  // Every read below is independent, so they leave as one parallel batch
  // instead of a serial chain, and none of them touches the service worker.
  // That is what matters when the machine is busy: a sleeping worker has to
  // spawn a process, evaluate background.js and restore its whole state before
  // it can answer a message, and the popup used to sit on an empty frame for
  // all of it. Kicking the batch off before any other work gets the requests
  // onto the browser process as early as possible.
  const pendingData = Promise.all([
    chrome.tabs.query({ highlighted: true, currentWindow: true }),
    chrome.storage.sync.get(STORAGE_KEY),
    chrome.storage.session.get(TEMP_KEY),
  ]);

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

  function isWhitelisted(url, settings) {
    if (!url) return false;
    const u = new URL(url);
    return (settings.whitelist || []).some(entry => {
      if (!entry) return false;
      if (entry.startsWith('http')) {
        return url.startsWith(entry);
      }
      return u.hostname === entry || u.hostname.endsWith('.' + entry);
    });
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

  // Loading placeholders, drawn only once the batch above has taken longer than
  // a frame or two — a popup whose data lands immediately never flashes them.
  // The rows carry no click handlers, so a click that arrives while they are up
  // cannot land on the wrong menu entry once the real items replace them.
  const SKELETON_DELAY_MS = 120;
  const SKELETON_ROWS = 6;
  let skeletonTimer = setTimeout(() => {
    skeletonTimer = null;
    menuEl.setAttribute('aria-busy', 'true');
    for (let i = 0; i < SKELETON_ROWS; i++) {
      const placeholder = document.createElement('li');
      placeholder.className = 'skeleton';
      placeholder.setAttribute('aria-hidden', 'true');
      menuEl.appendChild(placeholder);
    }
  }, SKELETON_DELAY_MS);

  const [highlightedTabs, syncData, sessionData] = await pendingData;

  if (skeletonTimer !== null) {
    clearTimeout(skeletonTimer);
  } else {
    menuEl.textContent = '';
    menuEl.removeAttribute('aria-busy');
  }

  // Chrome always highlights the active tab, so the batched query already
  // carries it. The extra query is a safety net, not an expected path.
  let tab = highlightedTabs.find(t => t.active);
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  // No tab to describe: leave the popup as-is rather than throwing on tab.url.
  if (!tab) return;

  const selectedTabs = highlightedTabs;
  const hasMultipleSelected = selectedTabs.length > 1;
  const settings = syncData[STORAGE_KEY] || {};
  const tempWhitelist = sessionData[TEMP_KEY];
  const tempWhite = Array.isArray(tempWhitelist) && tempWhitelist.includes(tab.url);

  const isPlaceholder = tab.url.startsWith(suspendedPrefix);
  const isInternal = isInternalUrl(tab.url);
  const isWhitelistedUrl = isWhitelisted(tab.url, settings);
  const isAudioProtected = settings.neverSuspendAudio !== false && tab.audible === true;
  const matchedWhitelistEntry = getMatchedWhitelistEntry(tab.url, settings);

  let bannerTextEl = document.createElement('span');
  bannerEl.appendChild(bannerTextEl);
  let actionLink = document.createElement('a');
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
    if (settings.autoSuspendMinutes === 0) {
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
    if (settings.autoSuspendMinutes !== 0) {
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

  addItem(getMessage('suspendOthers'), async () => {
    await chrome.runtime.sendMessage({ command: 'suspendOthers', tabId: tab.id });
  }, 'others');
  addItem(getMessage('suspendAllOthersAllWindows'), async () => {
    // Show progress early
    if (bulkBox) {
      bulkBox.style.display = 'block';
      if (bulkTitle) bulkTitle.textContent = getMessage('suspendingAllTabs');
      if (bulkFill) bulkFill.style.width = '0%';
      if (bulkText) bulkText.textContent = '0/0';
      if (bulkLabel) bulkLabel.textContent = '';
      if (bulkCancelBtn) bulkCancelBtn.disabled = false;
    }
    await chrome.runtime.sendMessage({ command: 'suspendAllOthersAllWindows', tabId: tab.id, withProgress: true });
  }, 'others', false);
  addItem(getMessage('unsuspendAllThisWindow'), async () => {
    await chrome.runtime.sendMessage({ command: 'unsuspendAllThisWindow', tabId: tab.id });
  }, 'wake');
  addItem(getMessage('unsuspendAll'), async () => {
    // Show progress early
    if (bulkBox) {
      bulkBox.style.display = 'block';
      if (bulkTitle) bulkTitle.textContent = getMessage('unsuspendingAllTabs');
      if (bulkFill) bulkFill.style.width = '0%';
      if (bulkText) bulkText.textContent = '0/0';
      if (bulkLabel) bulkLabel.textContent = '';
      if (bulkCancelBtn) bulkCancelBtn.disabled = false;
    }
    await chrome.runtime.sendMessage({ command: 'unsuspendAll', withProgress: true });
  }, 'wake', false);

  addSeparator();
  addItem(getMessage('settingsMenu'), async () => {
    await chrome.runtime.openOptionsPage();
  }, 'settings');

  // ARIA menu pattern: single tab stop plus ArrowUp/ArrowDown/Home/End
  // navigation between items (separators are skipped automatically).
  const menuItems = [...menuEl.querySelectorAll('li[role="menuitem"]')];
  if (menuItems.length > 0) {
    menuItems[0].tabIndex = 0;
  }
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

    if (bulkTitle) {
      if (action === 'unsuspendAll') {
        bulkTitle.textContent = getMessage('unsuspendingAllTabs');
      } else if (action === 'suspendAll') {
        bulkTitle.textContent = getMessage('suspendingAllTabs');
      } else {
        bulkTitle.textContent = getMessage('bulkProgress');
      }
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

  // --- helper to add to whitelist ---
  async function modifyWhitelist(entry) {
    const { [STORAGE_KEY]: cfg = {} } = await chrome.storage.sync.get(STORAGE_KEY);
    cfg.whitelist = cfg.whitelist || [];
    if (!cfg.whitelist.includes(entry)) {
      cfg.whitelist.push(entry);
      await chrome.storage.sync.set({ [STORAGE_KEY]: cfg });
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
      await chrome.runtime.sendMessage({ command: 'updateSettings', settings: cfg });
    }
  }
})();
