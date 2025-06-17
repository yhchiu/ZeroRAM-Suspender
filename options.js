// options.js - handle save/load settings with modern UI navigation
const STORAGE_KEY = 'utsSettings';
const autoSuspendEl = document.getElementById('autoSuspend');
const discardEl = document.getElementById('nativeDiscard');
const whitelistEl = document.getElementById('whitelist');
const statusEl = document.getElementById('status');

// Navigation functionality
function initNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.content-section');

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

// Save settings to storage
function save() {
  const cfg = {
    autoSuspendMinutes: parseInt(autoSuspendEl.value, 10) || 0,
    useNativeDiscard: discardEl.checked,
    whitelist: whitelistEl.value.split(/\n/).map(s => s.trim()).filter(Boolean),
  };
  
  chrome.storage.sync.set({ [STORAGE_KEY]: cfg }, () => {
    chrome.runtime.sendMessage({ command: 'updateSettings', settings: cfg });
    
    // Show save confirmation with modern animation
    statusEl.textContent = getMessage('savedNotice');
    statusEl.classList.add('show');
    
    setTimeout(() => {
      statusEl.classList.remove('show');
      setTimeout(() => {
        statusEl.textContent = '';
      }, 300);
    }, 2000);
  });
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  setVersion();
  load();
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