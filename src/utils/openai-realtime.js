const WebSocket = require('ws');
const { BrowserWindow } = require('electron');
const core = require('./openai-realtime-core');
const audio = require('./openai-core');
const { getOpenAiApiKey, getConfig } = require('../storage');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

// This model rejects server-side turn detection, so the client segments speech and
// commits each turn. Gating on the same VAD means silence is never uploaded, which
// is also what keeps the per-minute cost down.
// 6 frames = ~0.6s of silence ends a turn. Short enough to catch natural
// sentence pauses in conversational Japanese.
const VAD_CONFIG = { energyThreshold: 0.01, speechFramesRequired: 2, silenceFramesRequired: 6 };

// Hard ceiling on a turn. Continuous speech can run 30s without a full pause,
// which would withhold the transcript for that whole stretch.
const MAX_TURN_MS = 4000;

// Chunks kept from just before speech is detected, so quiet sentence openings
// aren't clipped off the front of a turn.
const PRE_ROLL_CHUNKS = 3;

let ws = null;
let isConnected = false;
let isUserClosing = false;
let reconnectAttempts = 0;
let transcriptState = core.createTranscriptState();
let sessionConfig = null;

let vadState = audio.createVadState();
let turnTimer = core.createTurnTimer();
let preRoll = [];
let hasUncommittedAudio = false;

// Diagnostics: without these there is no way to tell "no audio is reaching the
// app" from "audio is reaching it but the API returned nothing".
const AUDIO_LOG_INTERVAL_MS = 3000;
let chunksReceived = 0;
let chunksSent = 0;
let turnsCommitted = 0;
let peakRms = 0;
let lastAudioLog = 0;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

function connect() {
    return new Promise((resolve, reject) => {
        const apiKey = getOpenAiApiKey();
        if (!apiKey || apiKey.trim() === '') {
            reject(new Error('No OpenAI API key configured'));
            return;
        }

        console.log('[Transcribe] Connecting to', REALTIME_URL);
        ws = new WebSocket(REALTIME_URL, {
            headers: { Authorization: `Bearer ${apiKey.trim()}` },
        });

        const timeout = setTimeout(() => {
            if (!isConnected) {
                try {
                    ws.close();
                } catch (e) {}
                reject(new Error('Realtime connection timeout'));
            }
        }, CONNECT_TIMEOUT_MS);

        ws.on('open', () => {
            console.log('[Transcribe] WebSocket open');
            isConnected = true;
            reconnectAttempts = 0;
            clearTimeout(timeout);
            ws.send(JSON.stringify(core.buildTranscriptionSessionUpdate(sessionConfig)));
            sendToRenderer('update-status', 'Live transcript connected');
            resolve(true);
        });

        ws.on('message', data => {
            let event;
            try {
                event = JSON.parse(data.toString());
            } catch (e) {
                console.error('[Transcribe] Parse error:', e.message);
                return;
            }
            handleServerEvent(event);
        });

        ws.on('close', (code, reason) => {
            console.log('[Transcribe] WebSocket closed:', code, reason?.toString());
            isConnected = false;
            clearTimeout(timeout);
            if (!isUserClosing) {
                attemptReconnect();
            }
        });

        ws.on('error', err => {
            console.error('[Transcribe] WebSocket error:', err.message);
            isConnected = false;
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function handleServerEvent(event) {
    if (event?.type && !event.type.endsWith('.delta')) {
        console.log('[Transcribe] <<', event.type);
    }

    const step = core.applyServerEvent(transcriptState, event);
    transcriptState = step.state;

    for (const effect of step.effects) {
        if (effect.type === 'partial') {
            sendToRenderer('transcript-partial', { itemId: effect.itemId, text: effect.text });
        } else if (effect.type === 'final') {
            sendToRenderer('transcript-final', {
                itemId: effect.itemId,
                text: effect.text,
                timestamp: Date.now(),
            });
            translateUtterance(effect.itemId, effect.text);
        } else if (effect.type === 'error') {
            console.error('[Transcribe] Server error:', effect.message);
            sendToRenderer('update-status', effect.message);
        }
    }
}

// Translation runs only on finalized utterances -- translating partials would
// flicker unreadably and multiply cost. Failure is non-fatal: the Japanese line
// stays on screen either way.
async function translateUtterance(itemId, text) {
    if (!sessionConfig?.translateTo || !text.trim()) return;

    try {
        const { getTranslation } = require('./openai');
        const translated = await getTranslation(text, sessionConfig.translateTo);
        // Always emit, even when empty -- otherwise the line is stuck showing
        // "translating..." forever, which is what made translations look missing.
        sendToRenderer('transcript-translation', { itemId, text: translated || null });
    } catch (error) {
        console.error('[Transcribe] Translation failed:', error.message);
        sendToRenderer('transcript-translation', { itemId, text: null, error: error.message });
    }
}

async function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        sendToRenderer('update-status', 'Live transcript disconnected');
        return;
    }

    reconnectAttempts += 1;
    console.log(`[Transcribe] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
    sendToRenderer('update-status', `Reconnecting transcript (${reconnectAttempts})...`);

    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
    if (isUserClosing) return;

    try {
        await connect();
    } catch (error) {
        console.error('[Transcribe] Reconnect failed:', error.message);
    }
}

async function initializeTranscribeSession() {
    console.log('[Transcribe] Initializing session');
    sendToRenderer('session-initializing', true);

    try {
        closeTranscribeSession();
        isUserClosing = false;

        const config = getConfig();
        sessionConfig = {
            model: config.transcribeModel,
            language: config.transcribeLanguage,
            translateTo: config.transcribeTranslateTo || null,
        };
        transcriptState = core.createTranscriptState();
        resetAudioState();

        await connect();

        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Listening...');
        return true;
    } catch (error) {
        console.error('[Transcribe] Initialization error:', error.message);
        closeTranscribeSession();
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Transcript error: ' + error.message);
        return false;
    }
}

// Periodic heartbeat so a silent screen can be diagnosed from the terminal.
function logAudioStats() {
    const now = Date.now();
    if (now - lastAudioLog < AUDIO_LOG_INTERVAL_MS) return;
    lastAudioLog = now;

    console.log(
        `[Transcribe] audio in=${chunksReceived} sent=${chunksSent} turns=${turnsCommitted} ` +
            `peakRms=${peakRms.toFixed(4)} threshold=${VAD_CONFIG.energyThreshold} speaking=${vadState.isSpeaking}` +
            (peakRms === 0 ? '  <- SILENT: no audio is reaching the app' : '')
    );
    peakRms = 0;
}

function resetAudioState() {
    vadState = audio.createVadState();
    turnTimer = core.createTurnTimer();
    preRoll = [];
    hasUncommittedAudio = false;
    chunksReceived = 0;
    chunksSent = 0;
    turnsCommitted = 0;
    peakRms = 0;
    lastAudioLog = 0;
}

function sendChunk(chunk) {
    try {
        ws.send(JSON.stringify(core.buildAudioAppend(chunk)));
        hasUncommittedAudio = true;
        chunksSent += 1;
    } catch (error) {
        console.error('[Transcribe] Failed to send audio:', error.message);
    }
}

function commitTurn() {
    if (!hasUncommittedAudio) return;

    try {
        ws.send(JSON.stringify(core.buildAudioCommit()));
        hasUncommittedAudio = false;
        turnsCommitted += 1;
        console.log(`[Transcribe] turn committed (#${turnsCommitted})`);
    } catch (error) {
        console.error('[Transcribe] Failed to commit turn:', error.message);
    }
}

function processTranscribeAudio(pcm24kBuffer) {
    if (!isConnected || !ws) return;

    const rms = audio.calculateRms(pcm24kBuffer);
    chunksReceived += 1;
    peakRms = Math.max(peakRms, rms);
    logAudioStats();

    const step = audio.vadStep(vadState, rms, VAD_CONFIG);
    vadState = step.state;

    if (step.event === 'speech-start') {
        for (const chunk of preRoll) sendChunk(chunk);
        preRoll = [];
    }

    if (vadState.isSpeaking) {
        sendChunk(pcm24kBuffer);

        // Long unbroken speech still needs to surface text periodically.
        const timed = core.turnTimerStep(turnTimer, true, Date.now(), MAX_TURN_MS);
        turnTimer = timed.state;
        if (timed.forceCommit) {
            commitTurn();
        }
        return;
    }

    turnTimer = core.turnTimerStep(turnTimer, false, Date.now(), MAX_TURN_MS).state;

    if (step.event === 'speech-end') {
        // Trailing chunk carries the tail of the utterance; send before closing.
        sendChunk(pcm24kBuffer);
        commitTurn();
        return;
    }

    preRoll.push(Buffer.from(pcm24kBuffer));
    if (preRoll.length > PRE_ROLL_CHUNKS) preRoll.shift();
}

function closeTranscribeSession() {
    isUserClosing = true;
    isConnected = false;
    reconnectAttempts = 0;
    transcriptState = core.createTranscriptState();
    resetAudioState();

    if (ws) {
        try {
            ws.close();
        } catch (e) {}
        ws = null;
    }
}

function isTranscribeSessionActive() {
    return isConnected;
}

module.exports = {
    initializeTranscribeSession,
    processTranscribeAudio,
    closeTranscribeSession,
    isTranscribeSessionActive,
};
