// background.js - ZeroRAM Suspender service worker
// Uses Manifest V3 service worker
// Handles automatic suspension and user commands.

// ==== Storage Keys ====
const FAVICON_FIX_DEFAULT_BATCH_SIZE = 50;

const DEFAULT_SETTINGS = {
  autoSuspendMinutes: 30, // 0 = never
  useNativeDiscard: true, // true = chrome.tabs.discard, false = placeholder page
  whitelist: [], // array of strings (exact url or domain)
  neverSuspendAudio: true, // never suspend tabs playing audio
  neverSuspendPinned: true, // never suspend pinned tabs
  neverSuspendActive: false, // never suspend active tab in each window
  rememberLastActiveTab: true, // remember last active tab when browser loses focus
  clickAnywhereToUnsuspend: false, // allow clicking anywhere on the suspended page to unsuspend
  // How a suspended tab is marked in the tab strip:
  //   'favicon'     = render the site favicon 50% transparent (default)
  //   'titlePrefix' = keep the favicon at full opacity, prefix the title with 💤
  suspendedIndicatorMode: 'favicon',
  // Favicon fix processor settings
  fixFaviconEnabled: true, // enable suspended favicon fixing
  fixFaviconBatchSize: FAVICON_FIX_DEFAULT_BATCH_SIZE, // 0 = unlimited per checkTabs batch
  fixFaviconMaxRetries: 5, // max attempts per tab to avoid infinite reloads
  suspendBatchConcurrency: 5, // batch concurrency limit for bulk operations
};

const STORAGE_KEY = 'utsSettings';
const TEMP_KEY = 'utsTempWhitelist';
const LAST_ACTIVE_TAB_KEY = 'utsLastActiveTab';

// Constant prefix for our suspended page URL to avoid repeated getURL calls
const SUSPENDED_PREFIX = chrome.runtime.getURL('suspended.html');
const DISCARD_READY_TIMEOUT_MS = 10000;
// After suspended.js signals it set the favicon link, we poll tab.favIconUrl
// to confirm Chrome's browser process actually registered a real favicon before
// discarding. Verifying the captured favIconUrl — instead of blindly trusting a
// single fixed delay — is what prevents discarding a tab before its icon lands,
// which is what made Chrome fall back to the extension icon. After the bounded
// number of attempts we mark ready anyway (best effort: the page likely has no
// usable favicon, so waiting longer would not help).
const FAVICON_CONFIRM_INTERVAL_MS = 200;
const FAVICON_CONFIRM_MAX_ATTEMPTS = 15;
// Chrome needs time to process the image internally after the favicon URL is
// updated before the tab can be safely discarded.
const FAVICON_CAPTURE_DELAY_MS = 200;
const EXTENSION_DEFAULT_FAVICON_URLS = new Set(
  getExtensionIconPaths().map(path => chrome.runtime.getURL(path))
);

// In-memory cache for temporary whitelist
let tempWhitelist = new Set();

// Map<tabId, lastSeenTimestamp> persisted across restarts
let seenTimestamps = {};

// Track tabs that are currently being unsuspended to prevent re-suspension
let unsuspendingTabs = new Set();

// Track tabs that are being suspended and waiting for discard
let pendingDiscardTabs = new Map(); // tabId -> pending favicon/page readiness state
let suspendedFaviconReadyTabs = new Set(); // tab IDs whose suspended favicon is ready

// Track last active tab for remembering when browser loses focus
let lastActiveTabId = null;

// Track last active tab per window to handle inactive tab timestamp updates
let lastActiveTabPerWindow = new Map(); // windowId -> { tabId, timestamp }
// Track focused window transitions so we can stamp the previous window's active tab
let lastFocusedWindowId = chrome.windows.WINDOW_ID_NONE;

// Track tabs with no favicon (normally caused by lazy loaded after browser restart)
let fixFaviconTabs = new Set(); // tabId set for tabs with no favicon
// Retry counts to prevent infinite attempts: Map<tabId, count>
let fixFaviconRetryCounts = new Map();
// Event-driven re-discard queue (avoids full inactive-tab scans on frequent events)
let pendingReDiscardTabIds = new Set();
let reDiscardRetryCounts = new Map(); // Map<tabId, count>

// Alarm period (minutes)
const ALARM_PERIOD_MINUTES = 1; // must be >=1 for chrome.alarms

let running = false;

// Keep popup ports to stream bulk progress
const popupPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  }
});

function postBulkProgress(payload) {
  // payload: { action, processed, total, done? }
  try {
    for (const p of popupPorts) {
      p.postMessage({ type: 'bulkProgress', ...payload });
    }
  } catch (_) {}
}

// Bulk cancel control
let bulkCancelToken = { cancelled: false };
function newCancelToken() {
  bulkCancelToken = { cancelled: false };
  return bulkCancelToken;
}
function cancelBulkNow() {
  bulkCancelToken.cancelled = true;
  // Fast-resolve any waits for discard so current iteration can exit sooner
  try {
    for (const [tabId, pendingInfo] of pendingDiscardTabs) {
      if (pendingInfo && typeof pendingInfo.resolve === 'function') {
        pendingInfo.resolve();
      }
    }
  } catch (_) {}
}

// Helper: load settings
async function getSettings() {
  const { [STORAGE_KEY]: saved } = await chrome.storage.sync.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

// Cached settings to reduce frequent storage reads
let cachedSettings = null;
let cachedAtMs = 0;
const SETTINGS_CACHE_MS = 5000;
// Compiled whitelist cache to avoid O(tabs * whitelist) string scans
let compiledWhitelistSource = null; // points to settings.whitelist array reference
let compiledWhitelistLooseUrlPrefixes = []; // url prefixes that fail host bucketing
let compiledWhitelistUrlPrefixesByHost = new Map(); // hostname -> string[]
let compiledWhitelistDomains = new Set();

async function getSettingsCached() {
  const now = Date.now();
  if (cachedSettings && (now - cachedAtMs) < SETTINGS_CACHE_MS) {
    return cachedSettings;
  }
  cachedSettings = await getSettings();
  cachedAtMs = now;
  return cachedSettings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEY]) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue || {}) };
    cachedAtMs = Date.now();
    // Invalidate compiled whitelist cache when settings change.
    compiledWhitelistSource = null;
  }
});

// Helper: save settings
async function saveSettings(settings) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

function setTempWhitelistFromStorageValue(value) {
  if (!Array.isArray(value)) {
    tempWhitelist = new Set();
    return;
  }
  const cleaned = value.filter(v => typeof v === 'string' && v.length > 0);
  tempWhitelist = new Set(cleaned);
}

async function persistTempWhitelist() {
  await chrome.storage.session.set({ [TEMP_KEY]: Array.from(tempWhitelist) });
}

// Helper: save last active tab ID
async function saveLastActiveTab() {
  await chrome.storage.session.set({ [LAST_ACTIVE_TAB_KEY]: lastActiveTabId });
}

// Helper: load last active tab ID
async function loadLastActiveTab() {
  const { [LAST_ACTIVE_TAB_KEY]: saved } = await chrome.storage.session.get(LAST_ACTIVE_TAB_KEY);
  lastActiveTabId = saved || null;
}

const LAST_ACTIVE_PER_WINDOW_KEY = 'utsLastActiveTabPerWindow';

// Persist lastActiveTabPerWindow to session storage and update in-memory map.
function setLastActiveTabInWindow(windowId, data) {
  lastActiveTabPerWindow.set(windowId, data);
  chrome.storage.session.set({
    [LAST_ACTIVE_PER_WINDOW_KEY]: Object.fromEntries(lastActiveTabPerWindow)
  });
}

// Remove a window entry from lastActiveTabPerWindow and persist the change.
function removeLastActiveTabInWindow(windowId) {
  lastActiveTabPerWindow.delete(windowId);
  chrome.storage.session.set({
    [LAST_ACTIVE_PER_WINDOW_KEY]: Object.fromEntries(lastActiveTabPerWindow)
  });
}

// Restore lastActiveTabPerWindow from session storage on cold start.
async function loadLastActiveTabPerWindow() {
  const { [LAST_ACTIVE_PER_WINDOW_KEY]: saved } =
    await chrome.storage.session.get(LAST_ACTIVE_PER_WINDOW_KEY);
  if (saved) {
    lastActiveTabPerWindow = new Map(
      Object.entries(saved).map(([k, v]) => [Number(k), v])
    );
  }
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

function isTabGoneError(error) {
  const message = String((error && error.message) || error || '');
  return message.includes('No tab with id') || message.includes('Invalid tab ID');
}

function logUnexpectedTabError(context, error) {
  if (isTabGoneError(error)) return;
  console.warn(`[ZeroRAM Suspender] ${context}:`, error);
}

function compileWhitelist(whitelist) {
  compiledWhitelistLooseUrlPrefixes = [];
  compiledWhitelistUrlPrefixesByHost = new Map();
  compiledWhitelistDomains = new Set();
  compiledWhitelistSource = whitelist;

  if (!Array.isArray(whitelist) || whitelist.length === 0) return;

  for (const rawEntry of whitelist) {
    if (typeof rawEntry !== 'string') continue;
    const entry = rawEntry.trim();
    if (!entry) continue;

    if (entry.startsWith('http')) {
      // Keep exact prefix semantics for full URL entries.
      // Bucket by hostname so matching does not scan all URL prefixes.
      try {
        const parsed = new URL(entry);
        const host = (parsed.hostname || '').toLowerCase();
        if (host) {
          const arr = compiledWhitelistUrlPrefixesByHost.get(host);
          if (arr) {
            arr.push(entry);
          } else {
            compiledWhitelistUrlPrefixesByHost.set(host, [entry]);
          }
        } else {
          compiledWhitelistLooseUrlPrefixes.push(entry);
        }
      } catch (_) {
        // Keep behavior for non-standard but still string-prefix entries.
        compiledWhitelistLooseUrlPrefixes.push(entry);
      }
    } else {
      // Domain matcher uses normalized lowercase host segments.
      compiledWhitelistDomains.add(entry.toLowerCase());
    }
  }
}

function ensureCompiledWhitelist(settings) {
  const whitelist = Array.isArray(settings.whitelist) ? settings.whitelist : [];
  if (compiledWhitelistSource !== whitelist) {
    compileWhitelist(whitelist);
  }
}

function isHostnameWhitelisted(hostname) {
  if (!hostname || compiledWhitelistDomains.size === 0) return false;
  let current = hostname.toLowerCase();
  while (current) {
    if (compiledWhitelistDomains.has(current)) return true;
    const dot = current.indexOf('.');
    if (dot === -1) break;
    current = current.slice(dot + 1);
  }
  return false;
}

// Helper: whitelist check
function isWhitelisted(url, settings) {
  if (!url) return false;
  if (isInternalUrl(url)) return true; // never suspend internal pages
  if (tempWhitelist.has(url)) return true; // temporary whitelist (exact url)

  ensureCompiledWhitelist(settings);

  for (const prefix of compiledWhitelistLooseUrlPrefixes) {
    if (url.startsWith(prefix)) return true;
  }

  if (
    compiledWhitelistDomains.size === 0 &&
    compiledWhitelistUrlPrefixesByHost.size === 0
  ) {
    return false;
  }

  try {
    const u = new URL(url);
    const host = (u.hostname || '').toLowerCase();
    const hostPrefixes = compiledWhitelistUrlPrefixesByHost.get(host);
    if (hostPrefixes) {
      for (const prefix of hostPrefixes) {
        if (url.startsWith(prefix)) return true;
      }
    }
    return isHostnameWhitelisted(u.hostname);
  } catch (_) {
    return false;
  }
}

// Helper: is suspended tab
function isSuspendedTab(tab) {
  return tab && tab.url && tab.url.startsWith(SUSPENDED_PREFIX);
}

function getExtensionIconPaths() {
  const manifest = chrome.runtime.getManifest();
  const paths = new Set();
  for (const iconSet of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    if (!iconSet || typeof iconSet !== 'object') continue;
    for (const path of Object.values(iconSet)) {
      if (typeof path === 'string' && path) {
        paths.add(path);
      }
    }
  }
  return Array.from(paths);
}

function stripFaviconUrlSuffix(url) {
  if (!url) return '';
  const text = String(url);
  const queryIndex = text.indexOf('?');
  const hashIndex = text.indexOf('#');
  let cutIndex = -1;
  if (queryIndex !== -1) cutIndex = queryIndex;
  if (hashIndex !== -1 && (cutIndex === -1 || hashIndex < cutIndex)) {
    cutIndex = hashIndex;
  }
  return cutIndex === -1 ? text : text.slice(0, cutIndex);
}

function isExtensionDefaultFaviconUrl(favIconUrl) {
  if (!favIconUrl) return false;
  if (EXTENSION_DEFAULT_FAVICON_URLS.has(favIconUrl)) return true;
  return EXTENSION_DEFAULT_FAVICON_URLS.has(stripFaviconUrlSuffix(favIconUrl));
}

function hasUsableSuspendedFavicon(tab) {
  return Boolean(tab && tab.favIconUrl && !isExtensionDefaultFaviconUrl(tab.favIconUrl));
}

function needsSuspendedFaviconFix(tab) {
  return Boolean(
    tab &&
    !tab.active &&
    isSuspendedTab(tab) &&
    (!tab.favIconUrl || isExtensionDefaultFaviconUrl(tab.favIconUrl))
  );
}

// Helper: parse original url from suspended tab
function parseOriginalUrlFromSuspended(suspendedUrl) {
  try {
    if (!suspendedUrl || !suspendedUrl.startsWith(SUSPENDED_PREFIX)) {
      return null;
    }
    const urlObj = new URL(suspendedUrl);
    return urlObj.searchParams.get('uri');
  } catch (error) {
    console.warn('[ZeroRAM Suspender] Failed to parse suspended URL:', error);
    return null;
  }
}

// Stamp a tab as recently seen; returns true when a valid tabId is written
function markTabSeen(tabId, timestamp) {
  if (typeof tabId !== 'number') return false;
  seenTimestamps[tabId] = timestamp;
  return true;
}

// Mark the active tab in a specific window as recently seen.
// Uses cached per-window active tab first; falls back to one window-scoped query.
async function markWindowActiveTabSeen(windowId, timestamp) {
  if (typeof windowId !== 'number' || windowId === chrome.windows.WINDOW_ID_NONE) {
    return false;
  }

  const tracked = lastActiveTabPerWindow.get(windowId);
  if (tracked && markTabSeen(tracked.tabId, timestamp)) {
    return true;
  }

  try {
    const activeTabs = await chrome.tabs.query({ windowId, active: true });
    if (activeTabs.length > 0 && typeof activeTabs[0].id === 'number') {
      const activeTabId = activeTabs[0].id;
      setLastActiveTabInWindow(windowId, { tabId: activeTabId, timestamp });
      return markTabSeen(activeTabId, timestamp);
    }
  } catch (_) {
    // Window may be gone between focus events; ignore.
  }

  return false;
}

// Background process for fixing tab favicon
let fixFaviconProcessor = {
  isRunning: false,
  timeoutId: null,
  
  start() {
    if (this.isRunning || fixFaviconTabs.size === 0) return;
    this.isRunning = true;
    this.processNext();
  },
  
  stop() {
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  },
  
  async processNext() {
    if (!this.isRunning || fixFaviconTabs.size === 0) {
      this.isRunning = false;
      return;
    }
    
    // Get the first tab from the set
    const tabId = fixFaviconTabs.values().next().value;
    fixFaviconTabs.delete(tabId);
    let attemptedReload = false;
    
    try {
      const settings = await getSettingsCached();
      if (!settings.fixFaviconEnabled) {
        this.stop();
        return;
      }

      const tab = await chrome.tabs.get(tabId);
      
      // Force reload tab first, then discard if needed
      if (isSuspendedTab(tab)) {
        // Check again if tab is still inactive 
        // (user might have clicked on it during loading)
        if (!tab.active) {
          attemptedReload = true;
          if (settings.useNativeDiscard) {
            beginSuspendedReadyWait(tabId);
          }
          await chrome.tabs.reload(tabId);

          if (settings.useNativeDiscard) {
            await discardSuspendedTabWhenReady(tabId, 'Favicon fix discard');
          }
        }
      }
    } catch (error) {
      if (attemptedReload) {
        cancelPendingDiscardWait(tabId);
      }
      logUnexpectedTabError('Failed to fix tab favicon', error);
    }
    
    if (attemptedReload && !suspendedFaviconReadyTabs.has(tabId)) {
      const currentRetries = fixFaviconRetryCounts.get(tabId) || 0;
      fixFaviconRetryCounts.set(tabId, currentRetries + 1);
    }
    
    // Schedule next tab processing with 1 second delay
    this.timeoutId = setTimeout(() => {
      this.processNext();
    }, 1000);
  }
};

// === Suspension Logic ===
async function suspendTab(tab, settings) {
  if (isInternalUrl(tab.url)) return; // skip internal pages

  const shouldDiscard = settings.useNativeDiscard && !tab.active;
  if (shouldDiscard) {
    beginSuspendedReadyWait(tab.id);
  }

  // Always switch to lightweight placeholder first
  try {
    await suspendWithPlaceholder(tab);
  } catch (error) {
    if (shouldDiscard) {
      cancelPendingDiscardWait(tab.id);
    }
    throw error;
  }

  // If user enables native discard and tab is NOT active, discard after placeholder is loaded
  if (shouldDiscard) {
    await discardSuspendedTabWhenReady(tab.id, 'Discard after suspend');
  }
}

// Wait for tab to finish loading the suspended.html page, then wait for
// suspended.js to signal favicon readiness before discarding. This prevents the
// browser process from freezing the renderer before it has registered
// the favicon, which would cause the extension's default icon to show.
function beginSuspendedReadyWait(tabId, resetReady = true) {
  if (resetReady) {
    suspendedFaviconReadyTabs.delete(tabId);
  }

  let pendingInfo = pendingDiscardTabs.get(tabId);
  if (pendingInfo) {
    clearTimeout(pendingInfo.timeoutId);
    pendingInfo.pageComplete = false;
    pendingInfo.faviconReady = false;
    pendingInfo.timedOut = false;
  } else {
    pendingInfo = {
      pageComplete: false,
      faviconReady: false,
      timedOut: false,
      generation: 0,
      timeoutId: null,
      promise: null,
      tryResolve() {
        if (this.pageComplete && this.faviconReady) {
          this.resolve({ timedOut: false });
        }
      },
      resolve(result = { timedOut: false }) {
        clearTimeout(this.timeoutId);
        pendingDiscardTabs.delete(tabId);
        this._resolve(result);
      }
    };
    pendingInfo.promise = new Promise(resolve => {
      pendingInfo._resolve = resolve;
    });
    pendingDiscardTabs.set(tabId, pendingInfo);
  }

  pendingInfo.generation += 1;
  const generation = pendingInfo.generation;
  pendingInfo.timeoutId = setTimeout(() => {
    pendingInfo.timedOut = true;
    pendingInfo.resolve({ timedOut: true });
  }, DISCARD_READY_TIMEOUT_MS);

  chrome.tabs.get(tabId).then(tab => {
    const currentPendingInfo = pendingDiscardTabs.get(tabId);
    if (
      !currentPendingInfo ||
      currentPendingInfo !== pendingInfo ||
      currentPendingInfo.generation !== generation
    ) {
      return;
    }
    if (isSuspendedTab(tab) && tab.status === 'complete') {
      currentPendingInfo.pageComplete = true;
      if (suspendedFaviconReadyTabs.has(tabId) || hasUsableSuspendedFavicon(tab)) {
        currentPendingInfo.faviconReady = true;
        suspendedFaviconReadyTabs.add(tabId);
      }
      currentPendingInfo.tryResolve();
    }
  }).catch(() => {
    const currentPendingInfo = pendingDiscardTabs.get(tabId);
    if (
      currentPendingInfo &&
      currentPendingInfo === pendingInfo &&
      currentPendingInfo.generation === generation
    ) {
      currentPendingInfo.resolve({ tabGone: true });
    }
  });

  return pendingInfo.promise;
}

async function waitForTabLoaded(tabId, resetReady = false) {
  const pendingInfo = pendingDiscardTabs.get(tabId);
  return pendingInfo ? pendingInfo.promise : beginSuspendedReadyWait(tabId, resetReady);
}

function cancelPendingDiscardWait(tabId) {
  const pendingInfo = pendingDiscardTabs.get(tabId);
  if (pendingInfo) {
    pendingInfo.resolve({ cancelled: true });
  }
}

function markSuspendedFaviconReady(tabId) {
  if (typeof tabId !== 'number') return;
  suspendedFaviconReadyTabs.add(tabId);
  fixFaviconRetryCounts.delete(tabId);
  const pendingInfo = pendingDiscardTabs.get(tabId);
  if (pendingInfo) {
    pendingInfo.faviconReady = true;
    setTimeout(() => {
      // Re-fetch pendingInfo in case it was cancelled/recreated during the delay
      const currentPendingInfo = pendingDiscardTabs.get(tabId);
      if (currentPendingInfo && currentPendingInfo === pendingInfo) {
        currentPendingInfo.tryResolve();
      }
    }, FAVICON_CAPTURE_DELAY_MS);
  }
}

// suspended.js sends 'faviconReady' the instant it appends the <link rel="icon">,
// but that only means the renderer set the DOM node — not that Chrome captured
// the favicon into tab.favIconUrl (the value snapshotted on discard). Poll until
// Chrome reports a real (non-default) favIconUrl, then mark ready. The onUpdated
// favIconUrl listener usually wins this race; this is the fallback for cases
// where that event does not arrive (e.g. data: URL favicon updates Chrome
// coalesces, or a service-worker wake-up that missed the event).
function confirmSuspendedFaviconReady(tabId, attempt = 0) {
  if (typeof tabId !== 'number') return;
  setTimeout(async () => {
    if (suspendedFaviconReadyTabs.has(tabId)) return; // already confirmed elsewhere
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return; // tab gone
    }
    if (!isSuspendedTab(tab)) return; // navigated away; no longer our placeholder
    if (hasUsableSuspendedFavicon(tab) || attempt + 1 >= FAVICON_CONFIRM_MAX_ATTEMPTS) {
      markSuspendedFaviconReady(tabId);
    } else {
      confirmSuspendedFaviconReady(tabId, attempt + 1);
    }
  }, FAVICON_CONFIRM_INTERVAL_MS);
}

async function discardSuspendedTabWhenReady(tabId, context) {
  try {
    await waitForTabLoaded(tabId);
    const currentTab = await chrome.tabs.get(tabId);
    if (!isSuspendedTab(currentTab) || currentTab.active || currentTab.discarded) {
      return false;
    }
    await chrome.tabs.discard(tabId);
    return true;
  } catch (error) {
    logUnexpectedTabError(`${context} failed`, error);
    return false;
  }
}

async function suspendWithPlaceholder(tab) {
  const suspendedUrl = SUSPENDED_PREFIX +
    `?uri=${encodeURIComponent(tab.url)}&ttl=${encodeURIComponent(tab.title)}` +
    (tab.favIconUrl ? `&favicon=${encodeURIComponent(tab.favIconUrl)}` : '');
  await chrome.tabs.update(tab.id, { url: suspendedUrl });
}

// Timer to check for inactivity
async function checkTabs() {
  const settings = await getSettingsCached();
  if (settings.autoSuspendMinutes === 0) return; // never auto suspend

  const autoSuspendTime = settings.autoSuspendMinutes * 60 * 1000;
  const tabs = await chrome.tabs.query({});
  
  // Check for tab favicon (only when background processor is not running)
  if (!fixFaviconProcessor.isRunning) {
    fixFaviconTabs.clear();

    if (settings.fixFaviconEnabled) {
      const batchSize = Number(settings.fixFaviconBatchSize) || 0; // 0 = unlimited
      let added = 0;
      for (const tab of tabs) {
        if (needsSuspendedFaviconFix(tab)) {
          const retryCount = fixFaviconRetryCounts.get(tab.id) || 0;
          if (settings.fixFaviconMaxRetries > 0 && retryCount >= settings.fixFaviconMaxRetries) {
            continue; // reached retry limit
          }
          fixFaviconTabs.add(tab.id);
          added++;
          if (batchSize > 0 && added >= batchSize) break; // limit batch per checkTabs run
        }
      }

      if (fixFaviconTabs.size > 0) {
        fixFaviconProcessor.start();
      }
    } else {
      // Feature disabled: ensure processor is not running
      fixFaviconProcessor.stop();
    }
  }

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
    // Ignore discarded, placeholder or internal pages
    if (tab.discarded || isSuspendedTab(tab) || isInternalUrl(tab.url)) {
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
    
    // Check if this is the last remembered active tab when browser lost focus
    // This should be checked first, regardless of current active state
    if (settings.rememberLastActiveTab && tab.id === lastActiveTabId && !focusedWindow) {
      continue;
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
      try {
        await suspendTab(tab, settings);
      } catch (error) {
        // Tabs can disappear between query and update/discard operations.
        logUnexpectedTabError('Failed to suspend tab during checkTabs', error);
      }
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
  setTempWhitelistFromStorageValue(tmp);
  // Load last active tab ID
  await loadLastActiveTab();
});

// Also load on service worker startup (cold start)
(async () => {
  const { [TEMP_KEY]: tmp = [] } = await chrome.storage.session.get(TEMP_KEY);
  setTempWhitelistFromStorageValue(tmp);
  const { utsSeen = {} } = await chrome.storage.session.get('utsSeen');
  // Merge persisted timestamps instead of replacing the object.
  // Event handlers (e.g. onActivated) may have already written fresh
  // timestamps into seenTimestamps during the async gap above; a plain
  // assignment would silently discard those writes.
  for (const [key, value] of Object.entries(utsSeen)) {
    if (!(key in seenTimestamps) || seenTimestamps[key] < value) {
      seenTimestamps[key] = value;
    }
  }
  // Load last active tab ID and per-window active tab map from session storage.
  await loadLastActiveTab();
  await loadLastActiveTabPerWindow();

  // Initialize per-window active tab tracking
  try {
    const windows = await chrome.windows.getAll();
    const currentWindowIds = new Set(windows.map(w => w.id));

    // Remove entries for windows that no longer exist.
    for (const winId of lastActiveTabPerWindow.keys()) {
      if (!currentWindowIds.has(winId)) {
        lastActiveTabPerWindow.delete(winId);
      }
    }

    let focusedWindowActiveTabId = null;
    const focusedWindow = windows.find(w => w.focused);
    // Keep startup init from overwriting a newer focus event.
    if (lastFocusedWindowId === chrome.windows.WINDOW_ID_NONE) {
      lastFocusedWindowId = focusedWindow ? focusedWindow.id : chrome.windows.WINDOW_ID_NONE;
    }
    let needsSave = false;
    for (const window of windows) {
      const activeTabs = await chrome.tabs.query({ windowId: window.id, active: true });
      if (activeTabs.length > 0) {
        const activeTab = activeTabs[0];
        // Only seed if not already restored from session storage;
        // overwriting would discard the persisted previous-tab identity.
        if (!lastActiveTabPerWindow.has(window.id)) {
          lastActiveTabPerWindow.set(window.id, {
            tabId: activeTab.id,
            timestamp: Date.now()
          });
          needsSave = true;
        }
        if (focusedWindow && focusedWindow.id === window.id) {
          focusedWindowActiveTabId = activeTab.id;
        }
      }
    }
    // Persist once if anything was added or stale entries removed.
    if (needsSave || lastActiveTabPerWindow.size !== currentWindowIds.size) {
      chrome.storage.session.set({
        [LAST_ACTIVE_PER_WINDOW_KEY]: Object.fromEntries(lastActiveTabPerWindow)
      });
    }
    // Initialize lastActiveTabId to current focused window's active tab (if available)
    if (focusedWindowActiveTabId && lastActiveTabId !== focusedWindowActiveTabId) {
      lastActiveTabId = focusedWindowActiveTabId;
      await saveLastActiveTab();
    }
  } catch (error) {
    console.warn('Failed to initialize per-window active tab tracking:', error);
  }
})();

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const now = Date.now();
  const { tabId, windowId } = activeInfo;
  let previousTabId = null;

  // Handle the previously active tab in this window
  const lastActiveInWindow = lastActiveTabPerWindow.get(windowId);
  if (lastActiveInWindow && lastActiveInWindow.tabId !== tabId) {
    // Update timestamp for the previously active tab to prevent immediate suspension
    seenTimestamps[lastActiveInWindow.tabId] = now;
    previousTabId = lastActiveInWindow.tabId;
  }

  // Update timestamp for the newly activated tab
  seenTimestamps[tabId] = now;
  saveSeenTimestamps();

  // Track the new active tab for this window (persisted to session storage).
  setLastActiveTabInWindow(windowId, { tabId, timestamp: now });

  // Update last active tab when user switches tabs
  if (lastActiveTabId !== tabId) {
    lastActiveTabId = tabId;
    await saveLastActiveTab();
  }
  // Attempt to re-discard only the tab that just became inactive in this window.
  if (previousTabId !== null) {
    scheduleReDiscard(previousTabId);
  }
});

// Track last active tab on focus changes to avoid periodic updates in checkTabs
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const now = Date.now();
  const previousFocusedWindowId = lastFocusedWindowId;
  // Update immediately to avoid races between rapid consecutive focus events.
  lastFocusedWindowId = windowId;

  try {
    let seenUpdated = false;

    // Treat focus transition as inactivity for the previously focused window's active tab.
    if (
      previousFocusedWindowId !== chrome.windows.WINDOW_ID_NONE &&
      previousFocusedWindowId !== windowId
    ) {
      seenUpdated = await markWindowActiveTabSeen(previousFocusedWindowId, now);
    }

    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      // Browser lost focus: persist current lastActiveTabId for rememberLastActiveTab logic
      if (seenUpdated) saveSeenTimestamps();
      await saveLastActiveTab();
      return;
    }
    const activeTabs = await chrome.tabs.query({ windowId, active: true });
    if (activeTabs.length > 0) {
      const activeTabId = activeTabs[0].id;
      // Keep per-window active tab tracking fresh even if onActivated doesn't fire on focus switch.
      setLastActiveTabInWindow(windowId, { tabId: activeTabId, timestamp: now });
      // Only update global focused-tab memory if this event is still current.
      if (lastFocusedWindowId === windowId && lastActiveTabId !== activeTabId) {
        lastActiveTabId = activeTabId;
        await saveLastActiveTab();
      }
    }
    if (seenUpdated) saveSeenTimestamps();
  } catch (e) {
    console.warn('onFocusChanged handler failed:', e);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    if (changeInfo.url.startsWith(SUSPENDED_PREFIX)) {
      suspendedFaviconReadyTabs.delete(tabId);
    } else {
      suspendedFaviconReadyTabs.delete(tabId);
      cancelPendingDiscardWait(tabId);
    }
  }

  // Authoritative readiness signal: when Chrome's browser process reports a real
  // (non-default) favicon for a suspended placeholder, the icon is guaranteed to
  // be captured, so the tab is safe to discard with no arbitrary delay. The
  // manifest/default icons Chrome auto-populates for chrome-extension:// pages
  // are filtered out by isExtensionDefaultFaviconUrl, which is why an earlier
  // attempt to gate on favIconUrl (commit e6cd75d2) had to be abandoned.
  if (
    changeInfo.favIconUrl &&
    isSuspendedTab(tab) &&
    !isExtensionDefaultFaviconUrl(changeInfo.favIconUrl)
  ) {
    markSuspendedFaviconReady(tabId);
  }

  if (changeInfo.status === 'complete') {
    seenTimestamps[tabId] = Date.now();
    saveSeenTimestamps();
    
    // If tab was being unsuspended and is now complete, remove from tracking
    if (unsuspendingTabs.has(tabId)) {
      unsuspendingTabs.delete(tabId);
    }
    
    // Remove from fix favicon tabs tracking when loaded
    if (fixFaviconTabs.has(tabId)) {
      fixFaviconTabs.delete(tabId);
    }
    const suspended = isSuspendedTab(tab);
    if (suspended && hasUsableSuspendedFavicon(tab)) {
      suspendedFaviconReadyTabs.add(tabId);
      fixFaviconRetryCounts.delete(tabId);
    }
    
    // Page is fully loaded: mark pageComplete. Resolve only when favicon is
    // also ready (signalled by the 'faviconReady' message from suspended.js).
    const pendingInfo = pendingDiscardTabs.get(tabId);
    if (pendingInfo && suspended) {
      pendingInfo.pageComplete = true;
      if (suspendedFaviconReadyTabs.has(tabId) || hasUsableSuspendedFavicon(tab)) {
        pendingInfo.faviconReady = true;
        suspendedFaviconReadyTabs.add(tabId);
      }
      pendingInfo.tryResolve();
    }

    // Queue this tab for targeted re-discard if it is a loaded suspended placeholder.
    if (!pendingInfo && suspended && !tab.active && !tab.discarded) {
      scheduleReDiscard(tabId);
    }
  }
  
  // Track tabs that are being unsuspended (URL changed from suspended.html to original URL)
  if (changeInfo.url && unsuspendingTabs.has(tabId)) {
    if (!changeInfo.url.startsWith(SUSPENDED_PREFIX)) {
      // URL has changed from suspended.html to original URL, keep tracking until complete
    }
  }
  
  if (changeInfo.active === false) {
    // Tab became inactive - update timestamp to track when it was last seen
    seenTimestamps[tabId] = Date.now();
    saveSeenTimestamps();
    if (!pendingDiscardTabs.has(tabId)) {
      scheduleReDiscard(tabId);
    }
  }
});

// When a new tab is created (e.g., gesture/drag-to-search or open-in-new-tab),
// proactively update the seen timestamp of the opener/previous active tab so it
// won’t be considered idle immediately after focus shifts.
chrome.tabs.onCreated.addListener(async (tab) => {
  const now = Date.now();
  try {
    // 1) If Chrome provides an opener, stamp it as recently seen
    if (typeof tab.openerTabId === 'number') {
      seenTimestamps[tab.openerTabId] = now;
      saveSeenTimestamps();
    }

    // 2) Fallback: use our lastActiveTabPerWindow to stamp the previously
    //    active tab in this window. This helps when openerTabId is missing
    //    but the new tab becomes active immediately (common in some gesture
    //    extensions).
    const lastActiveInWindow = lastActiveTabPerWindow.get(tab.windowId);
    if (lastActiveInWindow && lastActiveInWindow.tabId !== tab.id) {
      seenTimestamps[lastActiveInWindow.tabId] = now;
      saveSeenTimestamps();
    }

    // If the newly created tab is already active, reflect it as the last active tab
    if (tab.active) {
      if (lastActiveTabId !== tab.id) {
        lastActiveTabId = tab.id;
        await saveLastActiveTab();
      }
      // Also record this activation in our per-window map
      setLastActiveTabInWindow(tab.windowId, { tabId: tab.id, timestamp: now });
    }
  } catch (e) {
    console.warn('onCreated handler failed:', e);
  }
});

// Clean up tracking when tabs are closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  unsuspendingTabs.delete(tabId);
  fixFaviconTabs.delete(tabId);
  fixFaviconRetryCounts.delete(tabId);
  suspendedFaviconReadyTabs.delete(tabId);
  pendingReDiscardTabIds.delete(tabId);
  reDiscardRetryCounts.delete(tabId);

  // Clean up pending discard if tab is closed
  cancelPendingDiscardWait(tabId);

  // Clean up per-window active tab tracking
  const { windowId } = removeInfo;
  const lastActiveInWindow = lastActiveTabPerWindow.get(windowId);
  if (lastActiveInWindow && lastActiveInWindow.tabId === tabId) {
    removeLastActiveTabInWindow(windowId);
  }

  delete seenTimestamps[tabId];
  saveSeenTimestamps();
});

// Receive commands from popup/options
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const respond = (payload) => {
    try {
      sendResponse(payload);
    } catch (_) {}
  };

  (async () => {
    try {
      if (msg.command === 'suspendTab') {
        const tab = await chrome.tabs.get(msg.tabId);
        const settings = await getSettings();
        await suspendTab(tab, settings);
        respond({ done: true });
      } else if (msg.command === 'unsuspendTab') {
        // Start tracking this tab as being unsuspended
        await unsuspendTabWithUrl(msg.tabId, msg.originalUrl);
        respond({ done: true });
      } else if (msg.command === 'suspendOthers') {
        // Suspend other tabs in current window only
        await suspendOthersInWindow(msg.tabId);
        respond({ done: true });
      } else if (msg.command === 'unsuspendAll') {
        await unsuspendAllTabs(!!msg.withProgress);
        respond({ done: true });
      } else if (msg.command === 'unsuspendAllThisWindow') {
        // Unsuspend all suspended tabs in current window only
        const currentTab = await chrome.tabs.get(msg.tabId);
        await unsuspendAllTabsInWindow(currentTab.windowId);
        respond({ done: true });
      } else if (msg.command === 'updateSettings') {
        await saveSettings(msg.settings);
        respond({ done: true });
      } else if (msg.command === 'toggleTempWhitelist') {
        const url = msg.url;
        if (tempWhitelist.has(url)) {
          tempWhitelist.delete(url);
        } else {
          tempWhitelist.add(url);
        }
        await persistTempWhitelist();
        respond({ whitelisted: tempWhitelist.has(url) });
      } else if (msg.command === 'checkTempWhitelist') {
        const whitelisted = tempWhitelist.has(msg.url);
        respond({ whitelisted });
      } else if (msg.command === 'suspendSelectedTabs') {
        // Force suspend selected tabs (ignore whitelist but respect internal URLs)
        await suspendSelectedTabs(msg.tabIds);
        respond({ done: true });
      } else if (msg.command === 'unsuspendSelectedTabs') {
        // Force unsuspend selected tabs
        await unsuspendSelectedTabs(msg.tabIds);
        respond({ done: true });
      } else if (msg.command === 'suspendAllOthersAllWindows') {
        // Suspend all other tabs across all windows (respects suspension prevention settings)
        await suspendOthersInAllWindows(msg.tabId, !!msg.withProgress);
        respond({ done: true });
      } else if (msg.command === 'cancelBulk') {
        cancelBulkNow();
        respond({ done: true });
      } else if (msg.command === 'faviconReady') {
        // Sent by suspended.js after it has set the <link rel="icon"> in the DOM.
        // Confirm Chrome actually registered the favicon (rather than trusting a
        // fixed delay) before allowing the tab to be discarded. Skip entirely in
        // placeholder-only mode, where tabs are never discarded and favicon
        // readiness is irrelevant — avoids needless polling at large tab counts.
        const tabId = sender.tab ? sender.tab.id : null;
        if (typeof tabId === 'number') {
          const settings = await getSettingsCached();
          if (settings.useNativeDiscard) {
            confirmSuspendedFaviconReady(tabId);
          }
        }
        respond({ done: true });
      } else if (msg.command === 'startUnsuspending') {
        // Get the current tab ID from sender
        const tabId = sender.tab ? sender.tab.id : msg.tabId;
        if (tabId) {
          unsuspendingTabs.add(tabId);
        }
        respond({ done: true });
      } else if (msg.command === 'unsuspendNavigate') {
        // Navigate the tab via chrome.tabs.update() which has the necessary
        // privileges for file:// and other restricted URL schemes that
        // location.href cannot load from an extension page.
        const tabId = sender.tab ? sender.tab.id : null;
        if (tabId && msg.url) {
          await chrome.tabs.update(tabId, { url: msg.url });
          respond({ done: true });
        } else {
          respond({ done: false, error: 'Missing tab or url' });
        }
      } else {
        respond({ done: false, error: 'Unknown command' });
      }
    } catch (error) {
      logUnexpectedTabError(`Message command failed (${msg && msg.command})`, error);
      respond({
        done: false,
        error: isTabGoneError(error)
          ? 'Tab no longer exists'
          : String((error && error.message) || error || 'Unknown error')
      });
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
  } catch (error) {
    logUnexpectedTabError('Auto check failed', error);
  } finally {
    running = false;
  }
});

// Handle service worker lifecycle - clean up processor on termination
self.addEventListener('beforeunload', () => {
  fixFaviconProcessor.stop();
  flushSeenTimestampsNow();
});

// Handle service worker lifecycle - ensure processor continues on background events
chrome.runtime.onSuspend?.addListener(() => {
  fixFaviconProcessor.stop();
  flushSeenTimestampsNow();
});

// Utility: targeted re-discard for queued tab IDs (no full inactive-tab scan).
// Batch size and retry limit reuse fixFavicon settings by request:
// - fixFaviconBatchSize: max items per run (0 = unlimited)
// - fixFaviconMaxRetries: discard failure retry cap (0 = unlimited)
async function processQueuedReDiscardTabs() {
  const settings = await getSettingsCached();
  if (!settings.useNativeDiscard) {
    pendingReDiscardTabIds.clear();
    reDiscardRetryCounts.clear();
    return;
  }

  const configuredBatchSize = Number(settings.fixFaviconBatchSize) || 0;
  const batchSize = configuredBatchSize > 0
    ? Math.max(1, Math.floor(configuredBatchSize))
    : pendingReDiscardTabIds.size;
  if (batchSize <= 0 || pendingReDiscardTabIds.size === 0) return;

  const maxRetries = Number(settings.fixFaviconMaxRetries) || 0;
  const candidates = Array.from(pendingReDiscardTabIds).slice(0, batchSize);
  for (const tabId of candidates) {
    pendingReDiscardTabIds.delete(tabId);

    // Skip tabs that are currently being unsuspended.
    if (unsuspendingTabs.has(tabId)) {
      reDiscardRetryCounts.delete(tabId);
      continue;
    }

    // The primary suspend/favicon-fix path owns the discard once it is waiting.
    if (pendingDiscardTabs.has(tabId)) {
      reDiscardRetryCounts.delete(tabId);
      continue;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isSuspendedTab(tab) || tab.discarded) {
        reDiscardRetryCounts.delete(tabId);
        continue;
      }

      // Active tabs cannot be discarded; wait for next inactivity event.
      if (tab.active) {
        reDiscardRetryCounts.delete(tabId);
        continue;
      }

      if (await discardSuspendedTabWhenReady(tabId, 'Scheduled re-discard')) {
        reDiscardRetryCounts.delete(tabId);
      } else {
        const latestTab = await chrome.tabs.get(tabId).catch(() => null);
        if (!latestTab || !isSuspendedTab(latestTab) || latestTab.discarded || latestTab.active) {
          reDiscardRetryCounts.delete(tabId);
          continue;
        }
        const nextRetry = (reDiscardRetryCounts.get(tabId) || 0) + 1;
        if (maxRetries > 0 && nextRetry >= maxRetries) {
          reDiscardRetryCounts.delete(tabId);
        } else {
          reDiscardRetryCounts.set(tabId, nextRetry);
          pendingReDiscardTabIds.add(tabId);
        }
      }
    } catch (e) {
      const message = String((e && e.message) || '');
      if (message.includes('No tab with id') || message.includes('Invalid tab ID')) {
        reDiscardRetryCounts.delete(tabId);
        continue;
      }

      const nextRetry = (reDiscardRetryCounts.get(tabId) || 0) + 1;
      if (maxRetries > 0 && nextRetry >= maxRetries) {
        reDiscardRetryCounts.delete(tabId);
        continue;
      }
      reDiscardRetryCounts.set(tabId, nextRetry);
      pendingReDiscardTabIds.add(tabId);
    }
  }
}

// Unsuspend a single tab by tab ID
async function unsuspendTabById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isSuspendedTab(tab)) {
    const original = parseOriginalUrlFromSuspended(tab.url);
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
  
  // Build target list first
  const targets = [];
  for (const tab of tabs) {
    if (tab.id !== currentTabId && !tab.active && !isInternalUrl(tab.url)) {
      // Skip if tab is already suspended by our extension
      if (isSuspendedTab(tab)) continue;
      
      // Check suspension prevention settings
      if (settings.neverSuspendAudio && tab.audible) continue;
      if (settings.neverSuspendPinned && tab.pinned) continue;
      if (!isWhitelisted(tab.url, settings)) {
        targets.push(tab);
      }
    }
  }

  // Process in concurrent batches
  const concurrency = settings.suspendBatchConcurrency || 5;
  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(tab => suspendTab(tab, settings)));
  }
}

// Suspend other tabs in all windows
async function suspendOthersInAllWindows(currentTabId, withProgress = false) {
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
      // Update last active tab when browser is focused
      if (lastActiveTabId !== focusedWindowActiveTabId) {
        lastActiveTabId = focusedWindowActiveTabId;
        await saveLastActiveTab();
      }
    }
  }
  
  // Build target list first for accurate total
  const targets = [];
  for (const tab of allTabs) {
    if (tab.id === currentTabId || isInternalUrl(tab.url)) continue;
    if (isSuspendedTab(tab)) continue;
    if (settings.neverSuspendAudio && tab.audible) continue;
    if (settings.neverSuspendPinned && tab.pinned) continue;
    if (isWhitelisted(tab.url, settings)) continue;

    if (settings.rememberLastActiveTab && tab.id === lastActiveTabId && !focusedWindow) continue;
    if (tab.active) {
      if (settings.neverSuspendActive) continue;
      if (tab.id === focusedWindowActiveTabId) continue;
    }
    targets.push(tab);
  }

  // Prepare cancel token
  const cancelToken = newCancelToken();
  const total = targets.length;
  let processed = 0;

  // Process in concurrent batches
  const concurrency = settings.suspendBatchConcurrency || 5;
  for (let i = 0; i < targets.length; i += concurrency) {
    if (cancelToken.cancelled) break;
    const batch = targets.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(tab =>
      suspendTab(tab, settings).finally(() => {
        processed += 1;
        if (withProgress) postBulkProgress({ action: 'suspendAll', processed, total });
      })
    ));
  }
  if (withProgress) postBulkProgress({ action: 'suspendAll', processed, total, done: true, cancelled: cancelToken.cancelled });
}

// Unsuspend all tabs in all windows
async function unsuspendAllTabs(withProgress = false) {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter(t => isSuspendedTab(t));
  const cancelToken = newCancelToken();
  const total = targets.length;
  let processed = 0;
  for (const tab of targets) {
    if (cancelToken.cancelled) break;
    const original = parseOriginalUrlFromSuspended(tab.url);
    if (original) {
      unsuspendingTabs.add(tab.id);
      // Update timestamp immediately to prevent re-suspension
      seenTimestamps[tab.id] = Date.now();
      await chrome.tabs.update(tab.id, { url: original });
    }
    processed += 1;
    if (withProgress) postBulkProgress({ action: 'unsuspendAll', processed, total });
  }
  saveSeenTimestamps();
  if (withProgress) postBulkProgress({ action: 'unsuspendAll', processed, total, done: true, cancelled: cancelToken.cancelled });
}

// Unsuspend all tabs in a specific window
async function unsuspendAllTabsInWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId: windowId });
  for (const tab of tabs) {
    if (isSuspendedTab(tab)) {
      const original = parseOriginalUrlFromSuspended(tab.url);
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

  // Pre-fetch all tabs and filter valid ones
  const targets = [];
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isInternalUrl(tab.url)) {
        targets.push(tab);
      }
    } catch (error) {
      console.warn(`Failed to get tab ${tabId}:`, error);
    }
  }

  // Process in concurrent batches
  const concurrency = settings.suspendBatchConcurrency || 5;
  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(tab => suspendTab(tab, settings)));
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
  if (isSuspendedTab(tab)) {
    // Unsuspend the tab
    return await unsuspendTabById(tab.id);
  } else {
    // Suspend the tab
    const settings = await getSettings();
    if (tab && tab.url && !isInternalUrl(tab.url)) {
      await suspendTab(tab, settings);
      return true;
    }
  }
  return false;
}

// Helper to save seen timestamps (debounced via alarm interval)
let seenSaveTimer = null;
let seenSaveDirty = false;
const SEEN_SAVE_DEBOUNCE_MS = 2000;

function saveSeenTimestamps() {
  // Debounce session storage writes to reduce IO pressure
  seenSaveDirty = true;
  if (seenSaveTimer) return;
  seenSaveTimer = setTimeout(() => {
    if (seenSaveDirty) {
      chrome.storage.session.set({ utsSeen: seenTimestamps });
      seenSaveDirty = false;
    }
    seenSaveTimer = null;
  }, SEEN_SAVE_DEBOUNCE_MS);
}

function flushSeenTimestampsNow() {
  // Force flush pending seen timestamps write
  if (seenSaveTimer) {
    clearTimeout(seenSaveTimer);
    seenSaveTimer = null;
  }
  if (seenSaveDirty) {
    chrome.storage.session.set({ utsSeen: seenTimestamps });
    seenSaveDirty = false;
  }
}

// Throttle for re-discard routine to avoid excessive work on rapid events
let reDiscardScheduled = false;
let reDiscardRunning = false;
function scheduleReDiscard(tabId = null, delayMs = 500) {
  if (typeof tabId === 'number') {
    pendingReDiscardTabIds.add(tabId);
  }

  if (reDiscardScheduled) return;
  reDiscardScheduled = true;
  setTimeout(async () => {
    reDiscardScheduled = false;

    if (reDiscardRunning) {
      if (pendingReDiscardTabIds.size > 0) {
        scheduleReDiscard(null, 250);
      }
      return;
    }

    reDiscardRunning = true;
    try {
      await processQueuedReDiscardTabs();
    } catch (e) {
      console.warn('Scheduled re-discard failed', e);
    } finally {
      reDiscardRunning = false;
      if (pendingReDiscardTabIds.size > 0) {
        scheduleReDiscard(null, 500);
      }
    }
  }, delayMs);
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

// ==== Test-only export ====
// Guarded so it is inert at runtime: Chrome loads this as an ES-module service
// worker where `module` is undefined, so the block is skipped. Under Jest it is
// required as CommonJS, exposing the internals for unit testing.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // constants
    DEFAULT_SETTINGS,
    STORAGE_KEY,
    TEMP_KEY,
    LAST_ACTIVE_TAB_KEY,
    SUSPENDED_PREFIX,
    ALARM_PERIOD_MINUTES,
    DISCARD_READY_TIMEOUT_MS,
    FAVICON_CONFIRM_INTERVAL_MS,
    FAVICON_CONFIRM_MAX_ATTEMPTS,
    FAVICON_CAPTURE_DELAY_MS,
    EXTENSION_DEFAULT_FAVICON_URLS,
    // pure helpers
    isInternalUrl,
    isTabGoneError,
    logUnexpectedTabError,
    compileWhitelist,
    ensureCompiledWhitelist,
    isHostnameWhitelisted,
    isWhitelisted,
    isSuspendedTab,
    getExtensionIconPaths,
    stripFaviconUrlSuffix,
    isExtensionDefaultFaviconUrl,
    hasUsableSuspendedFavicon,
    needsSuspendedFaviconFix,
    parseOriginalUrlFromSuspended,
    markTabSeen,
    // settings / storage
    getSettings,
    getSettingsCached,
    saveSettings,
    setTempWhitelistFromStorageValue,
    persistTempWhitelist,
    saveLastActiveTab,
    loadLastActiveTab,
    setLastActiveTabInWindow,
    removeLastActiveTabInWindow,
    loadLastActiveTabPerWindow,
    markWindowActiveTabSeen,
    saveSeenTimestamps,
    flushSeenTimestampsNow,
    // suspend / discard lifecycle
    suspendTab,
    suspendWithPlaceholder,
    beginSuspendedReadyWait,
    waitForTabLoaded,
    cancelPendingDiscardWait,
    markSuspendedFaviconReady,
    confirmSuspendedFaviconReady,
    discardSuspendedTabWhenReady,
    fixFaviconProcessor,
    checkTabs,
    scheduleCheckAlarm,
    scheduleReDiscard,
    processQueuedReDiscardTabs,
    // bulk operations
    postBulkProgress,
    newCancelToken,
    cancelBulkNow,
    unsuspendTabById,
    unsuspendTabWithUrl,
    suspendOthersInWindow,
    suspendOthersInAllWindows,
    unsuspendAllTabs,
    unsuspendAllTabsInWindow,
    suspendSelectedTabs,
    unsuspendSelectedTabs,
    toggleTabSuspension,
    // live state accessors for assertions
    __getInternals: () => ({
      tempWhitelist,
      seenTimestamps,
      unsuspendingTabs,
      pendingDiscardTabs,
      suspendedFaviconReadyTabs,
      lastActiveTabId,
      lastActiveTabPerWindow,
      lastFocusedWindowId,
      fixFaviconTabs,
      fixFaviconRetryCounts,
      pendingReDiscardTabIds,
      reDiscardRetryCounts,
      cachedSettings,
      popupPorts,
      bulkCancelToken,
      running,
    }),
    __setState: (patch = {}) => {
      if ('lastActiveTabId' in patch) lastActiveTabId = patch.lastActiveTabId;
      if ('lastFocusedWindowId' in patch) lastFocusedWindowId = patch.lastFocusedWindowId;
      if ('running' in patch) running = patch.running;
      if ('cachedSettings' in patch) cachedSettings = patch.cachedSettings;
      if ('cachedAtMs' in patch) cachedAtMs = patch.cachedAtMs;
    },
  };
}

