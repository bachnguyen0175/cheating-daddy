const test = require('node:test');
const assert = require('node:assert');

const { installModuleStubs, restoreModuleStubs, installBrowserGlobals, restoreBrowserGlobals } = require('./helpers/module-stubs');

// renderer.js is the renderer-side entry script: it requires `electron` and, at
// module scope, reads document.readyState and queries for its root element.
// Both stubs must be in place before the require. See helpers/module-stubs.js.
const stubs = installModuleStubs();
installBrowserGlobals();
const renderer = require('../src/utils/renderer');

test.after(() => {
    restoreModuleStubs();
    restoreBrowserGlobals();
});

// ---------------------------------------------------------------- module load

test('loading renderer.js publishes the cheatingDaddy bridge onto window', () => {
    // The main process drives the renderer through this object -- window.js
    // calls cheatingDaddy.handleShortcut() by name via executeJavaScript, so a
    // rename here breaks the global shortcuts silently.
    assert.strictEqual(typeof global.window.cheatingDaddy, 'object');
    assert.strictEqual(typeof global.window.cheatingDaddy.handleShortcut, 'function');
    assert.strictEqual(typeof global.window.cheatingDaddy.startCapture, 'function');
    assert.strictEqual(typeof global.window.cheatingDaddy.storage, 'object');
});

test('loading renderer.js registers its main-process IPC listeners', () => {
    // These four transcript/status channels are pushed from the main process;
    // if the module stops subscribing, the UI goes quiet with no error.
    for (const channel of ['transcript-partial', 'transcript-final', 'transcript-translation', 'update-status']) {
        assert.ok(stubs.electron.__ipcRendererListeners.has(channel), `expected a listener for '${channel}'`);
    }
});

// ---------------------------------------------------------------- convertFloat32ToInt16

test('convertFloat32ToInt16 maps silence to zero', () => {
    const out = renderer.convertFloat32ToInt16(new Float32Array([0, 0, 0]));

    assert.ok(out instanceof Int16Array);
    assert.deepStrictEqual(Array.from(out), [0, 0, 0]);
});

test('convertFloat32ToInt16 maps the full-scale endpoints without wrapping', () => {
    // +1.0 must not overflow into a negative sample -- that is the classic
    // off-by-one that turns a loud passage into a burst of noise.
    const out = renderer.convertFloat32ToInt16(new Float32Array([1, -1]));

    assert.strictEqual(out[0], 32767);
    assert.strictEqual(out[1], -32768);
});

test('convertFloat32ToInt16 clamps values beyond the -1..1 range', () => {
    const out = renderer.convertFloat32ToInt16(new Float32Array([2.5, -2.5]));

    assert.strictEqual(out[0], 32767, 'over-range positive must clamp, not wrap');
    assert.strictEqual(out[1], -32768, 'over-range negative must clamp, not wrap');
});

test('convertFloat32ToInt16 scales mid-range values proportionally', () => {
    const out = renderer.convertFloat32ToInt16(new Float32Array([0.5, -0.5]));

    // Positive uses 0x7fff, negative uses 0x8000, so the magnitudes differ by one.
    assert.strictEqual(out[0], Math.trunc(0.5 * 0x7fff));
    assert.strictEqual(out[1], Math.trunc(-0.5 * 0x8000));
});

test('convertFloat32ToInt16 preserves length and handles an empty frame', () => {
    assert.strictEqual(renderer.convertFloat32ToInt16(new Float32Array(0)).length, 0);
    assert.strictEqual(renderer.convertFloat32ToInt16(new Float32Array(1024)).length, 1024);
});

// ---------------------------------------------------------------- arrayBufferToBase64

test('arrayBufferToBase64 round-trips through Buffer', () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);

    const encoded = renderer.arrayBufferToBase64(bytes.buffer);

    assert.strictEqual(encoded, Buffer.from(bytes).toString('base64'));
    assert.deepStrictEqual(Uint8Array.from(Buffer.from(encoded, 'base64')), bytes);
});

test('arrayBufferToBase64 returns an empty string for an empty buffer', () => {
    assert.strictEqual(renderer.arrayBufferToBase64(new ArrayBuffer(0)), '');
});

test('arrayBufferToBase64 handles high bytes without mangling them', () => {
    // String.fromCharCode above 0x7f is where a naive implementation corrupts
    // binary audio, so cover the top of the byte range explicitly.
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

    assert.strictEqual(renderer.arrayBufferToBase64(bytes.buffer), Buffer.from(bytes).toString('base64'));
});
