/** Jest configuration for the ZeroRAM Suspender test suite. */
module.exports = {
  testEnvironment: 'jsdom',
  // Source files are plain (CommonJS-compatible) scripts targeting Node 22 —
  // no transpilation needed, which keeps the toolchain dependency-light.
  transform: {},
  // V8 coverage works without Babel instrumentation on modern Node.
  coverageProvider: 'v8',
  clearMocks: true,
  restoreMocks: true,
  setupFilesAfterEnv: ['<rootDir>/test/helpers/setup.js'],
  testMatch: ['<rootDir>/test/**/*.test.js'],
  collectCoverageFrom: [
    'background.js',
    'options.js',
    'popup.js',
    'suspended.js',
    'suspended-theme.js',
    'i18n.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  // Floors set to values we expect to clear so CI does not fail spuriously;
  // the suite aims considerably higher (≈90%+) on the logic-heavy files.
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 70,
      functions: 80,
      lines: 80,
    },
  },
};
