// i18n helper functions for Chrome Extension
// Provides easy access to internationalized messages

/**
 * Get localized message by key
 * @param {string} key - Message key
 * @param {string|string[]} substitutions - Optional substitutions for placeholders
 * @returns {string} Localized message
 */
function getMessage(key, substitutions) {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch (error) {
    console.warn('Failed to get message for key:', key, error);
    return key;
  }
}

/**
 * Update text content of DOM elements with data-i18n attribute
 * Elements should have data-i18n="messageKey" attribute
 */
function localizeDOM() {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach(element => {
    const key = element.getAttribute('data-i18n');
    const substitutions = element.getAttribute('data-i18n-args');
    
    let message = getMessage(key);
    
    // Handle substitutions if provided
    if (substitutions) {
      try {
        const args = JSON.parse(substitutions);
        message = getMessage(key, args);
      } catch (e) {
        console.warn('Failed to parse i18n args:', substitutions, e);
      }
    }
    
    if (message === key) {
      console.warn('Translation not found for key:', key);
    }
    
    element.textContent = message;
  });
}

/**
 * Update placeholder text of input elements with data-i18n-placeholder attribute
 */
function localizePlaceholders() {
  const elements = document.querySelectorAll('[data-i18n-placeholder]');
  elements.forEach(element => {
    const key = element.getAttribute('data-i18n-placeholder');
    element.placeholder = getMessage(key);
  });
}

/**
 * Update title attributes with data-i18n-title attribute
 */
function localizeTitles() {
  const elements = document.querySelectorAll('[data-i18n-title]');
  elements.forEach(element => {
    const key = element.getAttribute('data-i18n-title');
    element.title = getMessage(key);
  });
}

/**
 * Initialize localization for the current page
 * Call this after DOM content is loaded
 */
function initializeI18n() {
  localizeDOM();
  localizePlaceholders();
  localizeTitles();
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeI18n);
} else {
  // Add a small delay to ensure all elements are ready
  setTimeout(initializeI18n, 10);
}

// Export functions for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getMessage,
    localizeDOM,
    localizePlaceholders,
    localizeTitles,
    initializeI18n
  };
} 