/** Tests for suspended-theme.js — theme normalization and application. */
const { installChrome, requireSource } = require('./helpers/load-source');
const { resetDom } = require('./helpers/dom');

const CACHE_KEY = 'utsCacheThemeMode';
const STORAGE_KEY = 'utsSettings';

function setMatchMedia(matches) {
  const fn = jest.fn(() => ({
    matches,
    media: '(prefers-color-scheme: dark)',
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
  window.matchMedia = fn;
  global.matchMedia = fn;
}

describe('suspended-theme.js', () => {
  beforeEach(() => {
    resetDom();
    localStorage.clear();
    delete window.currentTheme;
    setMatchMedia(false);
  });

  describe('normalizeThemeMode', () => {
    test('keeps valid modes', () => {
      const chrome = installChrome();
      void chrome;
      const { normalizeThemeMode } = requireSource('suspended-theme.js');
      expect(normalizeThemeMode('auto')).toBe('auto');
      expect(normalizeThemeMode('light')).toBe('light');
      expect(normalizeThemeMode('dark')).toBe('dark');
    });

    test('returns null for invalid modes', () => {
      installChrome();
      const { normalizeThemeMode } = requireSource('suspended-theme.js');
      expect(normalizeThemeMode('rainbow')).toBeNull();
      expect(normalizeThemeMode(null)).toBeNull();
      expect(normalizeThemeMode(undefined)).toBeNull();
      expect(normalizeThemeMode('')).toBeNull();
    });
  });

  describe('applyTheme', () => {
    function load() {
      installChrome();
      return requireSource('suspended-theme.js');
    }

    test('dark mode sets dark background and data-theme', () => {
      const { applyTheme } = load();
      applyTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(document.documentElement.style.backgroundColor).toBe('rgb(26, 26, 26)');
      expect(window.currentTheme).toBe('dark');
    });

    test('light mode sets light background and data-theme', () => {
      const { applyTheme } = load();
      applyTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(document.documentElement.style.backgroundColor).toBe('rgb(248, 249, 250)');
      expect(window.currentTheme).toBe('light');
    });

    test('auto mode follows prefers-color-scheme: dark', () => {
      const { applyTheme } = load();
      setMatchMedia(true);
      applyTheme('auto');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test('auto mode follows prefers-color-scheme: light', () => {
      const { applyTheme } = load();
      setMatchMedia(false);
      applyTheme('auto');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    test('invalid mode is treated as auto', () => {
      const { applyTheme } = load();
      setMatchMedia(true);
      applyTheme('nonsense');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('IIFE on load', () => {
    test('uses cached theme from localStorage without reading chrome.storage', () => {
      localStorage.setItem(CACHE_KEY, 'dark');
      const chrome = installChrome();
      requireSource('suspended-theme.js');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(chrome.storage.sync.get).not.toHaveBeenCalled();
    });

    test('falls back to chrome.storage when no cache, then caches the result', () => {
      const chrome = installChrome();
      chrome.storage.sync._store[STORAGE_KEY] = { themeMode: 'light' };
      requireSource('suspended-theme.js');
      expect(chrome.storage.sync.get).toHaveBeenCalled();
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(localStorage.getItem(CACHE_KEY)).toBe('light');
    });

    test('clears an invalid cached value and reads from storage', () => {
      localStorage.setItem(CACHE_KEY, 'bogus');
      const chrome = installChrome();
      chrome.storage.sync._store[STORAGE_KEY] = { themeMode: 'dark' };
      requireSource('suspended-theme.js');
      expect(chrome.storage.sync.get).toHaveBeenCalled();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(localStorage.getItem(CACHE_KEY)).toBe('dark');
    });

    test('defaults to auto when storage has no themeMode', () => {
      const chrome = installChrome();
      setMatchMedia(true);
      requireSource('suspended-theme.js');
      expect(localStorage.getItem(CACHE_KEY)).toBe('auto');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });
});
