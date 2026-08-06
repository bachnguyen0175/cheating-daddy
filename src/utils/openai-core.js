// Pure helpers for the OpenAI provider: audio conditioning, VAD, stream parsing
// and request-body construction.
//
// This module must stay free of electron, storage, fs and network imports so it
// can be unit-tested without an Electron runtime. All session state is threaded
// through by the caller (see openai.js) rather than held here.

const WAV_SAMPLE_RATE = 16000;
const WAV_CHANNELS = 1;
const WAV_BITS_PER_SAMPLE = 16;

const INT16_MIN = -32768;
const INT16_MAX = 32767;
const INT16_SCALE = 32768;

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.7;

// Tuning presets carried over from the local provider (localai.js:32).
const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 },
};

// Linear-interpolating 3:2 decimation. Audio arrives in arbitrary chunk sizes,
// so any input tail that does not complete an output sample is returned as
// `remainder` for the caller to prepend to the next chunk.
function resample24kTo16k(inputBuffer, remainder = Buffer.alloc(0)) {
    const combined = Buffer.concat([remainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = (i * 3) / 2;
        const sourceIndex = Math.floor(sourcePosition);
        const fraction = sourcePosition - sourceIndex;
        const firstSample = combined.readInt16LE(sourceIndex * 2);
        const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
        const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
        outputBuffer.writeInt16LE(Math.max(INT16_MIN, Math.min(INT16_MAX, interpolated)), i * 2);
    }

    const consumedBytes = Math.ceil((outputSamples * 3) / 2) * 2;

    return {
        out: outputBuffer,
        remainder: consumedBytes < combined.length ? combined.subarray(consumedBytes) : Buffer.alloc(0),
    };
}

function calculateRms(pcm16Buffer) {
    const samples = Math.floor(pcm16Buffer.length / 2);
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / INT16_SCALE;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function createVadState() {
    return { isSpeaking: false, speechFrameCount: 0, silenceFrameCount: 0 };
}

// Advances the energy-gate state machine by one frame. Returns the next state
// plus a boundary event ('speech-start' | 'speech-end' | null). Deliberately
// emits no status text -- that belongs to the adapter.
function vadStep(state, rms, cfg) {
    if (rms > cfg.energyThreshold) {
        const speechFrameCount = state.speechFrameCount + 1;
        const next = { isSpeaking: state.isSpeaking, speechFrameCount, silenceFrameCount: 0 };

        if (!state.isSpeaking && speechFrameCount >= cfg.speechFramesRequired) {
            return { state: { ...next, isSpeaking: true }, event: 'speech-start' };
        }
        return { state: next, event: null };
    }

    const silenceFrameCount = state.silenceFrameCount + 1;
    const next = { isSpeaking: state.isSpeaking, speechFrameCount: 0, silenceFrameCount };

    if (state.isSpeaking && silenceFrameCount >= cfg.silenceFramesRequired) {
        return { state: { ...next, isSpeaking: false }, event: 'speech-end' };
    }
    return { state: next, event: null };
}

function createWavBuffer(pcm16Buffer) {
    const header = Buffer.alloc(44);
    const blockAlign = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8;
    const byteRate = WAV_SAMPLE_RATE * blockAlign;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(WAV_CHANNELS, 22);
    header.writeUInt32LE(WAV_SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(WAV_BITS_PER_SAMPLE, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

// Extracts content tokens from a slice of an SSE stream. A frame may straddle a
// chunk boundary, so the unterminated tail is handed back as `pending` for the
// caller to feed into the next call.
function parseSseChunk(text, pending = '') {
    const lines = (pending + text).split('\n');
    const nextPending = lines.pop() || '';
    const tokens = [];

    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        let event;
        try {
            event = JSON.parse(data);
        } catch {
            // A corrupt frame must not tear down an in-flight response.
            continue;
        }

        const token = event.choices?.[0]?.delta?.content || '';
        if (token) tokens.push(token);
    }

    return { tokens, pending: nextPending };
}

function buildChatBody(model, messages, options = {}) {
    return {
        model,
        messages,
        stream: true,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    };
}

function buildTranscribeForm(wavBuffer, model, options = {}) {
    const form = new FormData();

    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (options.language) {
        form.append('language', options.language);
    }

    return form;
}

// Turns a failed HTTP response into something worth showing in the status bar.
function describeApiError(status, body) {
    if (status === 401 || status === 403) {
        return 'Invalid OpenAI API key';
    }
    if (status === 429) {
        return 'OpenAI rate limit or quota exceeded';
    }

    let reason = '';
    try {
        reason = JSON.parse(body)?.error?.message || '';
    } catch {
        // Non-JSON error bodies (proxies, gateways) are expected; fall through.
    }

    return reason ? `OpenAI error ${status}: ${reason}` : `OpenAI error ${status}`;
}

function trimHistory(history, max) {
    return history.length > max ? history.slice(-max) : history;
}

module.exports = {
    VAD_MODES,
    resample24kTo16k,
    calculateRms,
    createVadState,
    vadStep,
    createWavBuffer,
    parseSseChunk,
    buildChatBody,
    buildTranscribeForm,
    describeApiError,
    trimHistory,
};
