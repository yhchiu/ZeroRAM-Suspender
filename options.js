// options.js - handle save/load settings with modern UI navigation
const STORAGE_KEY = 'utsSettings';
const CACHE_THEME_KEY = 'utsCacheThemeMode';

// Initialize DOM elements after DOM is loaded
let autoSuspendEl, discardEl, whitelistEl, neverSuspendAudioEl, neverSuspendPinnedEl, neverSuspendActiveEl, rememberLastActiveTabEl, themeModeEl;

function initializeElements() {
  autoSuspendEl = document.getElementById('autoSuspend');
  discardEl = document.getElementById('nativeDiscard');
  whitelistEl = document.getElementById('whitelistList');
  neverSuspendAudioEl = document.getElementById('neverSuspendAudio');
  neverSuspendPinnedEl = document.getElementById('neverSuspendPinned');
  neverSuspendActiveEl = document.getElementById('neverSuspendActive');
  rememberLastActiveTabEl = document.getElementById('rememberLastActiveTab');
  themeModeEl = document.getElementById('themeMode');
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
      
      // Load changelog when switching to changelog section
      if (sectionId === 'changelog') {
        loadChangelog();
      }
      
      // Load shortcuts when switching to shortcuts section
      if (sectionId === 'shortcuts') {
        loadKeyboardShortcuts();
      }
      
      // Reset session previews when switching to session section
      if (sectionId === 'session') {
        resetSessionPreviews();
      }
      
      // Reset settings previews when switching to settings section
      if (sectionId === 'settings') {
        resetSettingsPreviews();
      }
      
      // Show/hide save button based on section
      if (sectionId === 'about' || sectionId === 'migration' || sectionId === 'changelog' || sectionId === 'shortcuts' || sectionId === 'session' || sectionId === 'settings') {
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
    rememberLastActiveTabEl.checked = cfg.rememberLastActiveTab !== false; // default true
    // Load theme settings with default to 'auto'
    themeModeEl.value = cfg.themeMode || 'auto'; // default to auto (follow system)
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
        updatedCfg.rememberLastActiveTab = rememberLastActiveTabEl.checked;
        updatedCfg.themeMode = themeModeEl.value;
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
          rememberLastActiveTab: rememberLastActiveTabEl.checked,
          themeMode: themeModeEl.value,
        };
    }

    // Save theme mode to localStorage for suspended page caching
    try {
      localStorage.setItem(CACHE_THEME_KEY, updatedCfg.themeMode);
    } catch (e) {
      console.warn('[ZeroRAM Suspender] Failed to cache theme in localStorage:', e);
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
  if (initialActiveSection === 'about' || initialActiveSection === 'migration' || initialActiveSection === 'changelog' || initialActiveSection === 'shortcuts' || initialActiveSection === 'session' || initialActiveSection === 'settings') {
    actionBar.style.display = 'none';
  }
  
  // Initialize tab migration functionality
  initTabMigration();
  
  // Initialize keyboard shortcuts functionality
  initKeyboardShortcuts();
  
  // Initialize session management functionality
  initSessionManagement();
  
  // Initialize settings management functionality
  initSettingsManagement();
  
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

/* ---------- Keyboard Shortcuts Functions ---------- */

// Initialize keyboard shortcuts functionality
function initKeyboardShortcuts() {
  const manageShortcutsBtn = document.getElementById('manageShortcutsBtn');
  const refreshShortcutsBtn = document.getElementById('refreshShortcutsBtn');
  
  if (manageShortcutsBtn) {
    manageShortcutsBtn.addEventListener('click', openShortcutsPage);
  }
  
  if (refreshShortcutsBtn) {
    refreshShortcutsBtn.addEventListener('click', refreshShortcuts);
  }
  
  // Load shortcuts when visiting the shortcuts section
  loadKeyboardShortcuts();
}

// Load and display keyboard shortcuts
async function loadKeyboardShortcuts() {
  const container = document.getElementById('shortcutsContainer');
  if (!container) return;
  
  try {
    const commands = await chrome.commands.getAll();
    displayKeyboardShortcuts(commands, container);
  } catch (error) {
    console.error('Error loading keyboard shortcuts:', error);
    container.innerHTML = `
      <div style="text-align: center; padding: 20px; color: #dc3545;">
        <span data-i18n="errorLoadingShortcuts">Error loading shortcuts</span>
      </div>
    `;
  }
}

// Display keyboard shortcuts in the UI
function displayKeyboardShortcuts(commands, container) {
  if (!commands || commands.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 20px; color: #666;">
        <span data-i18n="noShortcutsFound">No shortcuts found</span>
      </div>
    `;
    return;
  }
  
  // Filter out built-in Chrome commands like _execute_action
  const filteredCommands = commands.filter(command => 
    !command.name.startsWith('_execute_')
  );
  
  if (filteredCommands.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 20px; color: #666;">
        <span data-i18n="noShortcutsFound">No shortcuts found</span>
      </div>
    `;
    return;
  }
  
  // Define command descriptions with i18n keys
  const commandDescriptions = {
    '01-toggle-suspend': { key: 'shortcutToggleSuspend', default: 'Suspend/Unsuspend current tab' },
    '02-suspend-others-window': { key: 'suspendOthers', default: 'Suspend all other tabs (this window)' },
    '03-suspend-others-all': { key: 'suspendAllOthersAllWindows', default: 'Suspend all other tabs (all windows)' },
    '04-unsuspend-all-window': { key: 'unsuspendAllThisWindow', default: 'Unsuspend all tabs (this window)' },
    '05-unsuspend-all': { key: 'unsuspendAll', default: 'Unsuspend all tabs (all windows)' }
  };
  
  const html = filteredCommands.map(command => {
    const description = commandDescriptions[command.name];
    const displayName = description ? (getMessage(description.key) || description.default) : command.description;
    const shortcut = command.shortcut || getMessage('notAssigned') || 'Not assigned';
    const isAssigned = !!command.shortcut;
    
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; margin-bottom: 8px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px;">
        <div style="flex: 1;">
          <div style="font-weight: 500; color: #333;">${escapeHtml(displayName)}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="padding: 6px 12px; background: ${isAssigned ? '#e7f3ff' : '#f0f0f0'}; color: ${isAssigned ? '#0066cc' : '#666'}; border-radius: 4px; font-size: 13px; font-weight: 500; font-family: monospace; min-width: 120px; text-align: center;">
            ${escapeHtml(shortcut)}
          </span>
        </div>
      </div>
    `;
  }).join('');
  
  container.innerHTML = html;
}

// Refresh keyboard shortcuts display
function refreshShortcuts() {
  loadKeyboardShortcuts();
  showNotice(getMessage('shortcutsRefreshed') || 'Shortcuts refreshed', 'success', 2000);
}

// Open Chrome's shortcuts management page
function openShortcutsPage() {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

/* ---------- Tab Migration Functions ---------- */

// Migration configuration for different extensions
const MIGRATION_CONFIGS = {
  marvellous: {
    name: 'The Marvellous Suspender',
    knownExtensionIds: [
      'klbibkeccnjlkjkiokjodocebajanakg', // Original The Marvellous Suspender
      'noogafoofpebimajpfpamcfhoaifemoa', // Alternative version  
      'gcknhkkoolaabfmlnjonogaaifnjlfnp', // Another known ID
      'ahfhijdlegdabablpippeagghigmibma', // Newer version
      'jlgkpaicikihijadgifklkbpdajbkhjo', // Community fork
      'ahkbmjhfoplmfkpncgoedjgkajkehcgo', // The Great Suspender (notrack)
      'plpkmjcnhhnpkblimgenmdhghfgghdpp', // The Great-er Tab Discarder
    ],
    urlPattern: '/suspended.html#',
    parseFunction: 'parseMarvellousTab',
    ui: {
      scanBtnId: 'scanMarvellousBtn',
      resultsId: 'migrationResults',
      statusId: 'migrationStatus',
      tabsListId: 'tabsList',
      tabsContainerId: 'tabsContainer',
      selectAllBtnId: 'selectAllBtn',
      deselectAllBtnId: 'deselectAllBtn',
      migrateBtnId: 'migrateSelectedBtn',
      progressContainerId: 'migrationProgressContainer',
      progressTextId: 'progressText',
      progressFillId: 'progressFill'
    }
  },
  tabSuspender: {
    name: 'Tab Suspender',
    knownExtensionIds: ['fiabciakcmgepblmdkmemdbbkilneeeh', 'laameccjpleogmfhilmffpdbiibgbekf'],
    urlPattern: '/park.html?|/suspended.html?',
    parseFunction: 'parseTabSuspenderTab',
    ui: {
      scanBtnId: 'scanTabSuspenderBtn',
      resultsId: 'tabSuspenderResults',
      statusId: 'tabSuspenderStatus',
      tabsListId: 'tabSuspenderTabsList',
      tabsContainerId: 'tabSuspenderTabsContainer',
      selectAllBtnId: 'selectAllTabSuspenderBtn',
      deselectAllBtnId: 'deselectAllTabSuspenderBtn',
      migrateBtnId: 'migrateTabSuspenderBtn',
      progressContainerId: 'tabSuspenderProgressContainer',
      progressTextId: 'tabSuspenderProgressText',
      progressFillId: 'tabSuspenderProgressFill'
    }
  },
  custom: {
    name: 'Custom Extension',
    knownExtensionIds: [], // Will be populated dynamically
    urlPattern: '', // Will be set dynamically
    parseFunction: 'parseCustomTab',
    ui: {
      scanBtnId: 'scanCustomBtn',
      resultsId: 'customResults',
      statusId: 'customStatus',
      tabsListId: 'customTabsList',
      tabsContainerId: 'customTabsContainer',
      selectAllBtnId: 'selectAllCustomBtn',
      deselectAllBtnId: 'deselectAllCustomBtn',
      migrateBtnId: 'migrateCustomBtn',
      progressContainerId: 'customProgressContainer',
      progressTextId: 'customProgressText',
      progressFillId: 'customProgressFill'
    }
  }
};

// Cache for dynamically discovered extension IDs
let discoveredExtensionIds = new Set();

// Initialize tab migration functionality
function initTabMigration() {
  // Initialize Marvellous Suspender migration
  initExtensionMigration('marvellous');
  
  // Initialize Tab Suspender migration
  initExtensionMigration('tabSuspender');
  
  // Initialize Custom migration
  initCustomMigration();
}

// Generic function to initialize migration for a specific extension
function initExtensionMigration(extensionKey) {
  const config = MIGRATION_CONFIGS[extensionKey];
  if (!config) return;
  
  const scanBtn = document.getElementById(config.ui.scanBtnId);
  const selectAllBtn = document.getElementById(config.ui.selectAllBtnId);
  const deselectAllBtn = document.getElementById(config.ui.deselectAllBtnId);
  const migrateBtn = document.getElementById(config.ui.migrateBtnId);
  
  if (scanBtn) {
    scanBtn.addEventListener('click', () => scanForExtensionTabs(extensionKey));
  }
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => selectAllTabs(config.ui.tabsContainerId));
  }
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => deselectAllTabs(config.ui.tabsContainerId));
  }
  if (migrateBtn) {
    migrateBtn.addEventListener('click', () => migrateSelectedTabs(extensionKey));
  }
}

// Initialize custom migration functionality
function initCustomMigration() {
  const testBtn = document.getElementById('testCustomPatternBtn');
  const scanBtn = document.getElementById('scanCustomBtn');
  const selectAllBtn = document.getElementById('selectAllCustomBtn');
  const deselectAllBtn = document.getElementById('deselectAllCustomBtn');
  const migrateBtn = document.getElementById('migrateCustomBtn');
  
  if (testBtn) {
    testBtn.addEventListener('click', testCustomPattern);
  }
  if (scanBtn) {
    scanBtn.addEventListener('click', scanForCustomTabs);
  }
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => selectAllTabs('customTabsContainer'));
  }
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => deselectAllTabs('customTabsContainer'));
  }
  if (migrateBtn) {
    migrateBtn.addEventListener('click', () => migrateSelectedTabs('custom'));
  }
}

// Test the custom pattern configuration
function testCustomPattern() {
  const extensionId = document.getElementById('customExtensionId').value.trim();
  const path = document.getElementById('customPath').value.trim();
  const separator = document.getElementById('customSeparator').value;
  const titleParam = document.getElementById('customTitleParam').value.trim();
  const urlParam = document.getElementById('customUrlParam').value.trim();
  
  // Validate inputs
  if (!extensionId || !path || !titleParam || !urlParam) {
    showNotice(getMessage('fillAllFields') || 'Please fill in all fields', 'warning');
    return;
  }
  
  // Generate example URL
  const exampleUrl = `chrome-extension://${extensionId}/${path}${separator}${titleParam}=${encodeURIComponent('Example Page Title')}&${urlParam}=${encodeURIComponent('https://example.com')}`;
  
  // Test parsing
  const customConfig = createCustomConfig();
  const parsedTab = parseCustomTab(exampleUrl);
  
  if (parsedTab) {
    showNotice(getMessage('patternTestSuccess') || 'Pattern test successful! Example URL parsed correctly.', 'success');
    console.log('[ZeroRAM Suspender] Custom pattern test result:', parsedTab);
  } else {
    showNotice(getMessage('patternTestFailed') || 'Pattern test failed. Please check your configuration.', 'error');
  }
}

// Create custom configuration based on user input
function createCustomConfig() {
  const extensionId = document.getElementById('customExtensionId').value.trim();
  const path = document.getElementById('customPath').value.trim();
  const separator = document.getElementById('customSeparator').value;
  const titleParam = document.getElementById('customTitleParam').value.trim();
  const urlParam = document.getElementById('customUrlParam').value.trim();
  
  return {
    extensionId,
    path,
    separator,
    titleParam,
    urlParam
  };
}

// Scan for custom extension tabs
async function scanForCustomTabs() {
  const customConfig = createCustomConfig();
  
  // Validate inputs
  if (!customConfig.extensionId || !customConfig.path || !customConfig.titleParam || !customConfig.urlParam) {
    showNotice(getMessage('fillAllFields') || 'Please fill in all fields', 'warning');
    return;
  }
  
  // Update the custom configuration
  MIGRATION_CONFIGS.custom.knownExtensionIds = [customConfig.extensionId];
  MIGRATION_CONFIGS.custom.urlPattern = `/${customConfig.path}${customConfig.separator}`;
  MIGRATION_CONFIGS.custom.name = `Custom Extension (${customConfig.extensionId.substring(0, 8)}...)`;
  
  // Perform scan using the generic function
  await scanForExtensionTabs('custom');
}

// Generic function to check if URL is from a known extension
function isKnownExtensionTab(url, extensionKey) {
  const config = MIGRATION_CONFIGS[extensionKey];
  if (!config || !url || !url.startsWith('chrome-extension://')) {
    return false;
  }
  
  // Check URL pattern based on extension type
  let matchesPattern = false;
  if (extensionKey === 'tabSuspender') {
    // Check for both Tab Suspender URL patterns
    matchesPattern = url.includes('/park.html?') || url.includes('/suspended.html?');
  } else if (extensionKey === 'custom') {
    // For custom extension, check if configuration is available
    const customConfig = createCustomConfig();
    matchesPattern = customConfig.extensionId && 
                    url.includes(customConfig.extensionId) && 
                    url.includes(`/${customConfig.path}${customConfig.separator}`);
  } else {
    // For other extensions, use the single pattern
    matchesPattern = url.includes(config.urlPattern);
  }
  
  if (!matchesPattern) {
    return false;
  }
  
  // Extract extension ID from URL
  const matches = url.match(/chrome-extension:\/\/([a-z]+)\//);
  if (!matches || matches.length < 2) {
    return false;
  }
  
  const extensionId = matches[1];
  return config.knownExtensionIds.includes(extensionId) || discoveredExtensionIds.has(extensionId);
}

// Parse Marvellous Suspender tab format
function parseMarvellousTab(url) {
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
    
    // Safely decode title with fallback
    let decodedTitle = originalUrl;
    if (title) {
      try {
        decodedTitle = decodeURIComponent(title);
      } catch (decodeError) {
        // If decoding fails, try to decode as much as possible or use the original
        console.warn('[ZeroRAM Suspender] Failed to decode title, using original encoded version:', title);
        decodedTitle = title;
      }
    }

    return {
      title: decodedTitle,
      originalUrl: originalUrl,
      position: position ? parseInt(position) : 0,
      extensionId: extensionId
    };
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error parsing Marvellous Suspender tab:', error);
    return null;
  }
}

// Parse Tab Suspender tab format
function parseTabSuspenderTab(url) {
  try {
    if (!url || !url.startsWith('chrome-extension://')) {
      return null;
    }
    
    // Check for both Tab Suspender variants
    let isVariant1 = url.includes('fiabciakcmgepblmdkmemdbbkilneeeh/park.html?');
    let isVariant2 = url.includes('laameccjpleogmfhilmffpdbiibgbekf/suspended.html?');
    
    if (!isVariant1 && !isVariant2) {
      return null;
    }
    
    const urlObj = new URL(url);
    const title = urlObj.searchParams.get('title');
    const originalUrl = urlObj.searchParams.get('url');
    
    // Must have both 'title' and 'url' parameters
    if (!originalUrl || !title) {
      return null;
    }
    
    // Extract extension ID from URL
    let extensionId = '';
    if (isVariant1) {
      extensionId = 'fiabciakcmgepblmdkmemdbbkilneeeh';
    } else if (isVariant2) {
      extensionId = 'laameccjpleogmfhilmffpdbiibgbekf';
    }
    
    // Safely decode parameters
    let decodedTitle = title;
    let decodedUrl = originalUrl;
    
    try {
      decodedTitle = decodeURIComponent(title);
      decodedUrl = decodeURIComponent(originalUrl);
    } catch (decodeError) {
      console.warn('[ZeroRAM Suspender] Failed to decode Tab Suspender parameters:', decodeError);
    }

    return {
      title: decodedTitle,
      originalUrl: decodedUrl,
      extensionId: extensionId
    };
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error parsing Tab Suspender tab:', error);
    return null;
  }
}

// Parse custom extension tab format
function parseCustomTab(url) {
  try {
    if (!url || !url.startsWith('chrome-extension://')) {
      return null;
    }
    
    const customConfig = createCustomConfig();
    
    // Check if URL matches the custom pattern
    if (!url.includes(`/${customConfig.path}${customConfig.separator}`)) {
      return null;
    }
    
    // Check if the extension ID matches
    if (!url.includes(customConfig.extensionId)) {
      return null;
    }
    
    let title, originalUrl;
    
    if (customConfig.separator === '?') {
      // Parse as query string
      const urlObj = new URL(url);
      title = urlObj.searchParams.get(customConfig.titleParam);
      originalUrl = urlObj.searchParams.get(customConfig.urlParam);
    } else {
      // Parse as hash fragment
      const hashPart = url.split('#')[1];
      if (!hashPart) {
        return null;
      }
      
      const params = new URLSearchParams(hashPart);
      title = params.get(customConfig.titleParam);
      originalUrl = params.get(customConfig.urlParam);
    }
    
    // Must have both title and URL parameters
    if (!originalUrl || !title) {
      return null;
    }
    
    // Safely decode parameters
    let decodedTitle = title;
    let decodedUrl = originalUrl;
    
    try {
      decodedTitle = decodeURIComponent(title);
      decodedUrl = decodeURIComponent(originalUrl);
    } catch (decodeError) {
      console.warn('[ZeroRAM Suspender] Failed to decode custom tab parameters:', decodeError);
    }

    return {
      title: decodedTitle,
      originalUrl: decodedUrl,
      extensionId: customConfig.extensionId
    };
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error parsing custom tab:', error);
    return null;
  }
}

// Generic function to scan for extension tabs
async function scanForExtensionTabs(extensionKey) {
  const config = MIGRATION_CONFIGS[extensionKey];
  if (!config) return;
  
  const scanBtn = document.getElementById(config.ui.scanBtnId);
  const resultsDiv = document.getElementById(config.ui.resultsId);
  const statusDiv = document.getElementById(config.ui.statusId);
  const tabsListDiv = document.getElementById(config.ui.tabsListId);
  const tabsContainer = document.getElementById(config.ui.tabsContainerId);
  
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
    const foundTabs = [];
    const detectedExtensionIds = new Set();
    
    for (const tab of tabs) {
      // Skip our own extension's tabs
      if (tab.url && tab.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
        continue;
      }
      
      // Check URL pattern based on extension type
      let shouldParse = false;
      if (extensionKey === 'tabSuspender') {
        // Check for both Tab Suspender URL patterns
        shouldParse = tab.url && (tab.url.includes('/park.html?') || tab.url.includes('/suspended.html?'));
      } else if (extensionKey === 'custom') {
        // For custom extension, check if configuration is available
        const customConfig = createCustomConfig();
        shouldParse = tab.url && customConfig.extensionId && 
                     tab.url.includes(customConfig.extensionId) && 
                     tab.url.includes(`/${customConfig.path}${customConfig.separator}`);
      } else {
        // For other extensions, use the single pattern
        shouldParse = tab.url && tab.url.includes(config.urlPattern);
      }
      
      if (shouldParse) {
        // Parse tab using the appropriate parser
        let parsedTab = null;
        if (config.parseFunction === 'parseMarvellousTab') {
          parsedTab = parseMarvellousTab(tab.url);
        } else if (config.parseFunction === 'parseTabSuspenderTab') {
          parsedTab = parseTabSuspenderTab(tab.url);
        } else if (config.parseFunction === 'parseCustomTab') {
          parsedTab = parseCustomTab(tab.url);
        }
        
        if (parsedTab) {
          // Check if this extension ID is in our known list
          const isKnownVariant = config.knownExtensionIds.includes(parsedTab.extensionId);
          
          console.log(`[ZeroRAM Suspender] Found ${config.name} tab with extension ID: ${parsedTab.extensionId}, isKnownVariant: ${isKnownVariant}`);
          
          foundTabs.push({
            ...parsedTab,
            tabId: tab.id,
            tabIndex: tab.index,
            favIconUrl: tab.favIconUrl,
            isUnknownVariant: !isKnownVariant
          });
          
          detectedExtensionIds.add(parsedTab.extensionId);
          
          // Add to discovered IDs if it's unknown
          if (!isKnownVariant) {
            discoveredExtensionIds.add(parsedTab.extensionId);
          }
        }
      }
    }
    
    // Log detected extension IDs for debugging
    if (detectedExtensionIds.size > 0) {
      console.log(`[ZeroRAM Suspender] Detected ${config.name} extension IDs:`, Array.from(detectedExtensionIds));
    }
    
    // Update status and display results
    if (foundTabs.length === 0) {
      const noTabsFoundKey = extensionKey === 'marvellous' ? 'noMarvellousTabFound' : 'noTabSuspenderTabFound';
      statusDiv.textContent = getMessage(noTabsFoundKey) || `No ${config.name} tabs found`;
      statusDiv.style.color = '#666';
    } else {
      const knownVariants = foundTabs.filter(tab => !tab.isUnknownVariant).length;
      const unknownVariants = foundTabs.filter(tab => tab.isUnknownVariant).length;
      
      const foundTabsKey = extensionKey === 'marvellous' ? 'foundMarvellousTab' : 'foundTabSuspenderTab';
      let statusText = (getMessage(foundTabsKey) || `Found %d ${config.name} tabs`).replace('%d', foundTabs.length);
      if (unknownVariants > 0) {
        statusText += ` (${unknownVariants} ${getMessage('unknownVariant') || 'unknown variant'})`;
      }
      
      statusDiv.textContent = statusText;
      statusDiv.style.color = '#27ae60';
      
      // Display tabs list
      displayExtensionTabs(foundTabs, tabsContainer);
      tabsListDiv.style.display = 'block';
    }
  } catch (error) {
    console.error(`[ZeroRAM Suspender] Error scanning ${config.name} tabs:`, error);
    statusDiv.textContent = (getMessage('errorScanningTabs') || 'Error scanning tabs: ') + error.message;
    statusDiv.style.color = '#dc3545';
  } finally {
    // Re-enable scan button
    scanBtn.disabled = false;
    scanBtn.style.opacity = '1';
  }
}

// Generic function to display found extension tabs
function displayExtensionTabs(tabs, container) {
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
      ? `<span style="background: #ffc107; color: #333; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 8px;">${getMessage('unknownVariant') || 'Unknown Variant'}</span>`
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
          ${getMessage('extensionId') || 'Extension ID'}: ${tabData.extensionId}
        </div>
      </div>
    `;
    
    container.appendChild(tabItem);
  });
}

// Generic function to select all tabs in a container
function selectAllTabs(containerId) {
  const checkboxes = document.querySelectorAll(`#${containerId} input[type="checkbox"]`);
  checkboxes.forEach(checkbox => {
    checkbox.checked = true;
  });
}

// Generic function to deselect all tabs in a container
function deselectAllTabs(containerId) {
  const checkboxes = document.querySelectorAll(`#${containerId} input[type="checkbox"]`);
  checkboxes.forEach(checkbox => {
    checkbox.checked = false;
  });
}

// Generic progress bar utility functions for extension migrations
const ProgressBarUtils = {
  // Update progress display with flexible configuration
  updateProgress: function(options = {}) {
    const {
      completed = 0,
      total = 0,
      containerSelector = '#migrationProgressContainer',
      textSelector = '#progressText',
      fillSelector = '#progressFill',
      customText = null,
      showPercentage = false
    } = options;
    
    const progressContainer = document.querySelector(containerSelector);
    const progressText = document.querySelector(textSelector);
    const progressFill = document.querySelector(fillSelector);
    
    if (!progressContainer || !progressText || !progressFill) {
      console.warn('[ZeroRAM Suspender] Progress elements not found with selectors:', {
        containerSelector, textSelector, fillSelector
      });
      return false;
    }
    
    // Show progress container
    progressContainer.style.display = 'block';
    
    // Update progress text
    if (customText) {
      progressText.textContent = customText;
    } else if (showPercentage) {
      const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
      progressText.textContent = `${completed}/${total} (${percentage}%)`;
    } else {
      progressText.textContent = `${completed}/${total}`;
    }
    
    // Update progress bar fill
    const percentage = total > 0 ? (completed / total) * 100 : 0;
    progressFill.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
    
    return true;
  },
  
  // Hide progress display
  hideProgress: function(containerSelector = '#migrationProgressContainer') {
    const progressContainer = document.querySelector(containerSelector);
    if (progressContainer) {
      progressContainer.style.display = 'none';
      return true;
    }
    return false;
  },
  
  // Reset progress to initial state
  resetProgress: function(options = {}) {
    const {
      containerSelector = '#migrationProgressContainer',
      textSelector = '#progressText',
      fillSelector = '#progressFill'
    } = options;
    
    this.updateProgress({
      completed: 0,
      total: 0,
      containerSelector,
      textSelector,
      fillSelector,
      customText: '0/0'
    });
    
    // Hide after reset
    setTimeout(() => {
      this.hideProgress(containerSelector);
    }, 100);
  }
};

// wrapper functions for migration
function updateMigrationProgress(completed, total) {
  return ProgressBarUtils.updateProgress({
    completed,
    total,
    containerSelector: '#migrationProgressContainer',
    textSelector: '#progressText',
    fillSelector: '#progressFill'
  });
}

function hideMigrationProgress() {
  return ProgressBarUtils.hideProgress('#migrationProgressContainer');
}

// Generic function to migrate selected tabs
async function migrateSelectedTabs(extensionKey) {
  const config = MIGRATION_CONFIGS[extensionKey];
  if (!config) return;
  
  const checkboxes = document.querySelectorAll(`#${config.ui.tabsContainerId} input[type="checkbox"]:checked`);
  const migrateBtn = document.getElementById(config.ui.migrateBtnId);
  
  if (checkboxes.length === 0) {
    showNotice(getMessage('noTabsSelected') || 'No tabs selected', 'warning');
    return;
  }
  
  const totalTabs = checkboxes.length;
  let successCount = 0;
  let failureCount = 0;
  let processedCount = 0;
  
  try {
    // Disable migrate button
    migrateBtn.disabled = true;
    migrateBtn.style.opacity = '0.6';
    
    // Initialize progress bar using the extension-specific elements
    ProgressBarUtils.updateProgress({
      completed: 0,
      total: totalTabs,
      containerSelector: `#${config.ui.progressContainerId}`,
      textSelector: `#${config.ui.progressTextId}`,
      fillSelector: `#${config.ui.progressFillId}`
    });
    
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
        console.error(`[ZeroRAM Suspender] Error migrating ${config.name} tab:`, error);
        failureCount++;
      }
      
      // Update progress after each tab is processed
      processedCount++;
      ProgressBarUtils.updateProgress({
        completed: processedCount,
        total: totalTabs,
        containerSelector: `#${config.ui.progressContainerId}`,
        textSelector: `#${config.ui.progressTextId}`,
        fillSelector: `#${config.ui.progressFillId}`
      });
      
      // Add a small delay to make progress visible and avoid overwhelming the browser
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Show completion message
    if (successCount > 0) {
      const migrationCompleteMsg = getMessage('migrationComplete') || 'Migration completed';
      const tabsMigratedMsg = getMessage('tabsMigrated') || ' tabs migrated';
      showNotice(`${migrationCompleteMsg} (${successCount}${tabsMigratedMsg})`, 'success');
      
      // Refresh the tab list after a short delay
      setTimeout(() => {
        scanForExtensionTabs(extensionKey);
      }, 1000);
    }
    
    if (failureCount > 0) {
      const migrationFailedMsg = getMessage('migrationFailed') || 'Migration failed';
      const tabsFailedMsg = getMessage('tabsFailed') || ' tabs failed';
      showNotice(`${migrationFailedMsg} (${failureCount}${tabsFailedMsg})`, 'error');
    }
  } catch (error) {
    console.error(`[ZeroRAM Suspender] ${config.name} migration error:`, error);
    const migrationFailedMsg = getMessage('migrationFailed') || 'Migration failed';
    showNotice(`${migrationFailedMsg}: ${error.message}`, 'error');
  } finally {
    // Hide progress bar and re-enable migrate button after a short delay
    setTimeout(() => {
      ProgressBarUtils.hideProgress(`#${config.ui.progressContainerId}`);
      migrateBtn.disabled = false;
      migrateBtn.style.opacity = '1';
    }, 1000);
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
  // Reset Marvellous Suspender migration state
  resetExtensionMigrationState('marvellous');
  
  // Reset Tab Suspender migration state
  resetExtensionMigrationState('tabSuspender');
  
  // Reset Custom migration state
  resetExtensionMigrationState('custom');
  
  console.log('[ZeroRAM Suspender] All migration states reset');
}

// Generic function to reset migration state for a specific extension
function resetExtensionMigrationState(extensionKey) {
  const config = MIGRATION_CONFIGS[extensionKey];
  if (!config) return;
  
  const resultsDiv = document.getElementById(config.ui.resultsId);
  const statusDiv = document.getElementById(config.ui.statusId);
  const tabsListDiv = document.getElementById(config.ui.tabsListId);
  const tabsContainer = document.getElementById(config.ui.tabsContainerId);
  const scanBtn = document.getElementById(config.ui.scanBtnId);
  
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
  
  console.log(`[ZeroRAM Suspender] ${config.name} migration state reset`);
}

// Clear discovered extension IDs cache (for testing purposes)
function clearDiscoveredIds() {
  discoveredExtensionIds.clear();
  console.log('[ZeroRAM Suspender] Cleared discovered extension IDs cache');
}

// Export for potential use in console debugging
if (typeof window !== 'undefined') {
  window.ZeroRAMSuspenderDebug = {
    clearDiscoveredIds,
    resetMigrationState,
    resetExtensionMigrationState,
    getMigrationConfigs: () => MIGRATION_CONFIGS,
    getDiscoveredIds: () => Array.from(discoveredExtensionIds),
    scanForExtensionTabs,
    // Export progress utilities for testing and future use
    ProgressBarUtils
  };
}

/* ---------- End Tab Migration Functions ---------- */

/* ---------- Change Log Functions ---------- */

// Load and display changelog from GitHub API
async function loadChangelog() {
  const changelogContent = document.getElementById('changelogContent');
  
  try {
    // Show loading state
    changelogContent.innerHTML = `
      <div class="loading-state" style="text-align: center; padding: 40px; color: #666;">
        <div style="font-size: 24px; margin-bottom: 12px;">⏳</div>
        <span data-i18n="loadingChanges">Loading change log...</span>
      </div>
    `;
    
    // Fetch commits from local CHANGELOG.json file
    const response = await fetch(chrome.runtime.getURL('CHANGELOG.json'));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const commits = await response.json();
    
    // Parse commits and extract version changes
    const changelog = parseCommitsToChangelog(commits);
    
    if (changelog.length === 0) {
      changelogContent.innerHTML = `
        <div class="empty-state">
          <div class="icon">📝</div>
          <h3 data-i18n="noChangesFound">No version changes found</h3>
        </div>
      `;
      return;
    }
    
    // Render changelog
    renderChangelog(changelog, changelogContent);
    
  } catch (error) {
    console.error('Failed to load changelog:', error);
    changelogContent.innerHTML = `
      <div class="empty-state">
        <div class="icon">❌</div>
        <h3 data-i18n="failedToLoadChanges">Failed to load change log</h3>
        <p style="color: #999; font-size: 12px;">${error.message}</p>
      </div>
    `;
  }
}

// Parse commits and group by version
function parseCommitsToChangelog(commits) {
  const changelog = [];
  let currentVersion = null;
  let currentChanges = [];
  
  // Check if there's an explicit 1.0.0 version update
  const hasExplicitV100 = commits.some(commit => 
    commit.commit.message.includes('Update version to 1.0.0')
  );
  
  for (const commit of commits) {
    const message = commit.commit.message;
    const date = new Date(commit.commit.author.date);
    
    // Check if this is a version update commit
    const versionMatch = message.match(/Update version to ([\d.]+)/);
    
    // Check if this is the initial commit (should be 1.0.0)
    const isInitialCommit = message === 'Initial commit';
    
    if (versionMatch) {
      // Save previous version changes if any
      if (currentVersion && currentChanges.length > 0) {
        changelog.push({
          version: currentVersion.version,
          date: currentVersion.date,
          changes: currentChanges
        });
      }
      
      // Start new version
      currentVersion = {
        version: versionMatch[1],
        date: date
      };
      currentChanges = [];
    } else if (isInitialCommit && !hasExplicitV100) {
      // Save previous version changes if any
      if (currentVersion && currentChanges.length > 0) {
        changelog.push({
          version: currentVersion.version,
          date: currentVersion.date,
          changes: currentChanges
        });
      }
      
      // Start 1.0.0 for initial commit
      currentVersion = {
        version: '1.0.0',
        date: date
      };
      currentChanges = [
        { type: 'added', description: 'Initial release', sha: commit.sha.substring(0, 7), url: commit.html_url }
      ];
    } else if (currentVersion) {
      // Add change to current version
      const change = parseCommitMessage(message, commit);
      if (change) {
        currentChanges.push(change);
      }
    } else {
      // Changes without version (for latest unreleased changes)
      if (!currentVersion) {
        currentVersion = {
          version: getMessage("unreleased") || 'Unreleased',
          date: date
        };
      }
      const change = parseCommitMessage(message, commit);
      if (change) {
        currentChanges.push(change);
      }
    }
  }
  
  // Add final version
  if (currentVersion && currentChanges.length > 0) {
    changelog.push({
      version: currentVersion.version,
      date: currentVersion.date,
      changes: currentChanges
    });
  }
  
  return changelog;
}

// Parse individual commit message to extract meaningful changes
function parseCommitMessage(message, commit) {
  // Skip version update commits and merge commits
  if (message.includes('Update version to') || message.startsWith('Merge ')) {
    return null;
  }
  
  // Clean up the message and get first line only
  const description = message.split('\n')[0].trim();
  const firstLine = description.toLowerCase();
  
  // Determine change type based on first line of message
  let type = 'changed';
  if (firstLine.includes('add') || firstLine.includes('new') || firstLine.includes('implement')) {
    type = 'added';
  } else if (firstLine.includes('fix') || firstLine.includes('repair')) {
    type = 'fixed';
  } else if (firstLine.includes('remove') || firstLine.includes('delete')) {
    type = 'removed';
  } else if (firstLine.includes('enhance') || firstLine.includes('improve')) {
    type = 'improved';
  }
  
  return {
    type: type,
    description: description,
    sha: commit.sha.substring(0, 7),
    url: commit.html_url
  };
}

// Render changelog to DOM
function renderChangelog(changelog, container) {
  const html = changelog.map(version => {
    // Group changes by type
    const changesByType = version.changes.reduce((groups, change) => {
      const type = change.type;
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(change);
      return groups;
    }, {});
    
    // Define display order for change types
    const typeOrder = ['added', 'improved', 'fixed', 'removed', 'changed'];
    
    // Generate HTML for each type group in order
    const changesHtml = typeOrder.map(type => {
      if (!changesByType[type] || changesByType[type].length === 0) {
        return '';
      }
      
      const typeChanges = changesByType[type].map(change => {
        const icon = getChangeIcon(change.type);
        return `
          <li class="changelog-item" style="margin-bottom: 8px; display: flex; align-items: flex-start; gap: 8px;">
            <span style="font-size: 14px; margin-top: 2px; width: 16px; text-align: center; flex-shrink: 0;">${icon}</span>
            <div style="flex: 1;">
              <span style="font-weight: 500; color: ${getChangeColor(change.type)}; text-transform: capitalize;">${change.type}:</span>
              <span style="margin-left: 4px;">${escapeHtml(change.description)}</span>
              <a href="${change.url}" target="_blank" style="margin-left: 8px; color: #667eea; text-decoration: none; font-size: 11px; opacity: 0.7;">${change.sha}</a>
            </div>
          </li>
        `;
      }).join('');
      
      return typeChanges;
    }).filter(html => html !== '').join('');
    
    return `
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-title" style="margin-bottom: 16px;">
          <span style="font-size: 18px; font-weight: 600;">${version.version}</span>
          <span style="margin-left: auto; color: #666; font-size: 12px; font-weight: normal;">
            ${version.date.toLocaleDateString()}
          </span>
        </div>
        <ul style="list-style: none; padding: 0; margin: 0;">
          ${changesHtml}
        </ul>
      </div>
    `;
  }).join('');
  
  container.innerHTML = html;
}

// Get icon for change type
function getChangeIcon(type) {
  const icons = {
    added: '✨',
    fixed: '🐛',
    changed: '🔄',
    removed: '🗑️',
    improved: '⚡',
    security: '🔒'
  };
  return icons[type] || '📝';
}

// Get color for change type
function getChangeColor(type) {
  const colors = {
    added: '#28a745',
    fixed: '#dc3545',
    changed: '#17a2b8',
    removed: '#6c757d',
    improved: '#ffc107',
    security: '#fd7e14'
  };
  return colors[type] || '#6c757d';
}

/* ---------- End Change Log Functions ---------- */


/* ---------- Session Management Functions ---------- */

// Reset session management previews
function resetSessionPreviews() {
  // Reset export preview
  const exportPreview = document.getElementById('exportPreview');
  if (exportPreview) {
    exportPreview.style.display = 'none';
  }
  
  // Reset import preview
  const sessionPreview = document.getElementById('sessionPreview');
  if (sessionPreview) {
    sessionPreview.style.display = 'none';
  }
  
  // Reset file input
  const sessionFileInput = document.getElementById('sessionFileInput');
  if (sessionFileInput) {
    sessionFileInput.value = '';
  }
}

// Initialize session management functionality
function initSessionManagement() {
  const exportBtn = document.getElementById('exportBtn');
  const exportPreviewBtn = document.getElementById('exportPreviewBtn');
  const sessionFileInput = document.getElementById('sessionFileInput');
  const importSessionBtn = document.getElementById('importSessionBtn');
  const previewSessionBtn = document.getElementById('previewSessionBtn');

  if (exportBtn) {
    exportBtn.addEventListener('click', handleExport);
  }

  if (exportPreviewBtn) {
    exportPreviewBtn.addEventListener('click', previewExport);
  }

  if (sessionFileInput) {
    sessionFileInput.addEventListener('change', handleSessionFileSelected);
  }

  if (importSessionBtn) {
    importSessionBtn.addEventListener('click', importSession);
  }

  if (previewSessionBtn) {
    previewSessionBtn.addEventListener('click', previewSession);
  }
}

// Parse suspended tab URL to get original URL and title
function parseSuspendedTab(url) {
  try {
    // Check if it's our extension's suspended page
    const suspendedPrefix = chrome.runtime.getURL('suspended.html');
    if (url.startsWith(suspendedPrefix)) {
      const urlObj = new URL(url);
      const originalUrl = urlObj.searchParams.get('uri');
      const title = urlObj.searchParams.get('ttl');
      
      if (originalUrl) {
        return {
          url: originalUrl,
          title: title || originalUrl,
          isSuspended: true
        };
      }
    }
    return null;
  } catch (error) {
    console.error('Error parsing suspended tab:', error);
    return null;
  }
}

// Get all tabs from all windows with proper handling of suspended tabs
async function getAllTabs() {
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    return windows.map(window => {
      return window.tabs.map(tab => {
        // Check if this is a suspended tab and extract original info
        const suspendedInfo = parseSuspendedTab(tab.url);
        if (suspendedInfo) {
          return {
            title: suspendedInfo.title,
            url: suspendedInfo.url,
            originalTab: tab,
            wasSuspended: true
          };
        }
        
        return {
          title: tab.title,
          url: tab.url,
          originalTab: tab,
          wasSuspended: false
        };
      });
    });
  } catch (error) {
    console.error('Error getting all tabs:', error);
    throw error;
  }
}

// Handle export button click
function handleExport() {
  const formatSelect = document.getElementById('exportFormat');
  const format = formatSelect ? formatSelect.value : 'txt';
  exportSession(format);
}

// Preview export content
async function previewExport() {
  const formatSelect = document.getElementById('exportFormat');
  const format = formatSelect ? formatSelect.value : 'txt';
  
  try {
    showNotice(getMessage('generatingPreview') || 'Generating preview...', 'info', 1000);
    
    const windowTabs = await getAllTabs();
    let content = '';

    if (format === 'txt') {
      // TXT format: one URL per line, windows separated by blank lines
      content = windowTabs.map(windowTabs => 
        windowTabs.map(tab => tab.url).join('\n')
      ).join('\n\n');
      
    } else if (format === 'json') {
      // JSON format: array of windows with tab objects
      const sessionData = windowTabs.map(windowTabs => 
        windowTabs.map(tab => ({
          title: tab.title,
          url: tab.url
        }))
      );
      
      content = JSON.stringify(sessionData, null, 2);
    }

    // Display preview
    const previewContainer = document.getElementById('exportPreview');
    const previewContent = document.getElementById('exportPreviewContent');
    
    if (previewContent) {
      previewContent.textContent = content;
    }
    
    if (previewContainer) {
      previewContainer.style.display = 'block';
    }
    
    showNotice(getMessage('exportPreviewReady') || 'Export preview ready', 'success', 2000);
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error generating export preview:', error);
    showNotice(getMessage('previewFailed') || 'Preview failed', 'error', 3000);
  }
}

// Export session in specified format
async function exportSession(format) {
  try {
    showNotice(getMessage('exportingSession') || 'Exporting session...', 'info', 2000);
    
    const windowTabs = await getAllTabs();
    let content = '';
    let filename = '';
    let mimeType = '';

    if (format === 'txt') {
      // TXT format: one URL per line, windows separated by blank lines
      content = windowTabs.map(windowTabs => 
        windowTabs.map(tab => tab.url).join('\n')
      ).join('\n\n');
      
      filename = `session_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
      mimeType = 'text/plain';
      
    } else if (format === 'json') {
      // JSON format: array of windows with tab objects
      const sessionData = windowTabs.map(windowTabs => 
        windowTabs.map(tab => ({
          title: tab.title,
          url: tab.url
        }))
      );
      
      content = JSON.stringify(sessionData, null, 2);
      filename = `session_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
      mimeType = 'application/json';
    }

    // Create and download file
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showNotice(getMessage('sessionExported') || `Session exported as ${format.toUpperCase()}`, 'success', 3000);
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error exporting session:', error);
    showNotice(getMessage('exportFailed') || 'Export failed', 'error', 3000);
  }
}

// Handle session file selection
function handleSessionFileSelected(event) {
  const sessionPreview = document.getElementById('sessionPreview');
  
  // Reset session preview when file selection changes
  if (sessionPreview) {
    sessionPreview.style.display = 'none';
  }
}

// Parse session file content
function parseSessionFile(content, filename) {
  const isJson = filename.toLowerCase().endsWith('.json');
  
  if (isJson) {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        // Validate JSON structure
        const isValid = data.every(window => 
          Array.isArray(window) && 
          window.every(tab => 
            typeof tab === 'object' && 
            typeof tab.url === 'string' && 
            typeof tab.title === 'string'
          )
        );
        
        if (isValid) {
          return data;
        }
      }
      throw new Error('Invalid JSON structure');
    } catch (error) {
      throw new Error('Invalid JSON format');
    }
    
  } else {
    // Parse TXT format
    const lines = content.split('\n');
    const windows = [];
    let currentWindow = [];
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '') {
        // Empty line indicates new window
        if (currentWindow.length > 0) {
          windows.push(currentWindow);
          currentWindow = [];
        }
      // } else if (trimmedLine.startsWith('http://') || trimmedLine.startsWith('https://') || trimmedLine.startsWith('ftp://')) {  // Valid URL
      } else {
        currentWindow.push({
          title: trimmedLine,
          url: trimmedLine
        });
      }
    }
    
    // Add last window if not empty
    if (currentWindow.length > 0) {
      windows.push(currentWindow);
    }
    
    return windows;
  }
}

// Preview session content
async function previewSession() {
  const fileInput = document.getElementById('sessionFileInput');
  const file = fileInput.files[0];
  
  if (!file) {
    showNotice(getMessage('pleaseSelectFile') || 'Please select a file first', 'warning', 3000);
    return;
  }
  
  try {
    const content = await file.text();
    const sessionData = parseSessionFile(content, file.name);
    
    // Display preview
    const previewContainer = document.getElementById('sessionPreview');
    const previewContent = document.getElementById('sessionPreviewContent');
    
    let previewHtml = '';
    sessionData.forEach((windowTabs, windowIndex) => {
      previewHtml += `<div style="margin-bottom: 16px;">`;
      previewHtml += `<div style="font-weight: bold; color: #667eea; margin-bottom: 8px;">${getMessage('window') || 'Window'} ${windowIndex + 1} (${windowTabs.length} ${getMessage('tabs') || 'tabs'})</div>`;
      
      windowTabs.forEach((tab, tabIndex) => {
        previewHtml += `<div style="margin-left: 16px; margin-bottom: 4px;">`;
        previewHtml += `<span style="color: #666; font-size: 11px;">${tabIndex + 1}.</span> `;
        previewHtml += `<span style="font-weight: 500;">${escapeHtml(tab.title)}</span><br/>`;
        previewHtml += `<span style="margin-left: 16px; color: #888; font-size: 11px;">${escapeHtml(tab.url)}</span>`;
        previewHtml += `</div>`;
      });
      
      previewHtml += `</div>`;
    });
    
    previewContent.innerHTML = previewHtml;
    previewContainer.style.display = 'block';
    
    showNotice(getMessage('sessionPreviewed') || 'Session preview ready', 'success', 2000);
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error previewing session:', error);
    showNotice(getMessage('previewFailed') || 'Preview failed: Invalid file format', 'error', 3000);
  }
}

// Import session
async function importSession() {
  const fileInput = document.getElementById('sessionFileInput');
  const importAsSuspended = document.getElementById('importAsSuspended').checked;
  const file = fileInput.files[0];
  
  if (!file) {
    showNotice(getMessage('pleaseSelectFile') || 'Please select a file first', 'warning', 3000);
    return;
  }
  
  try {
    const content = await file.text();
    const sessionData = parseSessionFile(content, file.name);
    
    // Show progress
    showImportProgress(true);
    let totalTabs = 0;
    let completedTabs = 0;
    
    // Count total tabs
    sessionData.forEach(windowTabs => {
      totalTabs += windowTabs.length;
    });
    
    updateImportProgress(completedTabs, totalTabs);
    
    // Import each window
    for (const windowTabs of sessionData) {
      if (windowTabs.length === 0) continue;
      
      // Create new window with first tab
      const firstTab = windowTabs[0];
      let tabUrl = firstTab.url;
      
      if (importAsSuspended) {
        tabUrl = chrome.runtime.getURL('suspended.html') + 
          `?uri=${encodeURIComponent(firstTab.url)}&ttl=${encodeURIComponent(firstTab.title)}`;
      }
      
      const newWindow = await chrome.windows.create({
        url: tabUrl,
        focused: false
      });
      
      completedTabs++;
      updateImportProgress(completedTabs, totalTabs);
      
      // Add remaining tabs to the window
      for (let i = 1; i < windowTabs.length; i++) {
        const tab = windowTabs[i];
        let tabUrl = tab.url;
        
        if (importAsSuspended) {
          tabUrl = chrome.runtime.getURL('suspended.html') + 
            `?uri=${encodeURIComponent(tab.url)}&ttl=${encodeURIComponent(tab.title)}`;
        }
        
        await chrome.tabs.create({
          windowId: newWindow.id,
          url: tabUrl,
          active: false
        });
        
        completedTabs++;
        updateImportProgress(completedTabs, totalTabs);
        
        // Small delay to prevent overwhelming the browser
        if (i % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    
    showImportProgress(false);
    showNotice(getMessage('sessionImported') || `Session imported successfully (${totalTabs} tabs)`, 'success', 4000);
    
    // Reset file input
    fileInput.value = '';
    document.getElementById('sessionPreview').style.display = 'none';
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error importing session:', error);
    showImportProgress(false);
    showNotice(getMessage('importFailed') || 'Import failed: ' + error.message, 'error', 4000);
  }
}

// Show/hide import progress
function showImportProgress(show) {
  const container = document.getElementById('importProgressContainer');
  if (container) {
    container.style.display = show ? 'block' : 'none';
  }
}

// Update import progress
function updateImportProgress(completed, total) {
  const progressText = document.getElementById('importProgressText');
  const progressFill = document.getElementById('importProgressFill');
  
  if (progressText) {
    progressText.textContent = `${completed}/${total}`;
  }
  
  if (progressFill) {
    const percentage = total > 0 ? (completed / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
  }
}

/* ---------- End Session Management Functions ---------- */


/* ---------- Settings Management Functions ---------- */

// Initialize settings management functionality
function initSettingsManagement() {
  const exportSettingsBtn = document.getElementById('exportSettingsBtn');
  const previewSettingsBtn = document.getElementById('previewSettingsBtn');
  const settingsFileInput = document.getElementById('settingsFileInput');
  const previewImportSettingsBtn = document.getElementById('previewImportSettingsBtn');
  const importSettingsBtn = document.getElementById('importSettingsBtn');
  const resetSettingsBtn = document.getElementById('resetSettingsBtn');

  if (exportSettingsBtn) {
    exportSettingsBtn.addEventListener('click', exportSettings);
  }

  if (previewSettingsBtn) {
    previewSettingsBtn.addEventListener('click', previewSettings);
  }

  if (settingsFileInput) {
    settingsFileInput.addEventListener('change', handleSettingsFileSelected);
  }

  if (previewImportSettingsBtn) {
    previewImportSettingsBtn.addEventListener('click', previewImportSettings);
  }

  if (importSettingsBtn) {
    importSettingsBtn.addEventListener('click', importSettings);
  }

  if (resetSettingsBtn) {
    resetSettingsBtn.addEventListener('click', confirmResetSettings);
  }
}

// Get default settings
function getDefaultSettings() {
  return {
    autoSuspendMinutes: 30,
    useNativeDiscard: true,
    neverSuspendAudio: true,
    neverSuspendPinned: true,
    neverSuspendActive: false,
    rememberLastActiveTab: true,
    whitelist: [],
    themeMode: 'auto'
  };
}

// Get current settings
async function getCurrentSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(STORAGE_KEY, data => {
      const cfg = data[STORAGE_KEY] || {};
      const settings = {
        autoSuspendMinutes: cfg.autoSuspendMinutes != null ? cfg.autoSuspendMinutes : 30,
        useNativeDiscard: cfg.useNativeDiscard !== false,
        neverSuspendAudio: cfg.neverSuspendAudio !== false,
        neverSuspendPinned: cfg.neverSuspendPinned !== false,
        neverSuspendActive: cfg.neverSuspendActive === true,
        whitelist: cfg.whitelist || [],
        themeMode: cfg.themeMode || 'auto'
      };
      resolve(settings);
    });
  });
}

// Export settings
async function exportSettings() {
  try {
    showNotice(getMessage('exportingSettings') || 'Exporting settings...', 'info', 2000);
    
    const settings = await getCurrentSettings();
    const exportData = {
      ...settings,
      exportedAt: new Date().toISOString(),
      exportedBy: 'ZeroRAM Suspender',
      version: chrome.runtime.getManifest().version
    };
    
    const content = JSON.stringify(exportData, null, 2);
    const filename = `ZeroRAMSuspender-settings_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    
    // Create and download file
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showNotice(getMessage('settingsExported') || 'Settings exported successfully', 'success', 3000);
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error exporting settings:', error);
    showNotice(getMessage('exportFailed') || 'Export failed', 'error', 3000);
  }
}

// Preview current settings
async function previewSettings() {
  try {
    showNotice(getMessage('generatingPreview') || 'Generating preview...', 'info', 1000);
    
    const settings = await getCurrentSettings();
    const exportData = {
      ...settings,
      exportedAt: new Date().toISOString(),
      exportedBy: 'ZeroRAM Suspender',
      version: chrome.runtime.getManifest().version
    };
    
    const content = JSON.stringify(exportData, null, 2);
    
    // Display preview
    const previewContainer = document.getElementById('settingsPreview');
    const previewContent = document.getElementById('settingsPreviewContent');
    
    if (previewContent) {
      previewContent.textContent = content;
    }
    
    if (previewContainer) {
      previewContainer.style.display = 'block';
    }
    
    showNotice(getMessage('settingsPreviewReady') || 'Settings preview ready', 'success', 2000);
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error generating settings preview:', error);
    showNotice(getMessage('previewFailed') || 'Preview failed', 'error', 3000);
  }
}

// Handle settings file selection
function handleSettingsFileSelected(event) {
  const file = event.target.files[0];
  const importSettingsPreview = document.getElementById('importSettingsPreview');
  
  // Reset import preview when file selection changes
  if (importSettingsPreview) {
    importSettingsPreview.style.display = 'none';
  }
}

// Preview import settings
async function previewImportSettings() {
  const fileInput = document.getElementById('settingsFileInput');
  const file = fileInput.files[0];
  
  if (!file) {
    showNotice(getMessage('pleaseSelectFile') || 'Please select a file first', 'warning', 3000);
    return;
  }
  
  try {
    const content = await file.text();
    const settingsData = JSON.parse(content);
    
    // Validate settings structure
    if (!validateSettingsData(settingsData)) {
      throw new Error('Invalid settings file format');
    }
    
    // Display preview
    const previewContainer = document.getElementById('importSettingsPreview');
    const previewContent = document.getElementById('importSettingsPreviewContent');
    
    let previewText = `${getMessage('settingsFileInfo') || 'Settings File Information'}:\n`;
    
    // Format exported date to human readable format
    let exportedAtText = 'Unknown';
    if (settingsData.exportedAt) {
      try {
        const date = new Date(settingsData.exportedAt);
        exportedAtText = date.toLocaleString();
      } catch (error) {
        exportedAtText = settingsData.exportedAt;
      }
    }
    
    previewText += `${getMessage('exportedAt') || 'Exported at'}: ${exportedAtText}\n`;
    previewText += `${getMessage('version') || 'Version'}: ${settingsData.version || 'Unknown'}\n\n`;
    previewText += `${getMessage('settingsToImport') || 'Settings to import'}:\n`;
    previewText += `• ${getMessage('autoSuspendLabel') || 'Auto suspend'}: ${settingsData.autoSuspendMinutes || 0} ${getMessage('minutes') || 'minutes'}\n`;
    previewText += `• ${getMessage('nativeDiscardLabel') || 'Native discard'}: ${settingsData.useNativeDiscard ? getMessage('enabled') || 'Enabled' : getMessage('disabled') || 'Disabled'}\n`;
    previewText += `• ${getMessage('neverSuspendAudio') || 'Never suspend audio tabs'}: ${settingsData.neverSuspendAudio ? getMessage('enabled') || 'Enabled' : getMessage('disabled') || 'Disabled'}\n`;
    previewText += `• ${getMessage('neverSuspendPinned') || 'Never suspend pinned tabs'}: ${settingsData.neverSuspendPinned ? getMessage('enabled') || 'Enabled' : getMessage('disabled') || 'Disabled'}\n`;
    previewText += `• ${getMessage('neverSuspendActive') || 'Never suspend active tab'}: ${settingsData.neverSuspendActive ? getMessage('enabled') || 'Enabled' : getMessage('disabled') || 'Disabled'}\n`;
    previewText += `• ${getMessage('themeSettings') || 'Theme'}: ${settingsData.themeMode || 'auto'} (${getMessage('theme' + (settingsData.themeMode || 'auto').charAt(0).toUpperCase() + (settingsData.themeMode || 'auto').slice(1)) || settingsData.themeMode || 'auto'})\n`;
    previewText += `• ${getMessage('whitelistTitle') || 'Whitelist'}: ${(settingsData.whitelist || []).length} ${getMessage('items') || 'items'}\n`;
    
    if (settingsData.whitelist && settingsData.whitelist.length > 0) {
      previewText += '\n' + (getMessage('whitelistItems') || 'Whitelist items') + ':\n';
      settingsData.whitelist.forEach((item, index) => {
        previewText += `  ${index + 1}. ${item}\n`;
      });
    }
    
    if (previewContent) {
      previewContent.textContent = previewText;
    }
    
    if (previewContainer) {
      previewContainer.style.display = 'block';
    }
    
    showNotice(getMessage('importPreviewReady') || 'Import preview ready', 'success', 2000);
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error previewing import settings:', error);
    showNotice(getMessage('previewFailed') || 'Preview failed: Invalid file format', 'error', 3000);
  }
}

// Validate settings data structure
function validateSettingsData(data) {
  if (!data || typeof data !== 'object') return false;
  
  const requiredFields = ['autoSuspendMinutes', 'useNativeDiscard', 'neverSuspendAudio', 'neverSuspendPinned', 'neverSuspendActive', 'whitelist'];
  
  // themeMode is optional for backward compatibility
  return requiredFields.every(field => field in data);
}

// Import settings
async function importSettings() {
  const fileInput = document.getElementById('settingsFileInput');
  const file = fileInput.files[0];
  
  if (!file) {
    showNotice(getMessage('pleaseSelectFile') || 'Please select a file first', 'warning', 3000);
    return;
  }
  
  try {
    const content = await file.text();
    const settingsData = JSON.parse(content);
    
    // Validate settings structure
    if (!validateSettingsData(settingsData)) {
      throw new Error('Invalid settings file format');
    }
    
    // Prepare settings object
    const newSettings = {
      autoSuspendMinutes: settingsData.autoSuspendMinutes != null ? settingsData.autoSuspendMinutes : 30,
      useNativeDiscard: settingsData.useNativeDiscard !== false,
      neverSuspendAudio: settingsData.neverSuspendAudio !== false,
      neverSuspendPinned: settingsData.neverSuspendPinned !== false,
      neverSuspendActive: settingsData.neverSuspendActive === true,
      whitelist: Array.isArray(settingsData.whitelist) ? settingsData.whitelist : [],
      themeMode: settingsData.themeMode || 'auto'
    };
    
    // Save theme mode to localStorage for suspended page caching
    try {
      localStorage.setItem(CACHE_THEME_KEY, newSettings.themeMode);
    } catch (e) {
      console.warn('[ZeroRAM Suspender] Failed to cache theme in localStorage:', e);
    }

    // Save to storage
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [STORAGE_KEY]: newSettings }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });
    
    // Update UI
    load();
    
    showNotice(getMessage('settingsImported') || 'Settings imported successfully', 'success', 4000);
    
    // Reset file input
    fileInput.value = '';
    document.getElementById('importSettingsPreview').style.display = 'none';
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error importing settings:', error);
    showNotice(getMessage('importFailed') || 'Import failed: ' + error.message, 'error', 4000);
  }
}

// Confirm reset settings
function confirmResetSettings() {
  const confirmMsg = getMessage('confirmResetSettings') || 'Are you sure you want to reset all settings to their default values? This action cannot be undone.';
  
  if (confirm(confirmMsg)) {
    resetSettings();
  }
}

// Reset settings to defaults
async function resetSettings() {
  try {
    const defaultSettings = getDefaultSettings();
    
    // Save to storage
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set({ [STORAGE_KEY]: defaultSettings }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });
    
    // Update UI
    load();
    
    showNotice(getMessage('settingsReset') || 'Settings have been reset to defaults', 'success', 4000);
    
    // Hide previews
    const settingsPreview = document.getElementById('settingsPreview');
    const importSettingsPreview = document.getElementById('importSettingsPreview');
    
    if (settingsPreview) {
      settingsPreview.style.display = 'none';
    }
    if (importSettingsPreview) {
      importSettingsPreview.style.display = 'none';
    }
    
  } catch (error) {
    console.error('[ZeroRAM Suspender] Error resetting settings:', error);
    showNotice(getMessage('resetFailed') || 'Reset failed', 'error', 3000);
  }
}

// Reset settings previews when switching to settings section
function resetSettingsPreviews() {
  // Reset file input
  const settingsFileInput = document.getElementById('settingsFileInput');
  if (settingsFileInput) {
    settingsFileInput.value = '';
  }
  
  // Hide export preview
  const settingsPreview = document.getElementById('settingsPreview');
  if (settingsPreview) {
    settingsPreview.style.display = 'none';
  }
  
  // Hide import preview
  const importSettingsPreview = document.getElementById('importSettingsPreview');
  if (importSettingsPreview) {
    importSettingsPreview.style.display = 'none';
  }
  
  // Clear preview content
  const settingsPreviewContent = document.getElementById('settingsPreviewContent');
  if (settingsPreviewContent) {
    settingsPreviewContent.textContent = '';
  }
  
  const importSettingsPreviewContent = document.getElementById('importSettingsPreviewContent');
  if (importSettingsPreviewContent) {
    importSettingsPreviewContent.textContent = '';
  }
}

/* ---------- End Settings Management Functions ---------- */ 