/**
 * Jest configuration for the benchmarks.
 *
 * Separate from the main config on purpose: these files are slow, they assert
 * almost nothing, and they must never run as part of `npm test`. The main
 * config only matches `test/**\/*.test.js`, so the `.bench.js` suffix keeps the
 * two suites apart.
 */
const path = require('path');

module.exports = {
  rootDir: path.join(__dirname, '..'),
  // Node, not jsdom: the service worker has no DOM, and jsdom's `URL` is far
  // slower than the native one Chrome uses, which would skew every reading.
  testEnvironment: 'node',
  transform: {},
  clearMocks: false,
  restoreMocks: false,
  testMatch: ['<rootDir>/bench/**/*.bench.js'],
  // The benchmarks print through console.log and are read by a human.
  verbose: false,
  // The worker leaves its own timers running (the badge flash, the seen-save
  // debounce, the re-discard throttle). A benchmark run has nothing to clean
  // up after, so let it exit instead of hanging on them.
  forceExit: true,
};
