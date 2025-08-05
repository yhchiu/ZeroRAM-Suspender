// background.js - ZeroRAM Suspender service worker
// Uses Manifest V3 service worker
// Handles automatic suspension and user commands.

// ==== Storage Keys ====
const DEFAULT_SETTINGS = {
  autoSuspendMinutes: 30, // 0 = never
  useNativeDiscard: true, // true = chrome.tabs.discard, false = placeholder page
  whitelist: [], // array of strings (exact url or domain)
  neverSuspendAudio: true, // never suspend tabs playing audio
  neverSuspendPinned: true, // never suspend pinned tabs
  neverSuspendActive: false, // never suspend active tab in each window
};

const STORAGE_KEY = 'utsSettings';
const TEMP_KEY = 'utsTempWhitelist';

// In-memory cache for temporary whitelist
let tempWhitelist = [];

// Map<tabId, lastSeenTimestamp> persisted across restarts
let seenTimestamps = {};

// Track tabs that are currently being unsuspended to prevent re-suspension
let unsuspendingTabs = new Set();

// Track tabs that are being suspended and waiting for discard
let pendingDiscardTabs = new Map(); // tabId -> {settings, resolve}

// Alarm period (minutes)
const ALARM_PERIOD_MINUTES = 1; // must be >=1 for chrome.alarms

let running = false;

// Helper: load settings
async function getSettings() {
  const { [STORAGE_KEY]: saved } = await chrome.storage.sync.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

// Helper: save settings
async function saveSettings(settings) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

// Helper: internal URL check
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

// Helper: whitelist check
function isWhitelisted(url, settings) {
  if (!url) return false;
  if (isInternalUrl(url)) return true; // never suspend internal pages
  if (tempWhitelist.includes(url)) return true; // temporary whitelist (exact url)

  const u = new URL(url);
  return settings.whitelist.some(entry => {
    if (!entry) return false;
    if (entry.startsWith('http')) {
      return url.startsWith(entry);
    }
    // treat as domain
    return u.hostname === entry || u.hostname.endsWith('.' + entry);
  });
}

// === Suspension Logic ===
async function suspendTab(tab, settings) {
  if (isInternalUrl(tab.url)) return; // skip internal pages

  // Always switch to lightweight placeholder first
  await suspendWithPlaceholder(tab);

  // If user enables native discard and tab is NOT active, discard after placeholder is loaded
  if (settings.useNativeDiscard && !tab.active) {
    try {
      // Wait for the suspended.html page to fully load before discarding
      await waitForTabLoaded(tab.id, settings);
      
      // Check again if tab is still inactive before discarding
      // (user might have clicked on it during loading)
      const currentTab = await chrome.tabs.get(tab.id);
      if (!currentTab.active) {
        await chrome.tabs.discard(tab.id);
      }
    } catch (e) {
      // Discard may fail for active tab or if tab was closed; ignore gracefully
      console.warn('Discard failed (may be active tab or tab closed)', e);
    }
  }
}

// Wait for tab to finish loading the suspended.html page
async function waitForTabLoaded(tabId, settings) {
  return new Promise((resolve, reject) => {
    // Set up timeout as fallback (max 10 seconds)
    const timeout = setTimeout(() => {
      pendingDiscardTabs.delete(tabId);
      resolve(); // Resolve anyway to prevent hanging
    }, 10000);

    // Store the resolve function to be called when tab finishes loading
    pendingDiscardTabs.set(tabId, { 
      settings, 
      resolve: () => {
        clearTimeout(timeout);
        pendingDiscardTabs.delete(tabId);
        resolve();
      }
    });

    // Check if tab is already loaded (race condition handling)
    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.status === 'complete' && 
          tab.url && tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) {
        // Tab is already loaded
        const pendingInfo = pendingDiscardTabs.get(tabId);
        if (pendingInfo) {
          pendingInfo.resolve();
        }
      }
    }).catch(() => {
      // Tab might have been closed, just resolve
      const pendingInfo = pendingDiscardTabs.get(tabId);
      if (pendingInfo) {
        pendingInfo.resolve();
      }
    });
  });
}

async function suspendWithPlaceholder(tab) {
  const suspendedUrl = chrome.runtime.getURL('suspended.html') +
    `?uri=${encodeURIComponent(tab.url)}&ttl=${encodeURIComponent(tab.title)}` +
    (tab.favIconUrl ? `&favicon=${encodeURIComponent(tab.favIconUrl)}` : '');
  await chrome.tabs.update(tab.id, { url: suspendedUrl });
}

// Timer to check for inactivity
async function checkTabs() {
  const settings = await getSettings();
  if (settings.autoSuspendMinutes === 0) return; // never auto suspend

  const autoSuspendTime = settings.autoSuspendMinutes * 60 * 1000;
  const tabs = await chrome.tabs.query({ discarded: false });
  
  // Get the focused window and active tab in focused window
  const windows = await chrome.windows.getAll();
  const focusedWindow = windows.find(w => w.focused);
  let focusedWindowActiveTabId = null;
  
  if (focusedWindow) {
    const activeTabs = await chrome.tabs.query({ windowId: focusedWindow.id, active: true });
    if (activeTabs.length > 0) {
      focusedWindowActiveTabId = activeTabs[0].id;
    }
  }
  
  // This variable is no longer needed as we handle active tab protection in the main loop
  
  for (const tab of tabs) {
    // Ignore placeholder or internal pages
    if (tab.url.startsWith(chrome.runtime.getURL('suspended.html')) || isInternalUrl(tab.url)) {
      continue;
    }
    
    // Skip tabs that are currently being unsuspended
    if (unsuspendingTabs.has(tab.id)) {
      continue;
    }
    
    if (isWhitelisted(tab.url, settings)) continue;

    // Check new suspension prevention settings
    if (settings.neverSuspendAudio && tab.audible) {
      continue; // Skip tabs that are playing audio
    }
    
    if (settings.neverSuspendPinned && tab.pinned) {
      continue; // Skip pinned tabs
    }
    
    // Handle active tab protection based on settings
    if (tab.active) {
      if (settings.neverSuspendActive) {
        // If neverSuspendActive is enabled, protect active tabs in all windows
        continue;
      } else {
        // Default behavior: only protect active tab in the currently focused window
        if (tab.id === focusedWindowActiveTabId) {
          continue;
        }
        // Active tabs in non-focused windows can be suspended
      }
    }

    // Get both timestamps
    const chromeTimestamp = tab.lastAccessed;
    const ourTimestamp = seenTimestamps[tab.id];

    let last;
    if (typeof chromeTimestamp === 'number' && typeof ourTimestamp === 'number') {
      // Both timestamps exist, use the more recent one
      last = Math.max(chromeTimestamp, ourTimestamp);
    } else if (typeof ourTimestamp === 'number') {
      // Only our timestamp exists
      last = ourTimestamp;
    } else if (typeof chromeTimestamp === 'number') {
      // Only Chrome timestamp exists
      last = chromeTimestamp;
    } else {
      // Neither exists, set current time and skip suspension check
      seenTimestamps[tab.id] = Date.now();
      continue;
    }

    if (last < (Date.now() - autoSuspendTime)) {
      await suspendTab(tab, settings);
    }
  }
  // Persist any updates
  saveSeenTimestamps();
}

// ==== Event Handlers ====
chrome.runtime.onInstalled.addListener(async () => {
  // Ensure defaults saved on install/update
  const settings = await getSettings();
  await saveSettings(settings);
  const { [TEMP_KEY]: tmp = [] } = await chrome.storage.session.get(TEMP_KEY);
  tempWhitelist = tmp;
});

// Also load on service worker startup (cold start)
(async () => {
  const { [TEMP_KEY]: tmp = [] } = await chrome.storage.session.get(TEMP_KEY);
  tempWhitelist = tmp;
  const { utsSeen = {} } = await chrome.storage.session.get('utsSeen');
  seenTimestamps = utsSeen;
})();

chrome.tabs.onActivated.addListener(activeInfo => {
  seenTimestamps[activeInfo.tabId] = Date.now();
  saveSeenTimestamps();
  // Attempt to re-discard any suspended placeholder tabs that are no longer active
  reDiscardInactiveSuspendedTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    seenTimestamps[tabId] = Date.now();
    saveSeenTimestamps();
    
    // If tab was being unsuspended and is now complete, remove from tracking
    if (unsuspendingTabs.has(tabId)) {
      unsuspendingTabs.delete(tabId);
    }
    
    // If tab was waiting for discard and suspended.html is now loaded, trigger discard
    if (pendingDiscardTabs.has(tabId) && tab.url && 
        tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) {
      const pendingInfo = pendingDiscardTabs.get(tabId);
      if (pendingInfo) {
        pendingInfo.resolve();
      }
    }
  }
  
  // Track tabs that are being unsuspended (URL changed from suspended.html to original URL)
  if (changeInfo.url && unsuspendingTabs.has(tabId)) {
    const suspendedPrefix = chrome.runtime.getURL('suspended.html');
    if (!changeInfo.url.startsWith(suspendedPrefix)) {
      // URL has changed from suspended.html to original URL, keep tracking until complete
    }
  }
  
  if (changeInfo.active === false) {
    // Tab became inactive
    reDiscardInactiveSuspendedTabs();
  }
});

// Clean up tracking when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  unsuspendingTabs.delete(tabId);
  
  // Clean up pending discard if tab is closed
  if (pendingDiscardTabs.has(tabId)) {
    const pendingInfo = pendingDiscardTabs.get(tabId);
    if (pendingInfo) {
      pendingInfo.resolve(); // Resolve to prevent hanging promises
    }
    pendingDiscardTabs.delete(tabId);
  }
  
  delete seenTimestamps[tabId];
  saveSeenTimestamps();
});

// Receive commands from popup/options
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.command === 'suspendTab') {
      const tab = await chrome.tabs.get(msg.tabId);
      const settings = await getSettings();
      await suspendTab(tab, settings);
      sendResponse({ done: true });
    } else if (msg.command === 'unsuspendTab') {
      // Start tracking this tab as being unsuspended
      await unsuspendTabWithUrl(msg.tabId, msg.originalUrl);
      sendResponse({ done: true });
    } else if (msg.command === 'suspendOthers') {
      // Suspend other tabs in current window only
      await suspendOthersInWindow(msg.tabId);
      sendResponse({ done: true });
    } else if (msg.command === 'unsuspendAll') {
      await unsuspendAllTabs();
      sendResponse({ done: true });
    } else if (msg.command === 'unsuspendAllThisWindow') {
      // Unsuspend all suspended tabs in current window only
      const currentTab = await chrome.tabs.get(msg.tabId);
      await unsuspendAllTabsInWindow(currentTab.windowId);
      sendResponse({ done: true });
    } else if (msg.command === 'updateSettings') {
      await saveSettings(msg.settings);
      sendResponse({ done: true });
    } else if (msg.command === 'toggleTempWhitelist') {
      const url = msg.url;
      const idx = tempWhitelist.indexOf(url);
      if (idx === -1) {
        tempWhitelist.push(url);
      } else {
        tempWhitelist.splice(idx, 1);
      }
      await chrome.storage.session.set({ [TEMP_KEY]: tempWhitelist });
      sendResponse({ whitelisted: tempWhitelist.includes(url) });
    } else if (msg.command === 'checkTempWhitelist') {
      const whitelisted = tempWhitelist.includes(msg.url);
      sendResponse({ whitelisted });
    } else if (msg.command === 'suspendSelectedTabs') {
      // Force suspend selected tabs (ignore whitelist but respect internal URLs)
      await suspendSelectedTabs(msg.tabIds);
      sendResponse({ done: true });
    } else if (msg.command === 'unsuspendSelectedTabs') {
      // Force unsuspend selected tabs
      await unsuspendSelectedTabs(msg.tabIds);
      sendResponse({ done: true });
    } else if (msg.command === 'suspendAllOthersAllWindows') {
      // Suspend all other tabs across all windows (respects suspension prevention settings)
      await suspendOthersInAllWindows(msg.tabId);
      sendResponse({ done: true });
    } else if (msg.command === 'startUnsuspending') {
      // Get the current tab ID from sender
      const tabId = sender.tab ? sender.tab.id : msg.tabId;
      if (tabId) {
        unsuspendingTabs.add(tabId);
      }
      sendResponse({ done: true });
    }
  })();
  // indicate async
  return true;
});

// Schedule repeating alarm every minute to ensure worker wakes up even when inactive
function scheduleCheckAlarm() {
  chrome.alarms.create('utsAutoCheck', { periodInMinutes: ALARM_PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(scheduleCheckAlarm);
chrome.runtime.onStartup.addListener(scheduleCheckAlarm);

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== 'utsAutoCheck') return;
  if (running) return;          // if running, skip this alarm
  running = true;
  try {
    await checkTabs();
  } finally {
    running = false;
  }
});

// Utility: re-discard suspended placeholder tabs that are no longer active
async function reDiscardInactiveSuspendedTabs() {
  const settings = await getSettings();
  if (!settings.useNativeDiscard) return;
  const suspendedPrefix = chrome.runtime.getURL('suspended.html');
  const candidates = await chrome.tabs.query({ active: false, discarded: false });
  for (const t of candidates) {
    // Skip tabs that are currently being unsuspended
    if (unsuspendingTabs.has(t.id)) continue;
    
    if (t.url && t.url.startsWith(suspendedPrefix)) {
      try {
        await chrome.tabs.discard(t.id);
      } catch (e) {
        console.warn('Re-discard failed', e);
      }
    }
  }
}

// Unsuspend a single tab by tab ID
async function unsuspendTabById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) {
    const urlParams = new URLSearchParams(tab.url.split('?')[1]);
    const original = urlParams.get('uri');
    if (original) {
      unsuspendingTabs.add(tabId);
      // Update timestamp immediately to prevent re-suspension
      seenTimestamps[tabId] = Date.now();
      saveSeenTimestamps();
      await chrome.tabs.update(tabId, { url: original });
      return true;
    }
  }
  return false;
}

// Unsuspend a tab using original URL (for message handler)
async function unsuspendTabWithUrl(tabId, originalUrl) {
  unsuspendingTabs.add(tabId);
  // Update timestamp immediately to prevent re-suspension
  seenTimestamps[tabId] = Date.now();
  saveSeenTimestamps();
  await chrome.tabs.update(tabId, { url: originalUrl });
}

// Suspend other tabs in the same window
async function suspendOthersInWindow(currentTabId) {
  const currentTab = await chrome.tabs.get(currentTabId);
  // Get all tabs in the window, including discarded ones
  const tabs = await chrome.tabs.query({ windowId: currentTab.windowId });
  const settings = await getSettings();
  
  for (const tab of tabs) {
    if (tab.id !== currentTabId && !tab.active && !isInternalUrl(tab.url)) {
      // Skip if tab is already suspended by our extension
      if (tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) continue;
      
      // Check suspension prevention settings
      if (settings.neverSuspendAudio && tab.audible) continue;
      if (settings.neverSuspendPinned && tab.pinned) continue;
      if (!isWhitelisted(tab.url, settings)) {
        await suspendTab(tab, settings);
      }
    }
  }
}

// Suspend other tabs in all windows
async function suspendOthersInAllWindows(currentTabId) {
  // Get all tabs, including discarded ones
  const allTabs = await chrome.tabs.query({});
  const settings = await getSettings();
  
  // Get the focused window and active tab in focused window for consistent logic
  const windows = await chrome.windows.getAll();
  const focusedWindow = windows.find(w => w.focused);
  let focusedWindowActiveTabId = null;
  
  if (focusedWindow) {
    const activeTabs = await chrome.tabs.query({ windowId: focusedWindow.id, active: true });
    if (activeTabs.length > 0) {
      focusedWindowActiveTabId = activeTabs[0].id;
    }
  }
  
  for (const tab of allTabs) {
    if (tab.id !== currentTabId && !isInternalUrl(tab.url)) {
      // Skip if tab is already suspended by our extension
      if (tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) continue;
      
      // Check suspension prevention settings
      if (settings.neverSuspendAudio && tab.audible) continue;
      if (settings.neverSuspendPinned && tab.pinned) continue;
      if (!isWhitelisted(tab.url, settings)) {
        // Handle active tab protection based on settings (same logic as checkTabs)
        if (tab.active) {
          if (settings.neverSuspendActive) {
            // If neverSuspendActive is enabled, protect active tabs in all windows
            continue;
          } else {
            // Default behavior: only protect active tab in the currently focused window
            if (tab.id === focusedWindowActiveTabId) {
              continue;
            }
            // Active tabs in non-focused windows can be suspended
          }
        }
        
        await suspendTab(tab, settings);
      }
    }
  }
}

// Unsuspend all tabs in all windows
async function unsuspendAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) {
      const urlParams = new URLSearchParams(tab.url.split('?')[1]);
      const original = urlParams.get('uri');
      if (original) {
        unsuspendingTabs.add(tab.id);
        // Update timestamp immediately to prevent re-suspension
        seenTimestamps[tab.id] = Date.now();
        await chrome.tabs.update(tab.id, { url: original });
      }
    }
  }
  saveSeenTimestamps();
}

// Unsuspend all tabs in a specific window
async function unsuspendAllTabsInWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId: windowId });
  for (const tab of tabs) {
    if (tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) {
      const urlParams = new URLSearchParams(tab.url.split('?')[1]);
      const original = urlParams.get('uri');
      if (original) {
        unsuspendingTabs.add(tab.id);
        // Update timestamp immediately to prevent re-suspension
        seenTimestamps[tab.id] = Date.now();
        await chrome.tabs.update(tab.id, { url: original });
      }
    }
  }
  saveSeenTimestamps();
}

// Suspend selected tabs (force suspend, ignore whitelist but respect internal URLs)
async function suspendSelectedTabs(tabIds) {
  const settings = await getSettings();
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isInternalUrl(tab.url)) {
        await suspendTab(tab, settings);
      }
    } catch (error) {
      console.warn(`Failed to suspend tab ${tabId}:`, error);
    }
  }
}

// Unsuspend selected tabs
async function unsuspendSelectedTabs(tabIds) {
  for (const tabId of tabIds) {
    try {
      await unsuspendTabById(tabId);
    } catch (error) {
      console.warn(`Failed to unsuspend tab ${tabId}:`, error);
    }
  }
}

// Toggle suspend/unsuspend for a single tab
async function toggleTabSuspension(tab) {
  if (tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) {
    // Unsuspend the tab
    return await unsuspendTabById(tab.id);
  } else {
    // Suspend the tab
    const settings = await getSettings();
    if (!isInternalUrl(tab.url)) {
      await suspendTab(tab, settings);
      return true;
    }
  }
  return false;
}

// Helper to save seen timestamps (debounced via alarm interval)
function saveSeenTimestamps() {
  chrome.storage.session.set({ utsSeen: seenTimestamps });
}

// Handle keyboard shortcuts from commands API
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab || !tab.id) return;
  
  try {
    switch (command) {
      case '01-toggle-suspend':
        await toggleTabSuspension(tab);
        break;
        
      case '02-suspend-others-window':
        await suspendOthersInWindow(tab.id);
        break;
        
      case '03-suspend-others-all':
        await suspendOthersInAllWindows(tab.id);
        break;
        
      case '04-unsuspend-all-window':
        await unsuspendAllTabsInWindow(tab.windowId);
        break;
        
      case '05-unsuspend-all':
        await unsuspendAllTabs();
        break;
        
      default:
        return; // Unknown command
    }
  } catch (error) {
    console.error('Failed to execute shortcut command:', error);
  }
}); 