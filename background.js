// background.js - ZeroRAM Suspender service worker
// Uses Manifest V3 service worker
// Handles automatic suspension and user commands.

// ==== Storage Keys ====
const DEFAULT_SETTINGS = {
  autoSuspendMinutes: 30, // 0 = never
  useNativeDiscard: true, // true = chrome.tabs.discard, false = placeholder page
  whitelist: [], // array of strings (exact url or domain)
};

const STORAGE_KEY = 'utsSettings';
const TEMP_KEY = 'utsTempWhitelist';

// In-memory cache for temporary whitelist
let tempWhitelist = [];

// Map<tabId, lastSeenTimestamp> persisted across restarts
let seenTimestamps = {};

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
      // Give Chrome a tiny delay to register new URL
      await new Promise(r => setTimeout(r, 200));
      await chrome.tabs.discard(tab.id);
    } catch (e) {
      // Discard may fail for active tab; ignore gracefully
      console.warn('Discard failed (may be active tab)', e);
    }
  }
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

  const threshold = Date.now() - settings.autoSuspendMinutes * 60 * 1000;
  const tabs = await chrome.tabs.query({ discarded: false });
  for (const tab of tabs) {
    // Ignore active, placeholder, or internal pages
    if (tab.active || tab.url.startsWith(chrome.runtime.getURL('suspended.html')) || isInternalUrl(tab.url)) {
      continue;
    }
    if (isWhitelisted(tab.url, settings)) continue;

    let last = tab.lastAccessed;
    if (typeof last !== 'number') {
      // Use our own persisted tracking for tabs that have never been active
      last = seenTimestamps[tab.id];
      if (last === undefined) {
        last = Date.now();
        seenTimestamps[tab.id] = last;
      }
    }
    if (last < threshold) {
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
  }
  if (changeInfo.active === false) {
    // Tab became inactive
    reDiscardInactiveSuspendedTabs();
  }
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
      await chrome.tabs.update(msg.tabId, { url: msg.originalUrl });
      sendResponse({ done: true });
    } else if (msg.command === 'suspendOthers') {
      const currentTabId = msg.tabId;
      const tabs = await chrome.tabs.query({ discarded: false });
      const settings = await getSettings();
      for (const tab of tabs) {
        if (tab.id !== currentTabId && !tab.active) {
          await suspendTab(tab, settings);
        }
      }
      sendResponse({ done: true });
    } else if (msg.command === 'unsuspendAll') {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url.startsWith(chrome.runtime.getURL('suspended.html'))) {
          const urlParams = new URLSearchParams(tab.url.split('?')[1]);
          const original = urlParams.get('uri');
          if (original) {
            await chrome.tabs.update(tab.id, { url: original });
          }
        }
      }
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
    if (t.url && t.url.startsWith(suspendedPrefix)) {
      try {
        await chrome.tabs.discard(t.id);
      } catch (e) {
        console.warn('Re-discard failed', e);
      }
    }
  }
}

// Helper to save seen timestamps (debounced via alarm interval)
function saveSeenTimestamps() {
  chrome.storage.session.set({ utsSeen: seenTimestamps });
} 