// suspended.js - handle unsuspend
(function() {
  const STORAGE_KEY = 'utsSettings';
  const SUSPENDED_TITLE_PREFIX = '💤 ';
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

  // Build the Chrome Extension favicon API URL for a page.
  function getFaviconURL(url) {
    const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
    faviconUrl.searchParams.set("pageUrl", url);
    faviconUrl.searchParams.set("size", "32");
    return faviconUrl.toString();
  }

  // Replace the page's icon link, then notify the background script that the
  // favicon is set in the DOM so it can safely discard the tab without losing it.
  function setFavicon(url) {
    document.querySelectorAll('link[rel*="icon"]').forEach(link => link.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = url;
    document.head.appendChild(link);
    try {
      chrome.runtime.sendMessage({ command: 'faviconReady' });
    } catch (_) {}
  }

  // Apply the chosen suspended-tab indicator. Deferred until settings load so we
  // know which one the user picked.
  //   'titlePrefix' = real favicon at full opacity + a 💤 prefix on the title
  //   'favicon' (default) = render the favicon 50% transparent
  function applySuspendedIndicator(mode) {
    if (!originalUrl) return;
    if (mode === 'titlePrefix') {
      document.title = SUSPENDED_TITLE_PREFIX + (title || '');
      setFavicon(getFaviconURL(originalUrl));
    } else {
      applyTransparentFavicon(originalUrl, favicon);
    }
  }

  // Create a 50% transparent version of the favicon using the Chrome Extension
  // favicon API. Fetched as a Blob first to avoid tainted-canvas errors.
  function applyTransparentFavicon(pageUrl, fallbackFaviconUrl) {
    const faviconUrl = getFaviconURL(pageUrl);

    function setFallbackFavicon() {
      setFavicon(fallbackFaviconUrl || faviconUrl);
    }

    // Try fetching the favicon as a Blob to avoid tainted canvas issues
    fetch(faviconUrl)
      .then(response => {
        if (!response.ok) throw new Error('Network response was not ok');
        return response.blob();
      })
      .then(blob => {
        const objectURL = URL.createObjectURL(blob);
        const img = new Image();
        
        img.onload = function() {
          try {
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
            setFavicon(transparentFaviconUrl);
          } catch (e) {
            console.warn('[ZeroRAM Suspender] Tainted canvas error, falling back to original favicon:', e);
            setFallbackFavicon();
          } finally {
            URL.revokeObjectURL(objectURL);
          }
        };
        
        img.onerror = function() {
          setFallbackFavicon();
          URL.revokeObjectURL(objectURL);
        };
        
        img.src = objectURL;
      })
      .catch(err => {
        console.warn('[ZeroRAM Suspender] Failed to fetch favicon, falling back to original:', err);
        setFallbackFavicon();
      });
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
      applySuspendedIndicator(cfg.suspendedIndicatorMode === 'titlePrefix' ? 'titlePrefix' : 'favicon');
    });
  } catch (e) {
    console.warn('[ZeroRAM Suspender] Failed to load suspended page settings:', e);
    // Still show an indicator so the tab does not fall back to the extension icon.
    applySuspendedIndicator('favicon');
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
        // Extension pages cannot navigate to file:// and other restricted
        // URL schemes via location.href. For these, delegate to the
        // background script which uses chrome.tabs.update().
        // Normal http/https URLs use location.href directly to avoid
        // unnecessary service worker dependency.
        if (/^(?:file|data|blob):/i.test(originalUrl)) {
          chrome.runtime.sendMessage(
            { command: 'unsuspendNavigate', url: originalUrl },
            (response) => {
              if (chrome.runtime.lastError || !response || !response.done) {
                // Last resort: try direct navigation anyway
                location.href = originalUrl;
              }
            }
          );
        } else {
          location.href = originalUrl;
        }
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
