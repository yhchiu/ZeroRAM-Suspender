// options.js - handle save/load settings with modern UI navigation
const STORAGE_KEY = 'utsSettings';

// Initialize DOM elements after DOM is loaded
let autoSuspendEl, discardEl, whitelistEl, neverSuspendAudioEl, neverSuspendPinnedEl, neverSuspendActiveEl;

function initializeElements() {
  autoSuspendEl = document.getElementById('autoSuspend');
  discardEl = document.getElementById('nativeDiscard');
  whitelistEl = document.getElementById('whitelistList');
  neverSuspendAudioEl = document.getElementById('neverSuspendAudio');
  neverSuspendPinnedEl = document.getElementById('neverSuspendPinned');
  neverSuspendActiveEl = document.getElementById('neverSuspendActive');
}

/* ---------- Overlay Notice mechanism ---------- */
/**
 * Create or retrieve the global notice container.
 */
function getNoticeContainer() {
  let container = document.getElementById('notice-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'notice-container';
    container.className = 'notice-container';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Show a notice overlay with optional type and duration.
 * type: 'success' | 'error' | 'warning' | 'info'
 */
function showNotice(message, type = 'info', duration = 3000) {
  const container = getNoticeContainer();
  const notice = document.createElement('div');
  notice.className = `notice notice-${type}`;

  // Message span
  const msg = document.createElement('span');
  msg.className = 'notice-message';
  msg.textContent = message;
  notice.appendChild(msg);

  // Progress bar
  const progress = document.createElement('div');
  progress.className = 'notice-progress';
  // Explicitly set initial width to ensure starting state
  progress.style.width = '100%';
  progress.style.transition = `width ${duration}ms linear`;
  notice.appendChild(progress);

  // Append to DOM BEFORE triggering animation to guarantee visibility
  container.appendChild(notice);

  // Double rAF to ensure layout. Guarantees width change happens after element is rendered.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      progress.style.width = '0%';
    });
  });

  // Fallback safety in case rAF is skipped (e.g., background tab)
  setTimeout(() => {
    if (progress.style.width !== '0%') {
      progress.style.width = '0%';
    }
  }, 50);
  
  // Auto close notice
  const close = () => {
    notice.classList.add('hide');
    setTimeout(() => notice.remove(), 250); // match fadeOut duration
  };
  setTimeout(close, duration);
}
/* ---------- End Overlay Notice mechanism ---------- */

// Navigation functionality
function initNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.content-section');
  const actionBar = document.querySelector('.action-bar');

  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      
      // Remove active class from all links and sections
      navLinks.forEach(l => l.classList.remove('active'));
      sections.forEach(s => s.classList.remove('active'));
      
      // Add active class to clicked link
      link.classList.add('active');
      
      // Show corresponding section
      const sectionId = link.getAttribute('data-section');
      const targetSection = document.getElementById(sectionId);
      if (targetSection) {
        targetSection.classList.add('active');
      }
      
      // Reset migration state when switching to migration section
      if (sectionId === 'migration') {
        resetMigrationState();
      }
      
      // Auto-reload whitelist when switching to whitelist section
      if (sectionId === 'whitelist') {
        loadWhitelist(false);
      }
      
      // Show/hide save button based on section
      if (sectionId === 'about' || sectionId === 'migration') {
        actionBar.style.display = 'none';
      } else {
        actionBar.style.display = 'flex';
      }
    });
  });
}

// Set version dynamically
function setVersion() {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('version');
  if (versionEl) {
    versionEl.textContent = manifest.version;
  }
}

// Load settings from storage
function load() {
  chrome.storage.sync.get(STORAGE_KEY, data => {
    const cfg = data[STORAGE_KEY] || {};
    autoSuspendEl.value = cfg.autoSuspendMinutes != null ? cfg.autoSuspendMinutes : 30;
    discardEl.checked = cfg.useNativeDiscard !== false; // default true
    whitelistEl.value = (cfg.whitelist || []).join('\n');
    // Load new suspension prevention settings with defaults
    neverSuspendAudioEl.checked = cfg.neverSuspendAudio !== false; // default true
    neverSuspendPinnedEl.checked = cfg.neverSuspendPinned !== false; // default true
    neverSuspendActiveEl.checked = cfg.neverSuspendActive === true; // default false
  });
}

// Load only whitelist from storage
function loadWhitelist(showNotification = true) {
  chrome.storage.sync.get(STORAGE_KEY, data => {
    const cfg = data[STORAGE_KEY] || {};
    whitelistEl.value = (cfg.whitelist || []).join('\n');
    if (showNotification) {
      showNotice(getMessage('whitelistRefreshed') || 'Whitelist refreshed', 'success', 2000);
    }
  });
}

// Get currently active section
function getCurrentActiveSection() {
  const activeSection = document.querySelector('.content-section.active');
  return activeSection ? activeSection.id : null;
}

// Save settings to storage (only current active section)
function save() {
  const currentSection = getCurrentActiveSection();
  
  // Load existing settings first
  chrome.storage.sync.get(STORAGE_KEY, data => {
    const existingCfg = data[STORAGE_KEY] || {};
    let updatedCfg = { ...existingCfg };
    
    // Only update settings for the current active section
    switch (currentSection) {
      case 'basic':
        updatedCfg.autoSuspendMinutes = parseInt(autoSuspendEl.value, 10) || 0;
        updatedCfg.useNativeDiscard = discardEl.checked;
        updatedCfg.neverSuspendAudio = neverSuspendAudioEl.checked;
        updatedCfg.neverSuspendPinned = neverSuspendPinnedEl.checked;
        updatedCfg.neverSuspendActive = neverSuspendActiveEl.checked;
        break;
      case 'whitelist':
        updatedCfg.whitelist = whitelistEl.value.split(/\n/).map(s => s.trim()).filter(Boolean);
        break;
      case 'migration':
        // No settings to save in migration section
        break;
      case 'about':
        // No settings to save in about section
        break;
      default:
        // If no active section found, save all (fallback to original behavior)
        updatedCfg = {
          autoSuspendMinutes: parseInt(autoSuspendEl.value, 10) || 0,
          useNativeDiscard: discardEl.checked,
          whitelist: whitelistEl.value.split(/\n/).map(s => s.trim()).filter(Boolean),
          neverSuspendAudio: neverSuspendAudioEl.checked,
          neverSuspendPinned: neverSuspendPinnedEl.checked,
          neverSuspendActive: neverSuspendActiveEl.checked,
        };
    }
    
    chrome.storage.sync.set({ [STORAGE_KEY]: updatedCfg }, () => {
      chrome.runtime.sendMessage({ command: 'updateSettings', settings: updatedCfg });
      
      // Show save confirmation with section-specific message
      let saveMessage;
      switch (currentSection) {
        case 'basic':
          saveMessage = getMessage('savedBasicSettings');
          break;
        case 'whitelist':
          saveMessage = getMessage('savedWhitelistSettings');
          break;
        case 'migration':
          saveMessage = getMessage('savedTabMigrationSettings');
          break;
        default:
          saveMessage = getMessage('savedNotice');
      }
      
      showNotice(saveMessage, 'success');
    });
  });
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  initializeElements();
  initNavigation();
  setVersion();
  load();
  
  // Check initial active section and hide save button if needed
  const initialActiveSection = getCurrentActiveSection();
  const actionBar = document.querySelector('.action-bar');
  if (initialActiveSection === 'about' || initialActiveSection === 'migration') {
    actionBar.style.display = 'none';
  }
  
  // Initialize tab migration functionality
  initTabMigration();
  
  // Add refresh whitelist button event listener
  const refreshWhitelistBtn = document.getElementById('refreshWhitelistBtn');
  if (refreshWhitelistBtn) {
    refreshWhitelistBtn.addEventListener('click', loadWhitelist);
  }
});

// Attach save button event listener
document.getElementById('saveBtn').addEventListener('click', save);

// Keyboard shortcut for save (Ctrl+S / Cmd+S)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

/* ---------- Tab Migration Functions ---------- */

// Initialize tab migration functionality
function initTabMigration() {
  const scanBtn = document.getElementById('scanMarvellousBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const deselectAllBtn = document.getElementById('deselectAllBtn');
  const migrateBtn = document.getElementById('migrateSelectedBtn');
  
  if (scanBtn) {
    scanBtn.addEventListener('click', scanForMarvellousTab);
  }
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', selectAllTabs);
  }
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', deselectAllTabs);
  }
  if (migrateBtn) {
    migrateBtn.addEventListener('click', migrateSelectedTabs);
  }
}

// Known The Marvellous Suspender extension IDs
const KNOWN_MARVELLOUS_SUSPENDER_IDS = [
  'klbibkeccnjlkjkiokjodocebajanakg', // Original The Marvellous Suspender
  'noogafoofpebimajpfpamcfhoaifemoa', // Alternative version  
  'gcknhkkoolaabfmlnjonogaaifnjlfnp', // Another known ID
  'ahfhijdlegdabablpippeagghigmibma', // Newer version
  'jlgkpaicikihijadgifklkbpdajbkhjo', // Community fork
  'ahkbmjhfoplmfkpncgoedjgkajkehcgo', // The Great Suspender (notrack)
  // Add more known IDs as needed
];

// Cache for dynamically discovered extension IDs
let discoveredMarvellousIds = new Set();

// Check if URL is from The Marvellous Suspender
function isMarvellousTabUrl(url) {
  if (!url || !url.startsWith('chrome-extension://') || !url.includes('/suspended.html#')) {
    return false;
  }
  
  // Extract extension ID from URL
  const matches = url.match(/chrome-extension:\/\/([a-z]+)\/suspended\.html#/);
  if (!matches || matches.length < 2) {
    return false;
  }
  
  const extensionId = matches[1];
  return KNOWN_MARVELLOUS_SUSPENDER_IDS.includes(extensionId) || discoveredMarvellousIds.has(extensionId);
}

// Check if URL might be from an unknown Marvellous Suspender variant
function checkPotentialMarvellousTab(url) {
  try {
    if (!url || !url.startsWith('chrome-extension://') || !url.includes('/suspended.html#')) {
      return null;
    }
    
    const hashPart = url.split('#')[1];
    if (!hashPart) {
      return null;
    }
    
    // Check if it has the characteristic Marvellous Suspender parameters
    const params = new URLSearchParams(hashPart);
    const title = params.get('ttl');
    const originalUrl = params.get('uri');
    const position = params.get('pos');
    
    // Must have 'ttl' and 'uri' parameters to be considered a potential match
    if (!originalUrl || !params.has('ttl')) {
      return null;
    }
    
    // Extract extension ID
    const matches = url.match(/chrome-extension:\/\/([a-z]+)\/suspended\.html#/);
    const extensionId = matches ? matches[1] : 'unknown';
    
    return {
      title: title ? decodeURIComponent(title) : originalUrl,
      originalUrl: originalUrl,
      position: position ? parseInt(position) : 0,
      extensionId: extensionId
    };
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error checking potential Marvellous Suspender variant:', error);
    return null;
  }
}

// Scan for The Marvellous Suspender tabs
async function scanForMarvellousTab() {
  const scanBtn = document.getElementById('scanMarvellousBtn');
  const resultsDiv = document.getElementById('migrationResults');
  const statusDiv = document.getElementById('migrationStatus');
  const tabsListDiv = document.getElementById('tabsList');
  const tabsContainer = document.getElementById('tabsContainer');
  
  // Disable scan button and show loading
  scanBtn.disabled = true;
  scanBtn.style.opacity = '0.6';
  statusDiv.textContent = getMessage('scanningTabs');
  statusDiv.style.color = '#666';
  resultsDiv.style.display = 'block';
  tabsListDiv.style.display = 'none';
  
  try {
    // Query all tabs
    const tabs = await chrome.tabs.query({});
    const marvellousTab = [];
    const detectedExtensionIds = new Set();
    
    for (const tab of tabs) {
      // Skip our own extension's tabs
      if (tab.url && tab.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
        continue;
      }
      
      if (tab.url && tab.url.includes('/suspended.html#')) {
        // Parse as potential Marvellous Suspender tab
        const potentialMatch = checkPotentialMarvellousTab(tab.url);
        if (potentialMatch) {
          // Check if this extension ID is in our known list
          const isKnownVariant = KNOWN_MARVELLOUS_SUSPENDER_IDS.includes(potentialMatch.extensionId);
          
          console.log(`[ZeroRAM Suspender] Found tab with extension ID: ${potentialMatch.extensionId}, isKnownVariant: ${isKnownVariant}`);
          
          marvellousTab.push({
            ...potentialMatch,
            tabId: tab.id,
            tabIndex: tab.index,
            favIconUrl: tab.favIconUrl,
            isUnknownVariant: !isKnownVariant
          });
          
          detectedExtensionIds.add(potentialMatch.extensionId);
          
          // Add to discovered IDs if it's unknown
          if (!isKnownVariant) {
            discoveredMarvellousIds.add(potentialMatch.extensionId);
          }
        }
      }
    }
    
    // Log detected extension IDs for debugging
    if (detectedExtensionIds.size > 0) {
      console.log('[ZeroRAM Suspender] Detected The Marvellous Suspender extension IDs:', Array.from(detectedExtensionIds));
    }
    
    // Update status and display results
    if (marvellousTab.length === 0) {
      statusDiv.textContent = getMessage('noMarvellousTabFound');
      statusDiv.style.color = '#666';
    } else {
      const knownVariants = marvellousTab.filter(tab => !tab.isUnknownVariant).length;
      const unknownVariants = marvellousTab.filter(tab => tab.isUnknownVariant).length;
      
      let statusText = getMessage('foundMarvellousTab').replace('%d', marvellousTab.length);
      if (unknownVariants > 0) {
        statusText += ` (${unknownVariants} ${getMessage('unknownVariant').toLowerCase()})`;
      }
      
      statusDiv.textContent = statusText;
      statusDiv.style.color = '#27ae60';
      
      // Display tabs list
      displayMarvellousTab(marvellousTab, tabsContainer);
      tabsListDiv.style.display = 'block';
    }
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error scanning tabs:', error);
    statusDiv.textContent = getMessage('errorScanningTabs') + error.message;
    statusDiv.style.color = '#dc3545';
  } finally {
    // Re-enable scan button
    scanBtn.disabled = false;
    scanBtn.style.opacity = '1';
  }
}

// Display found Marvellous Suspender tabs
function displayMarvellousTab(tabs, container) {
  container.innerHTML = '';
  
  tabs.forEach((tabData, index) => {
    const tabItem = document.createElement('div');
    tabItem.style.cssText = `
      display: flex;
      align-items: center;
      padding: 12px;
      margin-bottom: 8px;
      background: white;
      border-radius: 6px;
      border: 1px solid #e1e5e9;
      transition: all 0.2s ease;
    `;
    
    const variantBadge = tabData.isUnknownVariant 
      ? `<span style="background: #ffc107; color: #333; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 8px;">${getMessage('unknownVariant')}</span>`
      : '';
    
    tabItem.innerHTML = `
      <input type="checkbox" 
             id="tab-${index}" 
             data-tab-id="${tabData.tabId}"
             data-original-url="${tabData.originalUrl}"
             data-title="${tabData.title}"
             data-favicon-url="${tabData.favIconUrl || ''}"
             checked
             style="margin-right: 12px; width: 16px; height: 16px;">
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 500; color: #333; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center;">
          ${tabData.favIconUrl ? `<img src="${escapeHtml(tabData.favIconUrl)}" style="width: 16px; height: 16px; margin-right: 8px; flex-shrink: 0;" onerror="this.style.display='none'">` : ''}${escapeHtml(tabData.title)}${variantBadge}
        </div>
        <div style="font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(tabData.originalUrl)}
        </div>
        <div style="font-size: 10px; color: #999; margin-top: 2px;">
          ${getMessage('extensionId')}: ${tabData.extensionId}
        </div>
      </div>
    `;
    
    container.appendChild(tabItem);
  });
}

// Select all tabs
function selectAllTabs() {
  const checkboxes = document.querySelectorAll('#tabsContainer input[type="checkbox"]');
  checkboxes.forEach(checkbox => {
    checkbox.checked = true;
  });
}

// Deselect all tabs
function deselectAllTabs() {
  const checkboxes = document.querySelectorAll('#tabsContainer input[type="checkbox"]');
  checkboxes.forEach(checkbox => {
    checkbox.checked = false;
  });
}

// Migrate selected tabs
async function migrateSelectedTabs() {
  const checkboxes = document.querySelectorAll('#tabsContainer input[type="checkbox"]:checked');
  const migrateBtn = document.getElementById('migrateSelectedBtn');
  
  if (checkboxes.length === 0) {
    showNotice(getMessage('noTabsSelected'), 'warning');
    return;
  }
  
  // Disable migrate button
  migrateBtn.disabled = true;
  migrateBtn.style.opacity = '0.6';
  
  let successCount = 0;
  let failureCount = 0;
  
  try {
    for (const checkbox of checkboxes) {
      try {
        const tabId = parseInt(checkbox.dataset.tabId);
        const originalUrl = checkbox.dataset.originalUrl;
        const title = checkbox.dataset.title;
        const favIconUrl = checkbox.dataset.faviconUrl;
        
        // Create the new suspended URL for ZeroRAM Suspender
        let suspendedUrl = chrome.runtime.getURL('suspended.html') + 
          '?uri=' + encodeURIComponent(originalUrl) +
          '&ttl=' + encodeURIComponent(title);
        
        // Add favicon if available
        if (favIconUrl && favIconUrl !== 'chrome://favicon/') {
          suspendedUrl += '&favicon=' + encodeURIComponent(favIconUrl);
        }
        
        // Update the tab to use ZeroRAM Suspender format
        await chrome.tabs.update(tabId, { url: suspendedUrl });
        successCount++;
      } catch (error) {
        console.error('[ZeroRAM Suspender] Error migrating tab:', error);
        failureCount++;
      }
    }
    
    // Show completion message
    if (successCount > 0) {
      showNotice(getMessage('migrationComplete') + ` (${successCount}${getMessage('tabsMigrated')})`, 'success');
      
      // Refresh the tab list
      setTimeout(() => {
        scanForMarvellousTab();
      }, 1000);
    }
    
    if (failureCount > 0) {
      showNotice(getMessage('migrationFailed') + ` (${failureCount}${getMessage('tabsFailed')})`, 'error');
    }
  } catch (error) {
    console.error('[ZeroRAM Suspender] Migration error:', error);
    showNotice(getMessage('migrationFailed') + ': ' + error.message, 'error');
  } finally {
    // Re-enable migrate button
    migrateBtn.disabled = false;
    migrateBtn.style.opacity = '1';
  }
}

// Utility function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Utility function to get message (fallback for i18n)
function getMessage(key) {
  return chrome.i18n ? chrome.i18n.getMessage(key) : key;
}

// Reset migration state when switching to migration section
function resetMigrationState() {
  const resultsDiv = document.getElementById('migrationResults');
  const statusDiv = document.getElementById('migrationStatus');
  const tabsListDiv = document.getElementById('tabsList');
  const tabsContainer = document.getElementById('tabsContainer');
  const scanBtn = document.getElementById('scanMarvellousBtn');
  
  // Hide results and reset content
  if (resultsDiv) {
    resultsDiv.style.display = 'none';
  }
  
  if (statusDiv) {
    statusDiv.textContent = '';
  }
  
  if (tabsListDiv) {
    tabsListDiv.style.display = 'none';
  }
  
  if (tabsContainer) {
    tabsContainer.innerHTML = '';
  }
  
  // Reset scan button state
  if (scanBtn) {
    scanBtn.disabled = false;
    scanBtn.style.opacity = '1';
  }
  
  console.log('[ZeroRAM Suspender] Migration state reset');
}

// Clear discovered extension IDs cache (for testing purposes)
function clearDiscoveredIds() {
  discoveredMarvellousIds.clear();
  console.log('[ZeroRAM Suspender] Cleared discovered extension IDs cache');
}

// Export for potential use in console debugging
if (typeof window !== 'undefined') {
  window.ZeroRAMSuspenderDebug = {
    clearDiscoveredIds,
    resetMigrationState,
    getKnownIds: () => KNOWN_MARVELLOUS_SUSPENDER_IDS,
    getDiscoveredIds: () => Array.from(discoveredMarvellousIds)
  };
}

/* ---------- End Tab Migration Functions ---------- */ 