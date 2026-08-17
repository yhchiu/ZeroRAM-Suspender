/** Tests for _locales — every translation bundle must stay in sync with `en`. */
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', '_locales');
const DEFAULT_LOCALE = 'en';

const readBundle = (locale) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

/** Collect the printf-style placeholders a message uses, order-insensitively. */
const placeholders = (message) => (message.match(/%[sd]/g) || []).sort();

const localeNames = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const translations = localeNames.filter((locale) => locale !== DEFAULT_LOCALE);

describe('_locales', () => {
  const base = readBundle(DEFAULT_LOCALE);
  const baseKeys = Object.keys(base);

  test('ships the default locale declared in manifest.json', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
    );
    expect(localeNames).toContain(manifest.default_locale);
  });

  test('ships every locale we advertise', () => {
    expect(localeNames.sort()).toEqual(['en', 'ja', 'ru', 'zh_CN', 'zh_TW']);
  });

  describe.each(translations)('%s', (locale) => {
    const bundle = readBundle(locale);

    test('defines exactly the keys of the default locale', () => {
      expect(Object.keys(bundle).sort()).toEqual([...baseKeys].sort());
    });

    test('gives every key a non-empty message string', () => {
      const empty = Object.entries(bundle)
        .filter(([, entry]) => typeof entry.message !== 'string' || entry.message.trim() === '')
        .map(([key]) => key);
      expect(empty).toEqual([]);
    });

    test('preserves the placeholders of each message', () => {
      const mismatched = baseKeys.filter(
        (key) =>
          placeholders(bundle[key].message).join() !== placeholders(base[key].message).join()
      );
      expect(mismatched).toEqual([]);
    });

    test('preserves the line breaks of each message', () => {
      const lineCount = (message) => message.split('\n').length;
      const mismatched = baseKeys.filter(
        (key) => lineCount(bundle[key].message) !== lineCount(base[key].message)
      );
      expect(mismatched).toEqual([]);
    });
  });
});
