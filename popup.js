// popup.js - build popup UI
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const suspendedPrefix = chrome.runtime.getURL('suspended.html');
  const STORAGE_KEY = 'utsSettings';

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

  // Check for selected tabs (highlighted tabs)
  async function getSelectedTabs() {
    const selectedTabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
    return selectedTabs;
  }

  const { [STORAGE_KEY]: settings = {} } = await chrome.storage.sync.get(STORAGE_KEY);

  const isPlaceholder = tab.url.startsWith(suspendedPrefix);
  const isInternal = isInternalUrl(tab.url);
  const isWhitelistedUrl = isWhitelisted(tab.url, settings);
  const matchedWhitelistEntry = getMatchedWhitelistEntry(tab.url, settings);
  const cannotSuspend = isInternal || isWhitelistedUrl;
  const bannerEl = document.getElementById('banner');
  const menuEl = document.getElementById('menu');

  // Bulk progress UI elements
  const bulkBox = document.getElementById('bulkProgress');
  const bulkFill = document.getElementById('bulkProgressFill');
  const bulkText = document.getElementById('bulkProgressText');
  const bulkTitle = document.getElementById('bulkProgressTitle');
  const bulkLabel = document.getElementById('bulkProgressLabel');
  const bulkCancelBtn = document.getElementById('bulkCancelBtn');

  // Connect a long-lived port for receiving background progress updates
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

  // Check for multiple selected tabs
  const selectedTabs = await getSelectedTabs();
  const hasMultipleSelected = selectedTabs.length > 1;

  // Fetch temporary whitelist status
  const { whitelisted: tempWhite } = await chrome.runtime.sendMessage({ command: 'checkTempWhitelist', url: tab.url });

  let bannerTextEl = document.createElement('span');
  bannerEl.appendChild(bannerTextEl);
  let actionLink = document.createElement('a');
  actionLink.href = '#';
  actionLink.style.color = '#fff';
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
    if (iconType) {
      li.setAttribute('data-icon', iconType);
    }
    li.addEventListener('click', async () => {
      await onClick();
      if (closeOnClick) {
        window.close();
      }
    });
    menuEl.appendChild(li);
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
    menuEl.appendChild(document.createElement('hr'));
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
      menuEl.appendChild(document.createElement('hr'));
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

  menuEl.appendChild(document.createElement('hr'));
  addItem(getMessage('settingsMenu'), async () => {
    await chrome.runtime.openOptionsPage();
  }, 'settings');

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