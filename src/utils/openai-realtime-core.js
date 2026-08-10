// Pure helpers for the OpenAI Realtime transcription session: outgoing message
// construction and incoming server-event reduction.
//
// Like openai-core.js, this must stay free of electron, ws, storage and fs so it
// can be unit-tested without an Electron runtime. All connection state lives in
// openai-realtime.js.

// The capture pipeline produces PCM16 mono at 24 kHz (renderer.js SAMPLE_RATE),
// which is exactly Realtime's native input format -- hence no resampling here.
const AUDIO_SAMPLE_RATE = 24000;

// Realtime rejects client messages larger than 15 MB.
const MAX_AUDIO_APPEND_BYTES = 15 * 1024 * 1024;

const DELTA_EVENT = 'conversation.item.input_audio_transcription.delta';
const COMPLETED_EVENT = 'conversation.item.input_audio_transcription.completed';

function buildTranscriptionSessionUpdate({ model, language }) {
    return {
        type: 'session.update',
        session: {
            type: 'transcription',
            audio: {
                input: {
                    format: { type: 'audio/pcm', rate: AUDIO_SAMPLE_RATE },
                    transcription: { model, language },
                    // The API rejects server_vad here ("Turn detection is not supported
                    // for this transcription model"), so the client segments turns and
                    // commits them explicitly.
                    turn_detection: null,
                },
            },
        },
    };
}

function buildAudioCommit() {
    return { type: 'input_audio_buffer.commit' };
}

function buildAudioAppend(pcmBuffer) {
    if (pcmBuffer.length > MAX_AUDIO_APPEND_BYTES) {
        throw new Error(`Audio chunk of ${pcmBuffer.length} bytes exceeds the 15 MB per-message limit`);
    }

    return {
        type: 'input_audio_buffer.append',
        audio: pcmBuffer.toString('base64'),
    };
}

function createTurnTimer() {
    return { startedAt: null };
}

// Bounds how long a turn may run before being committed. Continuous speech can
// go 30s without a full second of silence, which would withhold the transcript
// for that entire stretch.
function turnTimerStep(state, isSpeaking, now, maxMs) {
    if (!isSpeaking) {
        return { state: { startedAt: null }, forceCommit: false };
    }

    if (state.startedAt === null) {
        return { state: { startedAt: now }, forceCommit: false };
    }

    if (now - state.startedAt >= maxMs) {
        return { state: { startedAt: now }, forceCommit: true };
    }

    return { state, forceCommit: false };
}

function createTranscriptState() {
    return { items: new Map() };
}

function pendingItemCount(state) {
    return state.items.size;
}

// Reduces one server event into the next state plus any effects the adapter
// should surface. Effects are plain data so the caller decides how to render.
function applyServerEvent(state, event) {
    const items = state.items;

    if (event?.type === DELTA_EVENT) {
        const text = event.delta ?? '';
        if (!text) return { state, effects: [] };

        const accumulated = (items.get(event.item_id) || '') + text;
        items.set(event.item_id, accumulated);

        return { state, effects: [{ type: 'partial', itemId: event.item_id, text: accumulated }] };
    }

    if (event?.type === COMPLETED_EVENT) {
        // The server's final transcript supersedes anything accumulated from
        // deltas, which may have been revised as more context arrived.
        const text = event.transcript || items.get(event.item_id) || '';
        items.delete(event.item_id);

        return { state, effects: [{ type: 'final', itemId: event.item_id, text }] };
    }

    if (event?.type === 'error') {
        return {
            state,
            effects: [{ type: 'error', message: event.error?.message || 'Realtime transcription error' }],
        };
    }

    return { state, effects: [] };
}

module.exports = {
    AUDIO_SAMPLE_RATE,
    MAX_AUDIO_APPEND_BYTES,
    buildTranscriptionSessionUpdate,
    buildAudioAppend,
    buildAudioCommit,
    createTurnTimer,
    turnTimerStep,
    createTranscriptState,
    pendingItemCount,
    applyServerEvent,
};
