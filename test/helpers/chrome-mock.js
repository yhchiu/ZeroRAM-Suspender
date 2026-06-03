/**
 * Lightweight, hand-rolled `chrome.*` mock for the ZeroRAM Suspender suite.
 *
 * Why hand-rolled: the extension mixes Promise-style MV3 calls
 * (`await chrome.storage.sync.get(key)`) with callback-style calls
 * (`chrome.storage.sync.get(key, cb)`), and the tests need to drive event
 * listeners directly. A bespoke mock gives full control over both with zero
 * external-version risk.
 *
 * `createChromeMock(initialState)` returns a fresh `chrome` object plus a set of
 * test helpers (prefixed `_`). Install it on `global.chrome` before requiring a
 * source file.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EXT_ID = 'testextensionid';

function readJson(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
  } catch (_) {
    return null;
  }
}

const MANIFEST = readJson('manifest.json') || { version: '0.0.0', icons: {} };
const EN_MESSAGES = readJson('_locales/en/messages.json') || {};

/** A minimal chrome.events.Event with a test-only `trigger`. */
function makeEvent() {
  const listeners = [];
  return {
    addListener(fn) {
      if (typeof fn === 'function' && !listeners.includes(fn)) listeners.push(fn);
    },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener(fn) {
      return listeners.includes(fn);
    },
    _listeners: listeners,
    /** Dispatch to all listeners, awaiting each; returns their return values. */
    async trigger(...args) {
      const out = [];
      for (const fn of listeners.slice()) out.push(await fn(...args));
      return out;
    },
    /** Synchronous dispatch (no awaiting). */
    triggerSync(...args) {
      return listeners.slice().map((fn) => fn(...args));
    },
  };
}

/** Build a storage area supporting both Promise and callback styles. */
function makeStorageArea(areaName, onChanged) {
  const store = {};

  function selectKeys(keys) {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') {
      return keys in store ? { [keys]: store[keys] } : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return out;
    }
    if (typeof keys === 'object') {
      // Object form supplies defaults for missing keys.
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
      return out;
    }
    return {};
  }

  const get = jest.fn((keys, cb) => {
    const result = selectKeys(keys);
    if (typeof keys === 'function') {
      // get(callback) — return everything.
      keys({ ...store });
      return undefined;
    }
    if (typeof cb === 'function') {
      cb(result);
      return undefined;
    }
    return Promise.resolve(result);
  });

  const set = jest.fn((items, cb) => {
    const changes = {};
    for (const k of Object.keys(items || {})) {
      changes[k] = { oldValue: store[k], newValue: items[k] };
      store[k] = items[k];
    }
    if (onChanged) onChanged.triggerSync(changes, areaName);
    if (typeof cb === 'function') {
      cb();
      return undefined;
    }
    return Promise.resolve();
  });

  const remove = jest.fn((keys, cb) => {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete store[k];
    if (typeof cb === 'function') {
      cb();
      return undefined;
    }
    return Promise.resolve();
  });

  const clear = jest.fn((cb) => {
    for (const k of Object.keys(store)) delete store[k];
    if (typeof cb === 'function') {
      cb();
      return undefined;
    }
    return Promise.resolve();
  });

  return { get, set, remove, clear, _store: store };
}

function tabGoneError(id) {
  return new Error(`No tab with id: ${id}.`);
}

function createChromeMock(initialState = {}) {
  const tabs = (initialState.tabs || []).map((t) => ({ ...t }));
  const windows = (initialState.windows || []).map((w) => ({ ...w }));
  let nextTabId = 1000;

  const onChanged = makeEvent();

  const ports = [];

  const chrome = {
    _tabs: tabs,
    _windows: windows,
    _ports: ports,
    _lastPort: null,
    _extId: EXT_ID,

    _setTabs(arr) {
      tabs.length = 0;
      for (const t of arr) tabs.push({ ...t });
    },
    _setWindows(arr) {
      windows.length = 0;
      for (const w of arr) windows.push({ ...w });
    },
    _getTab(id) {
      return tabs.find((t) => t.id === id);
    },

    runtime: {
      id: EXT_ID,
      lastError: null,
      getURL: jest.fn((p) => `chrome-extension://${EXT_ID}/${String(p).replace(/^\//, '')}`),
      getManifest: jest.fn(() => MANIFEST),
      openOptionsPage: jest.fn(() => Promise.resolve()),
      sendMessage: jest.fn((msg, cb) => {
        // Default router returns benign responses; tests override as needed.
        const resp =
          msg && msg.command === 'checkTempWhitelist'
            ? { whitelisted: false }
            : msg && msg.command === 'toggleTempWhitelist'
            ? { whitelisted: true }
            : { done: true };
        if (typeof cb === 'function') {
          cb(resp);
          return undefined;
        }
        return Promise.resolve(resp);
      }),
      connect: jest.fn((info) => {
        const port = {
          name: info && info.name,
          onMessage: makeEvent(),
          onDisconnect: makeEvent(),
          postMessage: jest.fn(),
          disconnect: jest.fn(),
        };
        chrome._lastPort = port;
        ports.push(port);
        return port;
      }),
      onConnect: makeEvent(),
      onMessage: makeEvent(),
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onSuspend: makeEvent(),
    },

    storage: {
      onChanged,
      sync: makeStorageArea('sync', onChanged),
      session: makeStorageArea('session', onChanged),
      local: makeStorageArea('local', onChanged),
    },

    tabs: {
      query: jest.fn((q = {}) => {
        let res = tabs.slice();
        if (q.active !== undefined) res = res.filter((t) => Boolean(t.active) === q.active);
        if (q.highlighted !== undefined) res = res.filter((t) => Boolean(t.highlighted) === q.highlighted);
        if (q.pinned !== undefined) res = res.filter((t) => Boolean(t.pinned) === q.pinned);
        if (q.audible !== undefined) res = res.filter((t) => Boolean(t.audible) === q.audible);
        if (q.windowId !== undefined) res = res.filter((t) => t.windowId === q.windowId);
        if (q.currentWindow === true) res = res.filter((t) => t.currentWindow !== false);
        return Promise.resolve(res);
      }),
      get: jest.fn((id) => {
        const tab = tabs.find((t) => t.id === id);
        return tab ? Promise.resolve(tab) : Promise.reject(tabGoneError(id));
      }),
      update: jest.fn((id, props) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return Promise.reject(tabGoneError(id));
        Object.assign(tab, props);
        return Promise.resolve(tab);
      }),
      discard: jest.fn((id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return Promise.reject(tabGoneError(id));
        tab.discarded = true;
        return Promise.resolve(tab);
      }),
      reload: jest.fn((id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return Promise.reject(tabGoneError(id));
        return Promise.resolve();
      }),
      create: jest.fn((props) => {
        const tab = { id: ++nextTabId, ...props };
        tabs.push(tab);
        return Promise.resolve(tab);
      }),
      remove: jest.fn((id) => {
        const i = tabs.findIndex((t) => t.id === id);
        if (i >= 0) tabs.splice(i, 1);
        return Promise.resolve();
      }),
      onActivated: makeEvent(),
      onUpdated: makeEvent(),
      onCreated: makeEvent(),
      onRemoved: makeEvent(),
    },

    windows: {
      WINDOW_ID_NONE: -1,
      getAll: jest.fn((opts) => {
        if (opts && opts.populate) {
          const populated = windows.map((w) => ({
            ...w,
            tabs: tabs.filter((t) => t.windowId === w.id),
          }));
          return Promise.resolve(populated);
        }
        return Promise.resolve(windows.slice());
      }),
      get: jest.fn((id) => {
        const w = windows.find((x) => x.id === id);
        return w ? Promise.resolve(w) : Promise.reject(new Error('No window'));
      }),
      onFocusChanged: makeEvent(),
    },

    alarms: {
      create: jest.fn(),
      clear: jest.fn(() => Promise.resolve(true)),
      onAlarm: makeEvent(),
    },

    commands: {
      getAll: jest.fn(() => Promise.resolve([])),
      onCommand: makeEvent(),
    },

    i18n: {
      getMessage: jest.fn((key, substitutions) => {
        const entry = EN_MESSAGES[key];
        let message = entry && typeof entry.message === 'string' ? entry.message : '';
        if (message && substitutions != null) {
          const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
          subs.forEach((value, idx) => {
            message = message.replace(new RegExp(`\\$${idx + 1}`, 'g'), String(value));
          });
        }
        return message;
      }),
    },
  };

  return chrome;
}

module.exports = { createChromeMock, EXT_ID, MANIFEST, EN_MESSAGES };
