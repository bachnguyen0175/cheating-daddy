const core = require('./openai-core');
const { getSystemPrompt } = require('./prompts');
const { getOpenAiApiKey, getConfig } = require('../storage');

// Lazy-loaded to avoid a circular dependency (gemini.js reaches this module
// through its own lazy accessor).
let _gemini = null;
function gemini() {
    if (!_gemini) _gemini = require('./gemini');
    return _gemini;
}

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const MAX_HISTORY_TURNS = 20;

// 0.5s of 16 kHz 16-bit mono. Shorter clips are almost always VAD noise.
const MIN_SPEECH_BYTES = 16000;

const vadConfig = core.VAD_MODES.VERY_AGGRESSIVE;

let isActive = false;
let apiKey = null;
let textModel = null;
let imageModel = null;
let transcribeModel = null;
let currentSystemPrompt = null;
let conversationHistory = [];

let vadState = core.createVadState();
let resampleRemainder = Buffer.alloc(0);
let speechBuffers = [];

function sendToRenderer(channel, data) {
    gemini().sendToRenderer(channel, data);
}

function resetAudioState() {
    vadState = core.createVadState();
    resampleRemainder = Buffer.alloc(0);
    speechBuffers = [];
}

function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${apiKey}`, ...extra };
}

async function transcribeAudio(pcm16kBuffer) {
    const wavBuffer = core.createWavBuffer(pcm16kBuffer);
    // Language is left unset so Whisper auto-detects it, rather than pinning to
    // English the way the local provider does.
    const form = core.buildTranscribeForm(wavBuffer, transcribeModel);

    // Content-Type is deliberately omitted: fetch derives the multipart
    // boundary from the FormData body.
    const response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
    });

    if (!response.ok) {
        throw new Error(core.describeApiError(response.status, await response.text()));
    }

    const result = await response.json();
    const text = result.text?.trim() || '';
    console.log('[OpenAI] Transcription:', text);
    return text;
}

async function requestOpenAi(model, messages, onText) {
    const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(core.buildChatBody(model, messages)),
    });

    if (!response.ok || !response.body) {
        throw new Error(core.describeApiError(response.status, await response.text()));
    }

    const decoder = new TextDecoder();
    let pending = '';
    let fullText = '';

    for await (const chunk of response.body) {
        const parsed = core.parseSseChunk(decoder.decode(chunk, { stream: true }), pending);
        pending = parsed.pending;

        for (const token of parsed.tokens) {
            fullText += token;
            onText(fullText);
        }
    }

    return fullText;
}

async function sendToOpenAi(transcription) {
    conversationHistory.push({ role: 'user', content: transcription.trim() });
    conversationHistory = core.trimHistory(conversationHistory, MAX_HISTORY_TURNS);

    try {
        const messages = [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...conversationHistory];

        let isFirst = true;
        const fullText = await requestOpenAi(textModel, messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            conversationHistory.push({ role: 'assistant', content: fullText.trim() });
            gemini().saveConversationTurn(transcription, fullText);
        }

        console.log('[OpenAI] Response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[OpenAI] Chat error:', error);
        sendToRenderer('update-status', error.message);
        throw error;
    }
}

async function handleSpeechEnd(audioData) {
    if (!isActive) return;

    if (audioData.length < MIN_SPEECH_BYTES) {
        console.log('[OpenAI] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    try {
        const transcription = await transcribeAudio(audioData);

        if (!transcription || transcription.length < 2) {
            console.log('[OpenAI] Empty transcription, skipping');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        sendToRenderer('update-status', 'Generating response...');
        await sendToOpenAi(transcription);
    } catch (error) {
        console.error('[OpenAI] Transcription error:', error);
        sendToRenderer('update-status', error.message);
    }
}

function processOpenAiAudio(monoChunk24k) {
    if (!isActive) return;

    const resampled = core.resample24kTo16k(monoChunk24k, resampleRemainder);
    resampleRemainder = resampled.remainder;
    if (resampled.out.length === 0) return;

    const step = core.vadStep(vadState, core.calculateRms(resampled.out), vadConfig);
    vadState = step.state;

    if (step.event === 'speech-start') {
        speechBuffers = [];
        console.log('[OpenAI] Speech started');
        sendToRenderer('update-status', 'Listening... (speech detected)');
    }

    if (step.event === 'speech-end') {
        const audioData = Buffer.concat(speechBuffers);
        speechBuffers = [];
        console.log('[OpenAI] Speech ended, accumulated', audioData.length, 'bytes');
        sendToRenderer('update-status', 'Transcribing...');
        handleSpeechEnd(audioData);
        return;
    }

    if (vadState.isSpeaking) {
        speechBuffers.push(Buffer.from(resampled.out));
    }
}

async function initializeOpenAiSession(profile, customPrompt) {
    console.log('[OpenAI] Initializing session:', { profile });
    sendToRenderer('session-initializing', true);

    try {
        const key = getOpenAiApiKey();
        if (!key || key.trim() === '') {
            throw new Error('No OpenAI API key configured');
        }

        closeOpenAiSession();

        const config = getConfig();
        apiKey = key.trim();
        textModel = config.openaiModel;
        imageModel = config.openaiImageModel;
        transcribeModel = config.openaiTranscribeModel;
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);

        resetAudioState();
        conversationHistory = [];

        gemini().initializeNewSession(profile, customPrompt);
        isActive = true;

        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'OpenAI ready - Listening...');
        console.log('[OpenAI] Session initialized');
        return true;
    } catch (error) {
        console.error('[OpenAI] Initialization error:', error);
        closeOpenAiSession();
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', `OpenAI error: ${error.message}`);
        return false;
    }
}

function closeOpenAiSession() {
    isActive = false;
    apiKey = null;
    textModel = null;
    imageModel = null;
    transcribeModel = null;
    currentSystemPrompt = null;
    conversationHistory = [];
    resetAudioState();
}

function isOpenAiSessionActive() {
    return isActive;
}

async function sendOpenAiText(text) {
    if (!isActive) {
        return { success: false, error: 'No active OpenAI session' };
    }

    try {
        await sendToOpenAi(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendOpenAiImage(base64Data, prompt) {
    if (!isActive) {
        return { success: false, error: 'No active OpenAI session' };
    }

    const userMessage = {
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                },
            },
        ],
    };

    conversationHistory.push({ role: 'user', content: prompt });
    conversationHistory = core.trimHistory(conversationHistory, MAX_HISTORY_TURNS);

    try {
        sendToRenderer('update-status', 'Analyzing image...');
        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...conversationHistory.slice(0, -1),
            userMessage,
        ];

        let isFirst = true;
        const fullText = await requestOpenAi(imageModel, messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            conversationHistory.push({ role: 'assistant', content: fullText.trim() });
            gemini().saveConversationTurn(prompt, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: imageModel };
    } catch (error) {
        console.error('[OpenAI] Image error:', error);
        sendToRenderer('update-status', error.message);
        return { success: false, error: error.message };
    }
}

// Standalone translation used by the live-transcript mode. It reads its own key
// and model because transcript mode runs without an initialized chat session.
async function getTranslation(text, targetLanguage) {
    const key = getOpenAiApiKey();
    if (!key || key.trim() === '') {
        throw new Error('No OpenAI API key configured');
    }

    const model = getConfig().openaiModel;
    const messages = [
        {
            role: 'system',
            content:
                `Translate the user's text into ${targetLanguage}. ` +
                `It is one utterance from a live meeting transcript and may be an incomplete sentence — translate it as-is anyway. ` +
                `Reply with the translation only: no commentary, no romanization, no quotes, and never an empty reply.`,
        },
        { role: 'user', content: text },
    ];

    const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0 }),
    });

    if (!response.ok) {
        throw new Error(core.describeApiError(response.status, await response.text()));
    }

    const result = await response.json();
    return result.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = {
    getTranslation,
    initializeOpenAiSession,
    processOpenAiAudio,
    closeOpenAiSession,
    isOpenAiSessionActive,
    sendOpenAiText,
    sendOpenAiImage,
};
