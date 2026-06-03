/**
 * Global test setup: polyfills for browser APIs jsdom does not implement, plus
 * a controllable `Image` mock. Re-applied before every test so individual tests
 * can override (e.g. `global.fetch.mockResolvedValueOnce`) without leaking.
 */

// Service workers reference `self`; jsdom aliases it to window, but be defensive.
global.self = global.self || global;

/** A controllable Image: setting `.src` fires onload (or onerror) on a microtask. */
class MockImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this._src = '';
  }
  set src(value) {
    this._src = value;
    Promise.resolve().then(() => {
      if (MockImage.mode === 'error') {
        if (this.onerror) this.onerror(new Error('mock image error'));
      } else if (this.onload) {
        this.onload();
      }
    });
  }
  get src() {
    return this._src;
  }
}
MockImage.mode = 'load';

function installBrowserDefaults() {
  MockImage.mode = 'load';
  global.Image = MockImage;

  global.requestAnimationFrame = jest.fn((cb) => setTimeout(() => cb(Date.now()), 0));
  global.cancelAnimationFrame = jest.fn((id) => clearTimeout(id));

  const mediaQuery = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
  global.matchMedia = jest.fn(mediaQuery);
  if (typeof window !== 'undefined') window.matchMedia = global.matchMedia;

  global.URL.createObjectURL = jest.fn(() => 'blob:mock-object-url');
  global.URL.revokeObjectURL = jest.fn();

  if (global.HTMLCanvasElement) {
    HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      globalAlpha: 1,
      drawImage: jest.fn(),
    }));
    HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:image/png;base64,MOCK');
  }

  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })),
      text: () => Promise.resolve(''),
    })
  );
}

beforeEach(() => {
  installBrowserDefaults();
});

global.__MockImage = MockImage;
global.__installBrowserDefaults = installBrowserDefaults;

// Quiet the very chatty console.warn/error the extension emits on expected
// error branches, while keeping spies available if a test wants to assert.
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
