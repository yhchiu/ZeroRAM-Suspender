function applyTheme(themeMode) {
    if (!themeMode || themeMode == 'auto') {
        const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
        themeMode = isDarkMode ? 'dark' : 'light';
    }

    // Set background color to match the theme to avoid FOUC
    if (themeMode === 'dark') {
        document.documentElement.style.backgroundColor = '#1a1a1a';
    } else {
        document.documentElement.style.backgroundColor = '#f8f9fa';
    }

    document.documentElement.setAttribute('data-theme', themeMode);
    window.currentTheme = themeMode;
}

(function() {
    const STORAGE_KEY = 'utsSettings';
    const CACHE_THEME_KEY = 'utsCacheThemeMode';

    // Try to get theme from localStorage cache first
    let themeMode;
    try {
        themeMode = localStorage.getItem(CACHE_THEME_KEY);
    } catch (e) {
        console.warn('[ZeroRAM Suspender] Failed to access localStorage:', e);
    }

    // Apply theme immediately. 
    // It will cause FOUC if waiting for chrome storage to load.
    applyTheme(themeMode);

    if (!themeMode) {
        // No cache, load from chrome storage
        chrome.storage.sync.get(STORAGE_KEY, (data) => {
            const cfg = data[STORAGE_KEY] || {};
            const syncedThemeMode = cfg.themeMode || 'auto';

            applyTheme(syncedThemeMode);

            // Update cache
            try {
                localStorage.setItem(CACHE_THEME_KEY, syncedThemeMode);
            } catch (e) {
                console.warn('[ZeroRAM Suspender] Failed to cache theme in localStorage:', e);
            }
        });
    }
})();

