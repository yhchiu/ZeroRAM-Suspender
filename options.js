// options.js - handle save/load settings with modern UI navigation
const STORAGE_KEY = 'utsSettings';
const autoSuspendEl = document.getElementById('autoSuspend');
const discardEl = document.getElementById('nativeDiscard');
const whitelistEl = document.getElementById('whitelist');

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
  progress.style.transition = `width ${duration}ms linear`;
  notice.appendChild(progress);

  // Trigger progress bar animation
  requestAnimationFrame(() => {
    progress.style.width = '0%';
  });

  container.appendChild(notice);

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
      
      // Show/hide save button based on section
      if (sectionId === 'about') {
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
        break;
      case 'whitelist':
        updatedCfg.whitelist = whitelistEl.value.split(/\n/).map(s => s.trim()).filter(Boolean);
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
        default:
          saveMessage = getMessage('savedNotice');
      }
      
      showNotice(saveMessage, 'success');
    });
  });
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  setVersion();
  load();
  
  // Check initial active section and hide save button if needed
  const initialActiveSection = getCurrentActiveSection();
  const actionBar = document.querySelector('.action-bar');
  if (initialActiveSection === 'about') {
    actionBar.style.display = 'none';
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