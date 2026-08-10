const test = require('node:test');
const assert = require('node:assert');

const { installModuleStubs, restoreModuleStubs } = require('./helpers/module-stubs');

// localai.js requires ./gemini, which pulls in `electron` and `@google/genai`
// at module scope. See helpers/module-stubs.js.
installModuleStubs();
const localai = require('../src/utils/localai');

test.after(() => restoreModuleStubs());

// resample24kTo16k carries a remainder buffer in module scope so that chunk
// boundaries do not drop samples. closeLocalSession() is the production reset
// for that state, so each test starts from a known point.
test.beforeEach(() => localai.closeLocalSession());

// Helper: build a PCM16LE buffer from an array of sample values.
function pcm(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
    return buf;
}

function samplesOf(buffer) {
    const out = [];
    for (let i = 0; i < buffer.length / 2; i++) out.push(buffer.readInt16LE(i * 2));
    return out;
}

// ---------------------------------------------------------------- resample24kTo16k

test('resample24kTo16k decimates 3 input samples to 2 output samples', () => {
    // 24 kHz -> 16 kHz is a 2:3 ratio: every 3 input samples yield 2 output samples.
    assert.strictEqual(samplesOf(localai.resample24kTo16k(pcm([100, 200, 300]))).length, 2);
});

test('resample24kTo16k leaves a constant signal unchanged', () => {
    // Interpolating between equal neighbours must return that same value --
    // any scaling or rounding bug shows up immediately here.
    const out = samplesOf(localai.resample24kTo16k(pcm(new Array(30).fill(1234))));

    assert.ok(out.length > 0, 'expected output samples');
    out.forEach(s => assert.strictEqual(s, 1234));
});

test('resample24kTo16k returns an empty buffer for empty input', () => {
    assert.strictEqual(localai.resample24kTo16k(Buffer.alloc(0)).length, 0);
});

test('resample24kTo16k carries leftover samples across chunk boundaries', () => {
    // Feeding one 30-sample chunk must produce the same audio as feeding it as
    // three 10-sample chunks; otherwise every capture-buffer boundary shifts the
    // resampling grid. Regression: the resampler used to keep a byte remainder
    // but no fractional phase, so a chunk ending mid-sample lost that half-sample
    // and the next chunk restarted its grid at position 0.
    const ramp = Array.from({ length: 30 }, (_, i) => i * 100);

    const wholeInOne = samplesOf(localai.resample24kTo16k(pcm(ramp)));

    localai.closeLocalSession();
    const inChunks = [
        ...samplesOf(localai.resample24kTo16k(pcm(ramp.slice(0, 10)))),
        ...samplesOf(localai.resample24kTo16k(pcm(ramp.slice(10, 20)))),
        ...samplesOf(localai.resample24kTo16k(pcm(ramp.slice(20, 30)))),
    ];

    assert.deepStrictEqual(inChunks, wholeInOne);
});

test('resample24kTo16k is invariant to chunk size', () => {
    // The capture pipeline does not guarantee a chunk length, so the output must
    // not depend on how the same audio happens to be split. Odd sizes are the
    // interesting case: they are what leave a half-sample phase behind.
    const tone = Array.from({ length: 120 }, (_, i) => Math.round(12000 * Math.sin(i / 4)));

    const reference = samplesOf(localai.resample24kTo16k(pcm(tone)));

    for (const size of [1, 2, 3, 5, 7, 16, 119]) {
        localai.closeLocalSession();

        const chunked = [];
        for (let i = 0; i < tone.length; i += size) {
            chunked.push(...samplesOf(localai.resample24kTo16k(pcm(tone.slice(i, i + size)))));
        }

        assert.deepStrictEqual(chunked, reference, `chunk size ${size} produced different audio`);
    }
});

test('resample24kTo16k clamps interpolated values to the PCM16 range', () => {
    const out = samplesOf(localai.resample24kTo16k(pcm([32767, 32767, 32767, -32768, -32768, -32768])));

    out.forEach(s => {
        assert.ok(s >= -32768 && s <= 32767, `sample ${s} escaped the PCM16 range`);
    });
});

test('closeLocalSession clears the resampler remainder', () => {
    // A stale remainder would prepend the previous session's audio to the next
    // one, so the reset has to be real rather than incidental.
    localai.resample24kTo16k(pcm([1, 2, 3, 4, 5]));
    localai.closeLocalSession();

    const afterReset = samplesOf(localai.resample24kTo16k(pcm([0, 0, 0])));
    assert.deepStrictEqual(afterReset, [0, 0], 'leftover samples from before the reset leaked in');
});

// ---------------------------------------------------------------- calculateRms

test('calculateRms returns 0 for an empty buffer', () => {
    // Guards the samples === 0 branch: without it this divides by zero.
    assert.strictEqual(localai.calculateRms(Buffer.alloc(0)), 0);
});

test('calculateRms returns 0 for digital silence', () => {
    assert.strictEqual(localai.calculateRms(pcm([0, 0, 0, 0])), 0);
});

test('calculateRms approaches 1 for a full-scale signal', () => {
    const rms = localai.calculateRms(pcm([32767, -32767, 32767, -32767]));

    assert.ok(rms > 0.99 && rms <= 1, `expected near-full-scale RMS, got ${rms}`);
});

test('calculateRms returns the true root-mean-square, not the mean square', () => {
    // A square wave at exactly half scale has RMS 0.5. Dropping the sqrt would
    // yield 0.25 here while still looking plausible at full scale (0.9999), so
    // pin the exact value rather than a range.
    const rms = localai.calculateRms(pcm([16384, -16384, 16384, -16384]));

    assert.ok(Math.abs(rms - 0.5) < 1e-9, `expected RMS 0.5 for a half-scale square wave, got ${rms}`);
});

test('calculateRms scales with amplitude around the VAD threshold', () => {
    const quiet = localai.calculateRms(pcm([328, -328, 328, -328])); // ~1% of full scale
    const loud = localai.calculateRms(pcm([16384, -16384, 16384, -16384])); // 50%

    assert.ok(quiet < loud, 'a louder signal must produce a larger RMS');
    // VERY_AGGRESSIVE, the default mode, gates speech at 0.02.
    assert.ok(quiet < 0.02, `quiet signal should fall under the VAD threshold, got ${quiet}`);
    assert.ok(loud > 0.02, `loud signal should clear the VAD threshold, got ${loud}`);
});

// ---------------------------------------------------------------- session state

test('isLocalSessionActive is false before a session is initialized', () => {
    assert.strictEqual(localai.isLocalSessionActive(), false);
});

test('processLocalAudio is a no-op while no session is active', () => {
    // Audio chunks keep arriving from the capture pipeline after a session is
    // torn down; that must not throw or resurrect VAD state.
    assert.doesNotThrow(() => localai.processLocalAudio(pcm([100, 200, 300])));
    assert.strictEqual(localai.isLocalSessionActive(), false);
});

test('closeLocalSession is safe to call repeatedly with no session running', () => {
    assert.doesNotThrow(() => {
        localai.closeLocalSession();
        localai.closeLocalSession();
    });
});
