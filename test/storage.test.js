const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const storage = require('../src/storage');

// storage.js derives its directory from os.homedir(), which honours $HOME on
// POSIX, and it caches nothing -- every getter re-reads from disk. So pointing
// HOME at a fresh temp dir fully isolates each test against the real filesystem.
// No mocking, no stubbing: these assertions exercise the production code paths.
const originalHome = process.env.HOME;
let tempHome = null;

test.beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-storage-test-'));
    process.env.HOME = tempHome;
});

test.afterEach(() => {
    process.env.HOME = originalHome;
    if (tempHome) {
        fs.rmSync(tempHome, { recursive: true, force: true });
        tempHome = null;
    }
});

function credentialsFile() {
    return path.join(storage.getConfigDir(), 'credentials.json');
}

test('the temp-home harness actually isolates storage', () => {
    // Guards the whole suite: if HOME is not being honoured, every other test
    // here would silently read and write the developer's real config.
    assert.ok(storage.getConfigDir().startsWith(tempHome), `expected config dir inside ${tempHome}, got ${storage.getConfigDir()}`);
    assert.strictEqual(fs.existsSync(credentialsFile()), false);
});

test('getOpenAiApiKey returns empty string when no credentials exist', () => {
    assert.strictEqual(storage.getOpenAiApiKey(), '');
});

test('setOpenAiApiKey round-trips through the real filesystem', () => {
    storage.setOpenAiApiKey('sk-round-trip-value');
    assert.strictEqual(storage.getOpenAiApiKey(), 'sk-round-trip-value');
});

test('the OpenAI key persists to credentials.json, not config.json', () => {
    storage.setOpenAiApiKey('sk-persisted');

    const credentials = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'));
    assert.strictEqual(credentials.openaiApiKey, 'sk-persisted');

    const configPath = path.join(storage.getConfigDir(), 'config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.strictEqual(config.openaiApiKey, undefined, 'API key must not leak into config.json');
    }
});

test('setOpenAiApiKey preserves the Gemini and Groq keys', () => {
    // setCredentials merges into existing credentials (storage.js:190). If that
    // merge regresses, saving one key silently destroys the others.
    storage.setApiKey('gemini-key');
    storage.setGroqApiKey('groq-key');

    storage.setOpenAiApiKey('openai-key');

    assert.strictEqual(storage.getApiKey(), 'gemini-key');
    assert.strictEqual(storage.getGroqApiKey(), 'groq-key');
    assert.strictEqual(storage.getOpenAiApiKey(), 'openai-key');
});

test('setOpenAiApiKey overwrites a previously stored key', () => {
    storage.setOpenAiApiKey('sk-first');
    storage.setOpenAiApiKey('sk-second');

    assert.strictEqual(storage.getOpenAiApiKey(), 'sk-second');
});

test('getConfig exposes the three OpenAI model defaults', () => {
    const config = storage.getConfig();

    for (const key of ['openaiModel', 'openaiImageModel', 'openaiTranscribeModel']) {
        assert.strictEqual(typeof config[key], 'string', `${key} should default to a string`);
        assert.ok(config[key].length > 0, `${key} should default to a non-empty model id`);
    }
});

test('the OpenAI model defaults are the values the plan specifies', () => {
    const config = storage.getConfig();

    assert.strictEqual(config.openaiModel, 'gpt-4o-mini');
    assert.strictEqual(config.openaiImageModel, 'gpt-4o-mini');
    assert.strictEqual(config.openaiTranscribeModel, 'whisper-1');
});

test('getConfig exposes live-transcript defaults', () => {
    const config = storage.getConfig();

    assert.strictEqual(config.transcribeModel, 'gpt-live-transcribe');
    assert.strictEqual(config.transcribeLanguage, 'ja', 'meetings are Japanese; auto-detect flips on short utterances');
    assert.strictEqual(typeof config.transcribeTranslateTo, 'string');
});

test('transcript language and translation target are overridable', () => {
    storage.updateConfig('transcribeLanguage', 'en');
    storage.updateConfig('transcribeTranslateTo', '');

    assert.strictEqual(storage.getConfig().transcribeLanguage, 'en');
    assert.strictEqual(storage.getConfig().transcribeTranslateTo, '', 'empty target disables translation');
    assert.strictEqual(storage.getConfig().transcribeModel, 'gpt-live-transcribe', 'unrelated keys untouched');
});

test('OpenAI model settings survive updateConfig', () => {
    storage.updateConfig('openaiModel', 'gpt-4o');

    assert.strictEqual(storage.getConfig().openaiModel, 'gpt-4o');
    // Overriding one model must not disturb the others.
    assert.strictEqual(storage.getConfig().openaiTranscribeModel, 'whisper-1');
});
