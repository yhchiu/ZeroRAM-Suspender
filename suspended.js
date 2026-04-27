// suspended.js - handle unsuspend
(function() {
  const STORAGE_KEY = 'utsSettings';
  let clickAnywhereToUnsuspend = false;
  let unsuspending = false;

  // Parse original URL from query
  const params = new URLSearchParams(location.search);
  const originalUrl = params.get('uri');
  const title = params.get('ttl');
  const favicon = params.get('favicon');
  
  if (title) {
    document.title = title;
    const titleEl = document.getElementById('origTitle');
    if (titleEl) titleEl.textContent = title;
  }
  
  // Set favicon if available using original URL
  if (originalUrl) {
    // Remove existing favicon links
    const existingLinks = document.querySelectorAll('link[rel*="icon"]');
    existingLinks.forEach(link => link.remove());
    
    // Create transparent version of favicon using page URL
    createTransparentFavicon(originalUrl);
  }
  
  // Function to create a transparent version of the favicon using Chrome Extension favicon API
  function createTransparentFavicon(pageUrl) {
    // Construct favicon URL using Chrome Extension favicon API
    function getFaviconURL(url) {
      const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
      faviconUrl.searchParams.set("pageUrl", url);
      faviconUrl.searchParams.set("size", "32");
      return faviconUrl.toString();
    }

    const faviconUrl = getFaviconURL(pageUrl);
    const img = new Image();
    
    img.onload = function() {
      // Create canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Set canvas size to favicon size (usually 16x16 or 32x32)
      canvas.width = 32;
      canvas.height = 32;
      
      // Set global alpha for transparency
      ctx.globalAlpha = 0.5; // 50% transparency
      
      // Draw the favicon
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      // Convert canvas to data URL
      const transparentFaviconUrl = canvas.toDataURL('image/png');
      
      // Set the transparent favicon
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = transparentFaviconUrl;
      document.head.appendChild(link);
    };
    
    img.onerror = function() {
      // If loading fails, try to use the original page URL as fallback
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = faviconUrl;
      document.head.appendChild(link);
    };
    
    img.src = faviconUrl;
  }

  const urlEl = document.getElementById('origUrl');
  if (urlEl && originalUrl) {
    urlEl.textContent = originalUrl;
    urlEl.href = originalUrl;
  }

  function setClickAnywhereInstruction() {
    const instructionEl = document.querySelector('.instruction');
    if (!instructionEl || !clickAnywhereToUnsuspend) return;

    if (typeof getMessage !== 'undefined') {
      instructionEl.textContent = getMessage('suspendedInstructionClickAnywhere') || 'Click anywhere or press Ctrl+Shift+Z to reload this tab.';
    } else {
      instructionEl.textContent = 'Click anywhere or press Ctrl+Shift+Z to reload this tab.';
    }
    instructionEl.setAttribute('data-i18n', 'suspendedInstructionClickAnywhere');
  }

  try {
    chrome.storage.sync.get(STORAGE_KEY, data => {
      const cfg = data[STORAGE_KEY] || {};
      clickAnywhereToUnsuspend = cfg.clickAnywhereToUnsuspend === true;
      document.body.classList.toggle('click-anywhere-unsuspend', clickAnywhereToUnsuspend);
      setClickAnywhereInstruction();
    });
  } catch (e) {
    console.warn('[ZeroRAM Suspender] Failed to load suspended page click settings:', e);
  }

  function unsuspend() {
    if (originalUrl && !unsuspending) {
      unsuspending = true;
      // Update status to "Reloading" before redirecting
      const statusEl = document.querySelector('.status');
      if (statusEl) {
        // Get the translated text for "tabReloading"
        if (typeof getMessage !== 'undefined') {
          statusEl.textContent = getMessage('tabReloading');
        } else {
          // Fallback text
          statusEl.textContent = 'Reloading...';
        }
        statusEl.setAttribute('data-i18n', 'tabReloading');
        // Add reloading style for background color change
        statusEl.classList.add('reloading');
      }
      
      // Add reloading animation to sleep icon
      const sleepIcon = document.querySelector('.sleep-icon');
      if (sleepIcon) {
        sleepIcon.classList.add('reloading');
      }
      
      // Notify background script that this tab is being unsuspended
      chrome.runtime.sendMessage({
        command: 'startUnsuspending',
        tabId: chrome.tabs ? undefined : 'current' // Will be resolved by background script
      });
      
      // Small delay to ensure the status update is visible
      setTimeout(() => {
        location.href = originalUrl;
      }, 100);
    }
  }

  // Add click listener to the entire document. By default the original title/URL
  // section remains selectable; the option below makes that area clickable too.
  document.addEventListener('mousedown', function(event) {
    var e = event || window.event;
    if (e.buttons !== 1) {
      return;
    }

    const origSection = document.getElementById('origSection');
    
    // Check if the click target is within origSection
    if (origSection && origSection.contains(event.target) && !clickAnywhereToUnsuspend) {
      return; // Don't unsuspend if clicking within origSection
    }

    // When the original URL is clicked in click-anywhere mode, keep it on the
    // normal unsuspend path so the background script is notified.
    if (origSection && origSection.contains(event.target)) {
      event.preventDefault();
    }
    
    // Unsuspend for clicks anywhere else
    unsuspend();
  });

  document.addEventListener('click', function(event) {
    const origSection = document.getElementById('origSection');

    if (clickAnywhereToUnsuspend && origSection && origSection.contains(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  // Keyboard shortcut handler for Ctrl+Shift+Z
  function handleKeydown(event) {
    if (event.ctrlKey && event.shiftKey && event.key === 'Z') {
      event.preventDefault(); // Prevent browser's default action
      unsuspend();
    }
  }

  // Click anywhere (except origSection by default) or Ctrl+Shift+Z to unsuspend
  document.addEventListener('keydown', handleKeydown);
})();
