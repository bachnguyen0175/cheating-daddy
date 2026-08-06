const test = require('node:test');
const assert = require('node:assert');

const core = require('../src/utils/openai-realtime-core');

// ───────────────────────────── session configuration ─────────────────────────────

test('session update declares a transcription session', () => {
    const payload = core.buildTranscriptionSessionUpdate({ model: 'gpt-live-transcribe', language: 'ja' });

    assert.strictEqual(payload.type, 'session.update');
    assert.strictEqual(payload.session.type, 'transcription');
});

test('session update pins the audio format the app actually captures', () => {
    // renderer.js captures PCM16 mono at 24000. Realtime accepts exactly that, which
    // is why this path does no resampling. If either side drifts, audio turns to noise.
    const payload = core.buildTranscriptionSessionUpdate({ model: 'gpt-live-transcribe', language: 'ja' });
    const format = payload.session.audio.input.format;

    assert.strictEqual(format.type, 'audio/pcm');
    assert.strictEqual(format.rate, 24000);
});

test('session update carries the model and language from config, not hardcoded', () => {
    const ja = core.buildTranscriptionSessionUpdate({ model: 'gpt-live-transcribe', language: 'ja' });
    assert.strictEqual(ja.session.audio.input.transcription.model, 'gpt-live-transcribe');
    assert.strictEqual(ja.session.audio.input.transcription.language, 'ja');

    const other = core.buildTranscriptionSessionUpdate({ model: 'gpt-transcribe', language: 'en' });
    assert.strictEqual(other.session.audio.input.transcription.model, 'gpt-transcribe');
    assert.strictEqual(other.session.audio.input.transcription.language, 'en');
});

test('session update disables turn detection', () => {
    // The live API rejects server_vad for this model:
    //   "Turn detection is not supported for this transcription model."
    // Turns are committed by the client instead.
    const payload = core.buildTranscriptionSessionUpdate({ model: 'gpt-live-transcribe', language: 'ja' });
    assert.strictEqual(payload.session.audio.input.turn_detection, null);
});

test('audio commit closes the current turn', () => {
    assert.deepStrictEqual(core.buildAudioCommit(), { type: 'input_audio_buffer.commit' });
});

// ──────────────────────────────── audio framing ────────────────────────────────

test('audio append base64-encodes the pcm payload losslessly', () => {
    const pcm = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x00]);
    const msg = core.buildAudioAppend(pcm);

    assert.strictEqual(msg.type, 'input_audio_buffer.append');
    assert.deepStrictEqual(Buffer.from(msg.audio, 'base64'), pcm, 'round-trip must preserve every byte');
});

test('audio append rejects payloads over the documented 15 MB cap', () => {
    const tooBig = Buffer.alloc(core.MAX_AUDIO_APPEND_BYTES + 1);
    assert.throws(() => core.buildAudioAppend(tooBig), /15|size|large/i);
});

// ────────────────────────────── turn length limiting ──────────────────────────────

// Real speech runs for tens of seconds without a full second of silence, so
// waiting for a pause can leave a line uncommitted for ~30s. A hard ceiling on
// turn length bounds how long text can be withheld.
const MAX_TURN_MS = 4000;

test('turn timer starts when speech starts', () => {
    let timer = core.createTurnTimer();
    const step = core.turnTimerStep(timer, true, 1000, MAX_TURN_MS);

    assert.strictEqual(step.forceCommit, false);
    assert.strictEqual(step.state.startedAt, 1000);
});

test('turn timer does not force a commit before the ceiling', () => {
    let timer = core.createTurnTimer();
    timer = core.turnTimerStep(timer, true, 0, MAX_TURN_MS).state;

    const step = core.turnTimerStep(timer, true, MAX_TURN_MS - 1, MAX_TURN_MS);
    assert.strictEqual(step.forceCommit, false);
});

test('turn timer forces a commit once the ceiling is reached', () => {
    let timer = core.createTurnTimer();
    timer = core.turnTimerStep(timer, true, 0, MAX_TURN_MS).state;

    const step = core.turnTimerStep(timer, true, MAX_TURN_MS, MAX_TURN_MS);
    assert.strictEqual(step.forceCommit, true);
});

test('turn timer restarts after forcing a commit, so long speech is chunked evenly', () => {
    let timer = core.createTurnTimer();
    timer = core.turnTimerStep(timer, true, 0, MAX_TURN_MS).state;

    const first = core.turnTimerStep(timer, true, MAX_TURN_MS, MAX_TURN_MS);
    assert.strictEqual(first.forceCommit, true);

    // Immediately after, it must not fire again until another full interval.
    const next = core.turnTimerStep(first.state, true, MAX_TURN_MS + 1, MAX_TURN_MS);
    assert.strictEqual(next.forceCommit, false);

    const later = core.turnTimerStep(next.state, true, MAX_TURN_MS * 2, MAX_TURN_MS);
    assert.strictEqual(later.forceCommit, true);
});

test('turn timer clears when speech stops', () => {
    let timer = core.createTurnTimer();
    timer = core.turnTimerStep(timer, true, 0, MAX_TURN_MS).state;

    const stopped = core.turnTimerStep(timer, false, 500, MAX_TURN_MS);
    assert.strictEqual(stopped.state.startedAt, null);
    assert.strictEqual(stopped.forceCommit, false);
});

test('turn timer never forces a commit while silent', () => {
    const timer = core.createTurnTimer();
    const step = core.turnTimerStep(timer, false, 999999, MAX_TURN_MS);
    assert.strictEqual(step.forceCommit, false);
});

// ─────────────────────────── transcript event handling ───────────────────────────

function delta(itemId, text) {
    return { type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta: text };
}

function completed(itemId, text) {
    return { type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text };
}

// Feed a list of events, collecting every effect emitted.
function run(events, state = core.createTranscriptState()) {
    const effects = [];
    for (const event of events) {
        const step = core.applyServerEvent(state, event);
        state = step.state;
        effects.push(...step.effects);
    }
    return { state, effects };
}

test('deltas accumulate in arrival order for one item', () => {
    const { effects } = run([delta('a', '今日'), delta('a', 'は'), delta('a', '会議')]);

    assert.deepStrictEqual(
        effects.map(e => e.text),
        ['今日', '今日は', '今日は会議']
    );
    assert.ok(effects.every(e => e.type === 'partial'));
});

test('interleaved items do not contaminate each other', () => {
    // Two utterances can be in flight at once; text must never bleed across them.
    const { effects } = run([delta('a', 'おはよう'), delta('b', 'こんにちは'), delta('a', 'ございます')]);

    const forA = effects.filter(e => e.itemId === 'a').map(e => e.text);
    const forB = effects.filter(e => e.itemId === 'b').map(e => e.text);

    assert.deepStrictEqual(forA, ['おはよう', 'おはようございます']);
    assert.deepStrictEqual(forB, ['こんにちは']);
});

test('completed emits exactly one final and releases the item', () => {
    const { state, effects } = run([delta('a', '部分'), completed('a', '完全な文です')]);

    const finals = effects.filter(e => e.type === 'final');
    assert.strictEqual(finals.length, 1);
    assert.strictEqual(finals[0].text, '完全な文です', 'the server transcript wins over accumulated deltas');
    assert.strictEqual(core.pendingItemCount(state), 0, 'item state must be released to avoid a leak');
});

test('completed with no preceding delta still emits a usable final', () => {
    // Short utterances can finalize before any delta arrives.
    const { effects } = run([completed('solo', 'はい')]);

    assert.deepStrictEqual(
        effects.filter(e => e.type === 'final').map(e => e.text),
        ['はい']
    );
});

test('a completed item that speaks again starts clean', () => {
    const { effects } = run([delta('a', '一回目'), completed('a', '一回目です'), delta('a', '二回目')]);

    assert.strictEqual(effects.at(-1).text, '二回目', 'stale text from the finalized turn must not persist');
});

test('unknown event types are ignored rather than thrown on', () => {
    let result;
    assert.doesNotThrow(() => {
        result = run([{ type: 'session.created' }, { type: 'input_audio_buffer.speech_started' }, { type: 'some.future.event' }]);
    });
    assert.deepStrictEqual(result.effects, []);
});

test('error events surface a readable message', () => {
    const { effects } = run([{ type: 'error', error: { message: 'Invalid session configuration' } }]);

    assert.strictEqual(effects.length, 1);
    assert.strictEqual(effects[0].type, 'error');
    assert.match(effects[0].message, /Invalid session configuration/);
});

test('an error with no message still produces something displayable', () => {
    const { effects } = run([{ type: 'error' }]);
    assert.strictEqual(effects[0].type, 'error');
    assert.ok(effects[0].message.length > 0);
});

test('empty deltas do not emit noise', () => {
    const { effects } = run([delta('a', '')]);
    assert.deepStrictEqual(effects, []);
});
