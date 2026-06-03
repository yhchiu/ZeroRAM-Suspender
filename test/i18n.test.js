/** Tests for i18n.js — localized message helpers and DOM localization. */
const { loadI18n } = require('./helpers/load-source');

describe('i18n.js', () => {
  let chrome;
  let i18n;

  beforeEach(() => {
    jest.useFakeTimers();
    ({ chrome, i18n } = loadI18n());
    jest.clearAllTimers(); // drop the auto-init timer scheduled on load
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getMessage', () => {
    test('returns the localized message when present', () => {
      chrome.i18n.getMessage.mockImplementation((key) => (key === 'hello' ? 'Hello!' : ''));
      expect(i18n.getMessage('hello')).toBe('Hello!');
    });

    test('falls back to the key when no translation exists', () => {
      chrome.i18n.getMessage.mockImplementation(() => '');
      expect(i18n.getMessage('missingKey')).toBe('missingKey');
    });

    test('passes substitutions through to chrome.i18n', () => {
      chrome.i18n.getMessage.mockImplementation((key, subs) => `${key}:${subs}`);
      expect(i18n.getMessage('k', ['a'])).toBe('k:a');
      expect(chrome.i18n.getMessage).toHaveBeenCalledWith('k', ['a']);
    });

    test('returns the key and warns if chrome.i18n throws', () => {
      chrome.i18n.getMessage.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(i18n.getMessage('boomKey')).toBe('boomKey');
      expect(console.warn).toHaveBeenCalled();
    });

    test('resolves a real message from the en locale bundle', () => {
      // Default mock reads _locales/en/messages.json.
      expect(i18n.getMessage('extName')).toBe('ZeroRAM Suspender');
    });
  });

  describe('localizeDOM', () => {
    test('sets textContent from data-i18n keys', () => {
      chrome.i18n.getMessage.mockImplementation((key) =>
        key === 'greeting' ? 'Hi there' : ''
      );
      document.body.innerHTML = '<span data-i18n="greeting"></span>';
      i18n.localizeDOM();
      expect(document.querySelector('span').textContent).toBe('Hi there');
    });

    test('warns when a translation is missing (falls back to key)', () => {
      chrome.i18n.getMessage.mockImplementation(() => '');
      document.body.innerHTML = '<span data-i18n="absent"></span>';
      i18n.localizeDOM();
      expect(document.querySelector('span').textContent).toBe('absent');
      expect(console.warn).toHaveBeenCalledWith('Translation not found for key:', 'absent');
    });

    test('applies parsed data-i18n-args substitutions', () => {
      chrome.i18n.getMessage.mockImplementation((key, subs) =>
        subs ? `count=${subs[0]}` : 'no-args'
      );
      const span = document.createElement('span');
      span.setAttribute('data-i18n', 'k');
      span.setAttribute('data-i18n-args', '["5"]');
      document.body.appendChild(span);
      i18n.localizeDOM();
      expect(span.textContent).toBe('count=5');
    });

    test('warns on malformed data-i18n-args JSON', () => {
      chrome.i18n.getMessage.mockImplementation((key) => 'fallback');
      const span = document.createElement('span');
      span.setAttribute('data-i18n', 'k');
      span.setAttribute('data-i18n-args', 'not-json');
      document.body.appendChild(span);
      i18n.localizeDOM();
      expect(console.warn).toHaveBeenCalledWith(
        'Failed to parse i18n args:',
        'not-json',
        expect.anything()
      );
    });
  });

  test('localizePlaceholders sets input placeholders', () => {
    chrome.i18n.getMessage.mockImplementation(() => 'Type here');
    document.body.innerHTML = '<input data-i18n-placeholder="ph" />';
    i18n.localizePlaceholders();
    expect(document.querySelector('input').placeholder).toBe('Type here');
  });

  test('localizeTitles sets title attributes', () => {
    chrome.i18n.getMessage.mockImplementation(() => 'A tooltip');
    document.body.innerHTML = '<button data-i18n-title="t"></button>';
    i18n.localizeTitles();
    expect(document.querySelector('button').title).toBe('A tooltip');
  });

  test('initializeI18n localizes text, placeholders, and titles together', () => {
    chrome.i18n.getMessage.mockImplementation((key) => `msg:${key}`);
    document.body.innerHTML = `
      <span data-i18n="a"></span>
      <input data-i18n-placeholder="b" />
      <button data-i18n-title="c"></button>
    `;
    i18n.initializeI18n();
    expect(document.querySelector('span').textContent).toBe('msg:a');
    expect(document.querySelector('input').placeholder).toBe('msg:b');
    expect(document.querySelector('button').title).toBe('msg:c');
  });

  test('auto-initializes via setTimeout when document is already loaded', () => {
    jest.useFakeTimers();
    const chrome2 = require('./helpers/load-source').installChrome();
    chrome2.i18n.getMessage.mockImplementation((key) => `auto:${key}`);
    document.body.innerHTML = '<span data-i18n="x"></span>';
    require('./helpers/load-source').requireSource('i18n.js');
    jest.advanceTimersByTime(10);
    expect(document.querySelector('span').textContent).toBe('auto:x');
  });
});
