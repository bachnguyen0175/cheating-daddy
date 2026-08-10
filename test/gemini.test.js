const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installModuleStubs, restoreModuleStubs } = require('./helpers/module-stubs');

// Stubs must be installed before gemini.js is required -- it pulls in
// `electron` and `@google/genai` at module scope. See helpers/module-stubs.js.
const stubs = installModuleStubs();
const gemini = require('../src/utils/gemini');
const storage = require('../src/storage');

test.after(() => restoreModuleStubs());

// getEnabledTools() reads real preferences off disk through storage.js, which
// derives its directory from os.homedir(). Pointing HOME at a temp dir isolates
// these tests from the developer's real config -- same approach as storage.test.js.
const originalHome = process.env.HOME;
let tempHome = null;
const originalLog = console.log;

test.beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-gemini-test-'));
    process.env.HOME = tempHome;
    stubs.electron.__sent.length = 0;
    // gemini.js logs on most paths; keep the reporter readable. warn/error stay
    // visible so a genuine failure is not masked.
    console.log = () => {};
});

test.afterEach(() => {
    console.log = originalLog;
    process.env.HOME = originalHome;
    if (tempHome) {
        fs.rmSync(tempHome, { recursive: true, force: true });
        tempHome = null;
    }
});

test('the temp-home harness actually isolates preferences', () => {
    // Guards every getEnabledTools test below: if HOME were not honoured they
    // would read the developer's real preferences and pass or fail by accident.
    assert.ok(storage.getConfigDir().startsWith(tempHome), `expected config dir inside ${tempHome}, got ${storage.getConfigDir()}`);
});

// ---------------------------------------------------------------- formatSpeakerResults

test('formatSpeakerResults labels speaker 1 as the interviewer and others as the candidate', () => {
    const text = gemini.formatSpeakerResults([
        { transcript: 'why manhole covers?', speakerId: 1 },
        { transcript: 'so they cannot fall in', speakerId: 2 },
    ]);

    assert.strictEqual(text, '[Interviewer]: why manhole covers?\n[Candidate]: so they cannot fall in\n');
});

test('formatSpeakerResults skips entries missing a transcript or a speakerId', () => {
    const text = gemini.formatSpeakerResults([
        { transcript: 'kept', speakerId: 1 },
        { transcript: '', speakerId: 2 },
        { transcript: 'no speaker id' },
        { speakerId: 2 },
    ]);

    assert.strictEqual(text, '[Interviewer]: kept\n');
});

test('formatSpeakerResults returns an empty string for no results', () => {
    assert.strictEqual(gemini.formatSpeakerResults([]), '');
});

// ---------------------------------------------------------------- convertStereoToMono

test('convertStereoToMono keeps the left channel and halves the byte length', () => {
    // Interleaved stereo PCM16: L=100, R=-100, L=200, R=-200
    const stereo = Buffer.alloc(8);
    stereo.writeInt16LE(100, 0);
    stereo.writeInt16LE(-100, 2);
    stereo.writeInt16LE(200, 4);
    stereo.writeInt16LE(-200, 6);

    const mono = gemini.convertStereoToMono(stereo);

    assert.strictEqual(mono.length, 4, 'stereo -> mono should halve the buffer');
    assert.strictEqual(mono.readInt16LE(0), 100);
    assert.strictEqual(mono.readInt16LE(2), 200);
});

test('convertStereoToMono preserves negative samples rather than clamping them', () => {
    const stereo = Buffer.alloc(4);
    stereo.writeInt16LE(-32768, 0);
    stereo.writeInt16LE(0, 2);

    assert.strictEqual(gemini.convertStereoToMono(stereo).readInt16LE(0), -32768);
});

test('convertStereoToMono returns an empty buffer for empty input', () => {
    assert.strictEqual(gemini.convertStereoToMono(Buffer.alloc(0)).length, 0);
});

// ---------------------------------------------------------------- sendToRenderer

test('sendToRenderer forwards the channel and payload to the first window', () => {
    gemini.sendToRenderer('update-status', 'Listening...');

    assert.deepStrictEqual(stubs.electron.__sent, [{ channel: 'update-status', data: 'Listening...' }]);
});

test('sendToRenderer is a no-op when no window is open', () => {
    stubs.electron.__setWindows([]);

    // The main process emits status updates during startup and teardown, when
    // there may be no window at all; that must not throw.
    assert.doesNotThrow(() => gemini.sendToRenderer('update-status', 'no window'));
    assert.strictEqual(stubs.electron.__sent.length, 0);

    stubs.electron.__setWindows([stubs.electron.__makeWindow()]);
});

// ---------------------------------------------------------------- getEnabledTools

test('getEnabledTools enables Google Search when the preference is on', async () => {
    storage.updatePreference('googleSearchEnabled', true);

    assert.deepStrictEqual(await gemini.getEnabledTools(), [{ googleSearch: {} }]);
});

test('getEnabledTools omits Google Search when the preference is off', async () => {
    storage.updatePreference('googleSearchEnabled', false);

    assert.deepStrictEqual(await gemini.getEnabledTools(), []);
});

test('getEnabledTools honours the stored default when no preference was ever saved', async () => {
    // Regression: getEnabledTools used to read the setting by injecting a script
    // into the renderer's localStorage. Nothing writes localStorage any more --
    // the renderer persists preferences through storage.updatePreference -- so
    // the lookup always missed and fell back to a hardcoded 'true', forcing the
    // tool on regardless of the user's choice. It must follow DEFAULT_PREFERENCES.
    assert.strictEqual(storage.getPreferences().googleSearchEnabled, false, 'DEFAULT_PREFERENCES should keep Google Search off');
    assert.deepStrictEqual(await gemini.getEnabledTools(), []);
});

test('getEnabledTools reflects a preference change without reloading the module', async () => {
    storage.updatePreference('googleSearchEnabled', true);
    assert.deepStrictEqual(await gemini.getEnabledTools(), [{ googleSearch: {} }]);

    storage.updatePreference('googleSearchEnabled', false);
    assert.deepStrictEqual(await gemini.getEnabledTools(), [], 'the setting is read per call, not cached at startup');
});
