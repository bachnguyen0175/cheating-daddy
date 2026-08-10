// Test seam for the Electron-dependent modules.
//
// gemini.js, localai.js and renderer.js all pull in `electron` (and gemini.js
// also `@google/genai`) at module scope, so a plain `node --test` run cannot
// load them: there is no Electron runtime, and requiring the real package from
// Node throws. AGENTS.md requires the suite to need no devDependencies and no
// Electron runtime, which rules out a mocking library.
//
// So we intercept Module._load: a request for a stubbed specifier resolves to
// our fake, everything else falls through to the real loader untouched. The
// tests then exercise the production modules themselves rather than a copy of
// their logic.
//
// Install BEFORE requiring the module under test -- CommonJS resolves the
// requires at load time, and the result is cached.

const Module = require('node:module');

const originalLoad = Module._load;
let activeStubs = null;

// The subset of Electron these three modules actually touch. Inspection hooks
// are `__`-prefixed so they cannot collide with a real Electron export.
function createElectronStub() {
    const sent = [];
    const invocations = [];
    const ipcMainHandlers = new Map();
    const ipcRendererListeners = new Map();

    const makeWindow = () => ({
        webContents: {
            send: (channel, data) => sent.push({ channel, data }),
            executeJavaScript: async () => undefined,
            on: () => {},
            once: () => {},
        },
        isDestroyed: () => false,
        on: () => {},
        show: () => {},
        hide: () => {},
    });

    let windows = [makeWindow()];

    return {
        __sent: sent,
        __invocations: invocations,
        __ipcMainHandlers: ipcMainHandlers,
        __ipcRendererListeners: ipcRendererListeners,
        __makeWindow: makeWindow,
        __setWindows(next) {
            windows = next;
        },

        BrowserWindow: { getAllWindows: () => windows },
        ipcMain: {
            handle: (channel, fn) => ipcMainHandlers.set(channel, fn),
            on: (channel, fn) => ipcMainHandlers.set(channel, fn),
            removeHandler: channel => ipcMainHandlers.delete(channel),
        },
        ipcRenderer: {
            on: (channel, fn) => {
                if (!ipcRendererListeners.has(channel)) ipcRendererListeners.set(channel, []);
                ipcRendererListeners.get(channel).push(fn);
            },
            removeListener: () => {},
            send: () => {},
            // Every storage wrapper in renderer.js reads `result.success`, so the
            // stub has to honour the project's { success, data } envelope.
            invoke: async (channel, ...args) => {
                invocations.push({ channel, args });
                return { success: true, data: {} };
            },
        },
        app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp', quit: () => {} },
        globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
        desktopCapturer: { getSources: async () => [] },
        screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
        shell: { openExternal: async () => {} },
    };
}

function createGenAiStub() {
    return {
        GoogleGenAI: class GoogleGenAI {
            constructor(options) {
                this.options = options;
            }
        },
        Modality: { TEXT: 'TEXT', AUDIO: 'AUDIO' },
    };
}

function installModuleStubs(extra = {}) {
    if (activeStubs) {
        throw new Error('module stubs are already installed; call restoreModuleStubs() first');
    }

    activeStubs = { electron: createElectronStub(), '@google/genai': createGenAiStub(), ...extra };

    Module._load = function (request) {
        if (Object.prototype.hasOwnProperty.call(activeStubs, request)) {
            return activeStubs[request];
        }
        return originalLoad.apply(this, arguments);
    };

    return activeStubs;
}

function restoreModuleStubs() {
    Module._load = originalLoad;
    activeStubs = null;
}

// renderer.js runs in a browser context: it reads document.readyState and
// queries for its root element at module scope. readyState stays 'loading' so
// the module registers a DOMContentLoaded listener instead of eagerly running
// theme.load().
function installBrowserGlobals() {
    const domListeners = new Map();

    global.window = {};
    global.document = {
        readyState: 'loading',
        querySelector: () => null,
        addEventListener: (type, fn) => {
            if (!domListeners.has(type)) domListeners.set(type, []);
            domListeners.get(type).push(fn);
        },
        removeEventListener: () => {},
    };

    return { domListeners };
}

function restoreBrowserGlobals() {
    delete global.window;
    delete global.document;
}

module.exports = {
    installModuleStubs,
    restoreModuleStubs,
    installBrowserGlobals,
    restoreBrowserGlobals,
};
