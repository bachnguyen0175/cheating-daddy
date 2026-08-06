const test = require('node:test');
const assert = require('node:assert');

const core = require('../src/utils/openai-core');

// Helper: build a PCM16LE buffer from an array of sample values.
function pcm(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
    return buf;
}

// Helper: read a PCM16LE buffer back into an array of sample values.
function samplesOf(buf) {
    const out = [];
    for (let i = 0; i < buf.length / 2; i++) out.push(buf.readInt16LE(i * 2));
    return out;
}

// ─────────────────────────────── resample 24k → 16k ───────────────────────────────

test('resample: 3 input samples collapse to 2 output samples', () => {
    // 24000 -> 16000 is a 2:3 ratio; this is the defining property of the function.
    const { out } = core.resample24kTo16k(pcm([100, 100, 100]), Buffer.alloc(0));
    assert.strictEqual(samplesOf(out).length, 2);
});

test('resample: a constant signal stays constant', () => {
    // Interpolating between equal values must reproduce that value, whatever
    // the interpolation weights are. Independent of implementation detail.
    const { out } = core.resample24kTo16k(pcm(new Array(12).fill(-4321)), Buffer.alloc(0));
    for (const s of samplesOf(out)) assert.strictEqual(s, -4321);
});

test('resample: a linear ramp is reproduced by linear interpolation', () => {
    // Input sample n has value 300n. Output i samples the input at position
    // 1.5i, so it must equal 300 * 1.5i = 450i. Derived from the maths, not
    // copied from a previous run.
    const { out } = core.resample24kTo16k(pcm([0, 300, 600, 900, 1200, 1500]), Buffer.alloc(0));
    assert.deepStrictEqual(samplesOf(out), [0, 450, 900, 1350]);
});

test('resample: leftover input is returned as remainder, not dropped', () => {
    // 4 input samples yield 2 output samples, which consume 3 inputs. The 4th
    // must survive for the next call.
    const { out, remainder } = core.resample24kTo16k(pcm([10, 20, 30, 40]), Buffer.alloc(0));
    assert.strictEqual(samplesOf(out).length, 2);
    assert.deepStrictEqual(samplesOf(remainder), [40]);
});

test('resample: splitting the input across calls yields identical output', () => {
    // The property that matters in production: audio arrives in arbitrary
    // chunks, and chunk boundaries must not alter the resampled stream.
    const ramp = Array.from({ length: 12 }, (_, i) => i * 100);

    const whole = core.resample24kTo16k(pcm(ramp), Buffer.alloc(0));

    const first = core.resample24kTo16k(pcm(ramp.slice(0, 4)), Buffer.alloc(0));
    const second = core.resample24kTo16k(pcm(ramp.slice(4)), first.remainder);

    assert.deepStrictEqual(samplesOf(Buffer.concat([first.out, second.out])), samplesOf(whole.out));
});

test('resample: empty input produces empty output and preserves remainder', () => {
    const carried = pcm([7]);
    const { out, remainder } = core.resample24kTo16k(Buffer.alloc(0), carried);
    assert.strictEqual(out.length, 0);
    assert.deepStrictEqual(samplesOf(remainder), [7]);
});

test('resample: output stays inside the int16 range', () => {
    const { out } = core.resample24kTo16k(pcm([32767, -32768, 32767, -32768, 32767, -32768]), Buffer.alloc(0));
    for (const s of samplesOf(out)) {
        assert.ok(s >= -32768 && s <= 32767, `sample ${s} escaped int16 range`);
    }
});

// ─────────────────────────────────────── RMS ───────────────────────────────────────

test('rms: silence is zero', () => {
    assert.strictEqual(core.calculateRms(pcm(new Array(8).fill(0))), 0);
});

test('rms: an empty buffer is zero, not NaN', () => {
    assert.strictEqual(core.calculateRms(Buffer.alloc(0)), 0);
});

test('rms: a constant signal equals its normalised magnitude', () => {
    // RMS of a constant v is |v|. Normalised by 32768, so 16384 -> 0.5 exactly.
    assert.strictEqual(core.calculateRms(pcm(new Array(10).fill(16384))), 0.5);
});

test('rms: a square wave equals its amplitude', () => {
    // Every sample has the same magnitude, so RMS must equal that magnitude
    // regardless of sign.
    assert.strictEqual(core.calculateRms(pcm([8192, -8192, 8192, -8192])), 0.25);
});

// ────────────────────────────────── VAD state machine ──────────────────────────────

const VAD = { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 4 };

// Drive the machine through a list of RMS values, collecting emitted events.
function runVad(rmsValues, cfg = VAD, state = core.createVadState()) {
    const events = [];
    for (const rms of rmsValues) {
        const step = core.vadStep(state, rms, cfg);
        state = step.state;
        if (step.event) events.push(step.event);
    }
    return { state, events };
}

test('vad: starts idle and emits nothing on silence', () => {
    const { events } = runVad([0, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(events, []);
});

test('vad: emits speech-start only after the required consecutive loud frames', () => {
    const loud = 0.5;
    const { events } = runVad([loud, loud]);
    assert.deepStrictEqual(events, [], 'two frames is below the threshold of three');

    const { events: three } = runVad([loud, loud, loud]);
    assert.deepStrictEqual(three, ['speech-start']);
});

test('vad: a silent frame resets the speech run', () => {
    // loud, loud, silent, loud, loud -> never three consecutive, so no start.
    const { events } = runVad([0.5, 0.5, 0, 0.5, 0.5]);
    assert.deepStrictEqual(events, []);
});

test('vad: emits speech-end after the required consecutive silent frames', () => {
    const { events } = runVad([0.5, 0.5, 0.5, 0, 0, 0, 0]);
    assert.deepStrictEqual(events, ['speech-start', 'speech-end']);
});

test('vad: never emits speech-end without a preceding speech-start', () => {
    const { events } = runVad(new Array(50).fill(0));
    assert.ok(!events.includes('speech-end'));
});

test('vad: a loud frame resets the silence run', () => {
    // start, then silence that is interrupted before reaching the limit.
    const { events } = runVad([0.5, 0.5, 0.5, 0, 0, 0.5, 0, 0, 0]);
    assert.deepStrictEqual(events, ['speech-start'], 'silence run was broken, so no end yet');
});

test('vad: thresholds come from the config, not from constants in the code', () => {
    const rms = 0.05;

    const sensitive = { energyThreshold: 0.01, speechFramesRequired: 1, silenceFramesRequired: 2 };
    assert.deepStrictEqual(runVad([rms], sensitive).events, ['speech-start']);

    // Same signal, higher threshold -> must be treated as silence.
    const deaf = { energyThreshold: 0.9, speechFramesRequired: 1, silenceFramesRequired: 2 };
    assert.deepStrictEqual(runVad([rms], deaf).events, []);
});

test('vad: exposes the tuning presets the local provider uses', () => {
    for (const name of ['NORMAL', 'LOW_BITRATE', 'AGGRESSIVE', 'VERY_AGGRESSIVE']) {
        const mode = core.VAD_MODES[name];
        assert.ok(mode, `missing preset ${name}`);
        assert.strictEqual(typeof mode.energyThreshold, 'number');
        assert.ok(mode.speechFramesRequired > 0);
        assert.ok(mode.silenceFramesRequired > 0);
    }
});

// ──────────────────────────────────── WAV header ───────────────────────────────────

test('wav: header decodes back to a valid 16 kHz mono PCM16 spec', () => {
    // Decode each field per the RIFF/WAVE spec and check it against a value
    // derived from the format, rather than diffing against a golden byte blob
    // (which would pass just as happily on a wrong-but-stable implementation).
    const payload = pcm([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = core.createWavBuffer(payload);

    const CHANNELS = 1;
    const SAMPLE_RATE = 16000;
    const BITS = 16;

    assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(wav.readUInt32LE(4), 36 + payload.length, 'RIFF chunk size');
    assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');

    assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
    assert.strictEqual(wav.readUInt32LE(16), 16, 'PCM fmt chunk is 16 bytes');
    assert.strictEqual(wav.readUInt16LE(20), 1, 'audio format 1 = uncompressed PCM');
    assert.strictEqual(wav.readUInt16LE(22), CHANNELS);
    assert.strictEqual(wav.readUInt32LE(24), SAMPLE_RATE);
    assert.strictEqual(wav.readUInt32LE(28), (SAMPLE_RATE * CHANNELS * BITS) / 8, 'byte rate');
    assert.strictEqual(wav.readUInt16LE(32), (CHANNELS * BITS) / 8, 'block align');
    assert.strictEqual(wav.readUInt16LE(34), BITS);

    assert.strictEqual(wav.toString('ascii', 36, 40), 'data');
    assert.strictEqual(wav.readUInt32LE(40), payload.length, 'data chunk size');
});

test('wav: audio payload is preserved byte-for-byte after the 44-byte header', () => {
    const payload = pcm([-32768, 0, 32767, 1234]);
    const wav = core.createWavBuffer(payload);

    assert.strictEqual(wav.length, 44 + payload.length);
    assert.deepStrictEqual(wav.subarray(44), payload);
});

test('wav: an empty payload still produces a structurally valid header', () => {
    const wav = core.createWavBuffer(Buffer.alloc(0));
    assert.strictEqual(wav.length, 44);
    assert.strictEqual(wav.readUInt32LE(40), 0);
    assert.strictEqual(wav.readUInt32LE(4), 36);
});

// ────────────────────────────────── SSE stream parsing ─────────────────────────────

function sse(content) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

test('sse: extracts content tokens from complete lines', () => {
    const { tokens } = core.parseSseChunk(sse('Hello') + sse(' world'), '');
    assert.deepStrictEqual(tokens, ['Hello', ' world']);
});

test('sse: a line split across chunk boundaries yields exactly one token', () => {
    // The defect this guards: naive per-chunk parsing drops or duplicates the
    // token straddling the boundary.
    const line = sse('Boundary');
    const cut = Math.floor(line.length / 2);

    const first = core.parseSseChunk(line.slice(0, cut), '');
    assert.deepStrictEqual(first.tokens, [], 'incomplete line must not emit yet');

    const second = core.parseSseChunk(line.slice(cut), first.pending);
    assert.deepStrictEqual(second.tokens, ['Boundary']);
});

test('sse: a token split into many tiny chunks is reassembled once', () => {
    const line = sse('reassembled');
    let pending = '';
    const tokens = [];
    for (const ch of line) {
        const step = core.parseSseChunk(ch, pending);
        pending = step.pending;
        tokens.push(...step.tokens);
    }
    assert.deepStrictEqual(tokens, ['reassembled']);
});

test('sse: the [DONE] sentinel produces no token', () => {
    const { tokens } = core.parseSseChunk('data: [DONE]\n', '');
    assert.deepStrictEqual(tokens, []);
});

test('sse: malformed JSON is skipped without throwing', () => {
    // A truncated or corrupt frame must not tear down an in-flight response.
    let result;
    assert.doesNotThrow(() => {
        result = core.parseSseChunk('data: {not valid json}\n' + sse('survived'), '');
    });
    assert.deepStrictEqual(result.tokens, ['survived']);
});

test('sse: non-data lines and blank keepalives are ignored', () => {
    const { tokens } = core.parseSseChunk(': keepalive\n\nevent: ping\n' + sse('only'), '');
    assert.deepStrictEqual(tokens, ['only']);
});

test('sse: frames carrying no content contribute nothing', () => {
    const roleOnly = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n`;
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n`;
    const { tokens } = core.parseSseChunk(roleOnly + finish, '');
    assert.deepStrictEqual(tokens, []);
});

// ───────────────────────────────── request bodies ─────────────────────────────────

test('chat body: carries model, messages and streaming flag', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const body = core.buildChatBody('gpt-4o-mini', messages);

    assert.strictEqual(body.model, 'gpt-4o-mini');
    assert.deepStrictEqual(body.messages, messages);
    assert.strictEqual(body.stream, true);
});

test('chat body: omits Groq-only parameters that OpenAI rejects', () => {
    // gemini.js:253 emits reasoning_format / include_reasoning for Groq. OpenAI
    // returns 400 on unknown body params, so they must never appear here.
    const body = core.buildChatBody('gpt-4o-mini', []);
    assert.strictEqual(body.reasoning_format, undefined);
    assert.strictEqual(body.include_reasoning, undefined);
    assert.strictEqual(body.reasoning_effort, undefined);
    assert.strictEqual(body.chat_template_kwargs, undefined);
});

test('chat body: caller can override generation options', () => {
    const body = core.buildChatBody('gpt-4o', [], { maxTokens: 64, temperature: 0 });
    assert.strictEqual(body.max_tokens, 64);
    assert.strictEqual(body.temperature, 0);
});

test('transcribe form: sets the model and a json response format', () => {
    const wav = core.createWavBuffer(pcm([1, 2, 3, 4]));
    const form = core.buildTranscribeForm(wav, 'whisper-1');

    assert.strictEqual(form.get('model'), 'whisper-1');
    assert.strictEqual(form.get('response_format'), 'json');
    assert.ok(form.get('file'), 'audio file part must be present');
    assert.strictEqual(form.get('file').size, wav.length, 'uploaded bytes must match the wav');
});

// ─────────────────────────────── API error messages ───────────────────────────────

test('error message: an invalid key is named as such', () => {
    const message = core.describeApiError(401, '{"error":{"message":"Incorrect API key provided"}}');
    assert.match(message, /key/i);
});

test('error message: quota and rate limits are distinguished from auth failures', () => {
    const rateLimited = core.describeApiError(429, '');
    assert.match(rateLimited, /rate limit|quota/i);
    assert.doesNotMatch(rateLimited, /invalid.*key/i);
});

test('error message: an unrecognised status surfaces the API-supplied reason', () => {
    const message = core.describeApiError(400, '{"error":{"message":"Unsupported parameter: reasoning_format"}}');
    assert.match(message, /Unsupported parameter: reasoning_format/);
});

test('error message: a non-JSON body does not throw and still reports the status', () => {
    let message;
    assert.doesNotThrow(() => {
        message = core.describeApiError(503, '<html>Service Unavailable</html>');
    });
    assert.match(message, /503/);
});

// ──────────────────────────────── conversation history ────────────────────────────

test('history: is capped to the most recent turns', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const trimmed = core.trimHistory(history, 20);

    assert.strictEqual(trimmed.length, 20);
    assert.strictEqual(trimmed.at(-1).content, 'm29', 'newest turn must survive');
    assert.strictEqual(trimmed[0].content, 'm10', 'oldest turns are dropped first');
});

test('history: shorter than the cap is returned unchanged', () => {
    const history = [{ role: 'user', content: 'only' }];
    assert.deepStrictEqual(core.trimHistory(history, 20), history);
});
