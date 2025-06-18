// suspended.js - handle unsuspend
(function() {
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
  
  // Set favicon if available
  if (favicon) {
    // Remove existing favicon links
    const existingLinks = document.querySelectorAll('link[rel*="icon"]');
    existingLinks.forEach(link => link.remove());
    
    // Create transparent version of favicon
    createTransparentFavicon(favicon);
  }
  
  // Function to create a transparent version of the favicon
  function createTransparentFavicon(originalFaviconUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Handle CORS if possible
    
    img.onload = function() {
      // Create canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Set canvas size to favicon size (usually 16x16 or 32x32)
      canvas.width = 32;
      canvas.height = 32;
      
      // Set global alpha for transparency
      ctx.globalAlpha = 0.5; // 50% transparency
      
      // Draw the original favicon
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
      // If loading fails (CORS or other issues), fall back to original favicon
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = originalFaviconUrl;
      document.head.appendChild(link);
    };
    
    img.src = originalFaviconUrl;
  }

  const urlEl = document.getElementById('origUrl');
  if (urlEl && originalUrl) {
    urlEl.textContent = originalUrl;
    urlEl.href = originalUrl;
  }

  function unsuspend() {
    if (originalUrl) {
      // Notify background script that this tab is being unsuspended
      chrome.runtime.sendMessage({
        command: 'startUnsuspending',
        tabId: chrome.tabs ? undefined : 'current' // Will be resolved by background script
      });
      location.href = originalUrl;
    }
  }

  // Add click listener to the entire document, but exclude origSection
  document.addEventListener('mousedown', function(event) {
    var e = event || window.event;
    if (e.buttons !== 1) {
      return;
    }

    const origSection = document.getElementById('origSection');
    
    // Check if the click target is within origSection
    if (origSection && origSection.contains(event.target)) {
      return; // Don't unsuspend if clicking within origSection
    }
    
    // Unsuspend for clicks anywhere else
    unsuspend();
  });

  // Keyboard shortcut handler for Ctrl+Shift+Z
  function handleKeydown(event) {
    if (event.ctrlKey && event.shiftKey && event.key === 'Z') {
      event.preventDefault(); // Prevent browser's default action
      unsuspend();
    }
  }

  // Click anywhere (except origSection) or Ctrl+Shift+Z to unsuspend
  document.addEventListener('keydown', handleKeydown);
})(); 