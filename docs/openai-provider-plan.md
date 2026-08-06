# Plan: Add OpenAI as a First-Class Provider

**Status:** M-1 → M3 implemented. `npm test` 48/48 green. Awaiting live-key verification in the app.
**Created:** 2026-08-06
**Scope:** Add `openai` as a fourth provider mode (alongside `byok`, `local`, `cloud`) so a session can run end-to-end — audio in, answers out — using only an OpenAI API key.

---

## 0. Decisions & Assumptions

Locked in before coding. Flip any of these here first, not mid-implementation.

| # | Decision | Rationale | How to flip |
|---|---|---|---|
| D1 | **Batch transcription**, not the Realtime API. Audio → local VAD → `/v1/audio/transcriptions` → `/v1/chat/completions`. | Reuses ~200 lines of proven code from `localai.js`. The Realtime API is a fresh WebSocket build with no precedent in this repo. | Replaces M1 entirely with a `cloud.js`-shaped WS client. Do it as a follow-up mode (`openai-realtime`), not a rewrite. |
| D2 | **New file `src/utils/openai.js`**, not a generalized "OpenAI-compatible base URL" on the Groq path. | Groq is an *overlay on `byok`* with no audio path — it can never be OpenAI-only. A provider mode can. | — |
| D3 | Credential key is **`openaiApiKey`**, with `get/setOpenAiApiKey()` accessors. | Matches the `apiKey` / `groqApiKey` + `getGroqApiKey`/`setGroqApiKey` convention in `storage.js`. | See G7 — dead scaffolding uses `openaiKey`; must be repointed, not left to create two competing keys. |
| D4 | Keep the **24k→16k resample** and 16k WAV builder verbatim from `localai.js`. | OpenAI accepts 24k fine, but reusing the path means `createWavBuffer`'s hardcoded 16000 stays consistent, and it cuts upload size ~33%. | — |
| D5 | Default models: `gpt-4o-mini` (text + vision), `whisper-1` (transcription). | Cheap, vision-capable, widely available. All three are free-text inputs in the UI, so users can override. | Edit `DEFAULT_CONFIG`. |
| D6 | **Split pure core.** `openai-core.js` (zero deps, fully unit-tested) + `openai.js` (thin Electron-facing adapter, manually verified). | `gemini.js:2` requires `electron` at module load, so anything transitively importing it is untestable without an Electron runtime. Splitting is what makes TDD possible at all. | — |
| D7 | **`node:test` + `node:assert`**, run via `npm test` → `node --test test/`. | Built into Node 20.20.2. Zero new devDependencies in a repo that has none for testing, and no bundler to configure. | — |
| D8 | **Test scope: new OpenAI code only** — `openai-core.js` and the new storage accessors. | Keeps every changed line traceable to the request (CLAUDE.md §3). Pre-existing untested code stays out of scope. | — |
| D9 | No test may be satisfied by hardcoding a value the implementation is supposed to compute. Tests assert behavior against independently-derived expectations. | Explicit user requirement. | — |

**Confirmed by user 2026-08-06:** D1 (batch), D6, D7, D8.

> **Verify at implementation time:** model IDs, per-token and per-minute pricing, and whether `max_tokens` vs `max_completion_tokens` applies to the chosen model. Confirm against OpenAI's current docs rather than trusting the values above.

---

## 1. Why this is cheaper than it looks

`src/utils/localai.js` is **already an OpenAI client**. llama.cpp and whisper.cpp expose OpenAI-compatible endpoints, so the local provider is written against OpenAI's exact wire format. The port:

| `localai.js` source | Lines | OpenAI equivalent | Work |
|---|---|---|---|
| `resample24kTo16k` | 42–63 | — | verbatim |
| `calculateRms` | 65–76 | — | verbatim |
| `processVad` | 78–110 | — | verbatim |
| `createWavBuffer` | 112–131 | — | verbatim |
| `transcribeAudio` | 133–158 | `POST /v1/audio/transcriptions` | add `Authorization`, add `model` form field, change URL |
| `handleSpeechEnd` | 160–184 | — | verbatim (rename callee) |
| `readStreamingResponse` | 186–212 | — | verbatim (SSE `choices[0].delta.content`) |
| `requestLlama` | 214–239 | `POST /v1/chat/completions` | add `Authorization`, real model, drop `chat_template_kwargs` |
| `sendToLlama` | 241–275 | — | rename |
| `processLocalAudio` | 480–487 | — | verbatim |
| `closeLocalSession` | 489–507 | — | strip server teardown, keep state reset |
| `sendLocalText` | 528–539 | — | verbatim |
| `sendLocalImage` | 541–590 | — | verbatim (already builds `image_url` data-URI blocks) |
| Binary download / SHA-256 / port alloc / spawn / health-wait / cache GC | ~400 lines | **not needed** | delete |

**Net: `openai.js` ≈ 200 lines, mostly transcribed from a working file.**

---

## 2. API contracts

### Transcription
```
POST https://api.openai.com/v1/audio/transcriptions
Authorization: Bearer <key>
Content-Type: multipart/form-data

file=<speech.wav>  model=whisper-1  response_format=json  language=en  temperature=0
→ 200 { "text": "..." }
```
Differences from whisper.cpp's `/inference`: URL, `Authorization` header, and `model` is **required**. Everything else in `transcribeAudio:133` carries over.

> `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` only support `response_format=json`. `whisper-1` supports all formats. Since the code only ever reads `.text`, `json` is correct for all three.

### Chat (text + vision, streaming)
```
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer <key>
Content-Type: application/json

{ "model": "...", "messages": [...], "stream": true, "max_tokens": 2048, "temperature": 0.7 }
→ SSE: data: {"choices":[{"delta":{"content":"..."}}]}  ...  data: [DONE]
```
Byte-identical to `requestLlama:214` apart from URL/auth/model. Vision messages use the same `{type:'image_url', image_url:{url:'data:image/jpeg;base64,...'}}` shape `sendLocalImage:546` already builds.

**Do not reuse `getGroqReasoningOptions` (`gemini.js:253`)** — it emits Groq-only params (`reasoning_format`, `include_reasoning`) and OpenAI returns 400 on unknown body params.

---

## 3. Milestones

Every milestone with a `[TDD]` tag follows strict red → green → refactor:
write the failing test, run it and **see it fail for the right reason**, then implement
the minimum to pass. Milestones tagged `[manual]` touch Electron-bound code that cannot
be unit-tested without a runtime — they are verified by driving the app.

### M-1 — Test infrastructure `[setup]`

- [x] `package.json` — add `"test": "node --test test/"` to `scripts` (replaces nothing; `lint` stays as-is)
- [x] Create `test/` directory
- [x] Smoke test: a trivial `node --test` run passes, proving the runner works with zero devDependencies

**Verify:** `npm test` exits 0 and reports the smoke assertion. Must work **without** `npm install`, since no test dependency is added.

---

### M0 — Storage & credential plumbing `[TDD]`
*No behavior change; everything below depends on it.*

- [x] `src/storage.js:8` — add to `DEFAULT_CONFIG`: `openaiModel: 'gpt-4o-mini'`, `openaiImageModel: 'gpt-4o-mini'`, `openaiTranscribeModel: 'whisper-1'`
- [x] `src/storage.js:18` — add `openaiApiKey: ''` to `DEFAULT_CREDENTIALS`
- [x] `src/storage.js:210` — add `getOpenAiApiKey()` / `setOpenAiApiKey()` mirroring `getGroqApiKey`/`setGroqApiKey:204-210`
- [x] `src/storage.js:515` — export both in the Credentials block
- [x] `src/index.js:139` — add `storage:get-openai-api-key` / `storage:set-openai-api-key` handlers, matching the Groq pair at `:122-139`
- [x] `src/utils/renderer.js:58` — add `getOpenAiApiKey()` / `setOpenAiApiKey()` to the storage bridge, matching `:52-58`

**Tests first** — `test/storage.test.js`. `storage.js` imports only `fs`/`path`/`os` and derives its
directory from `os.homedir()`, which honours `$HOME` on POSIX. So each test points `HOME` at a fresh
`fs.mkdtempSync` dir, requires a **fresh module instance**, and asserts against the real filesystem —
no mocking, no stubbing.

- [x] `getOpenAiApiKey()` returns `''` when no credentials file exists
- [x] `setOpenAiApiKey(k)` then `getOpenAiApiKey()` round-trips `k`
- [x] `setOpenAiApiKey` **preserves** existing `apiKey` / `groqApiKey` (guards the `setCredentials` merge at `:190`)
- [x] `getConfig()` surfaces the three new `openai*` model defaults
- [x] Key is persisted to `credentials.json`, not `config.json`

**Verify:** `npm test` — red first, then green. Then manually: `npm start` → DevTools
`await cheatingDaddy.storage.setOpenAiApiKey('sk-test')` round-trips.

---

### M1a — Pure core (`src/utils/openai-core.js`) `[TDD]`
*Zero dependencies. No `require` of electron, gemini, storage, or fs. This is where the logic lives.*

Proposed surface (final shape settles during TDD):

| Function | Contract |
|---|---|
| `resample24kTo16k(buf, remainder)` | → `{ out, remainder }` — pure; caller threads `remainder` |
| `calculateRms(buf)` | → number in `[0,1]` |
| `vadStep(state, rms, cfg)` | → `{ state, event }` where event ∈ `null \| 'speech-start' \| 'speech-end'` |
| `createWavBuffer(pcm)` | → 44-byte RIFF header + PCM |
| `parseSseChunk(text, pending)` | → `{ tokens, pending }` — handles split lines and `[DONE]` |
| `buildChatBody(model, messages, opts)` | → request body object |
| `trimHistory(history, max)` | → capped history array |

- [x] `test/openai-core.test.js` written first, one red test per row above
- [x] Implement `openai-core.js` until green

Notable cases the tests must cover (each is a real defect class, not a formality):
- `resample24kTo16k` — remainder carried across calls; two half-chunks must equal one whole chunk
- `createWavBuffer` — header fields decoded back with `readUInt32LE`/`readUInt16LE` and checked against the spec (`RIFF`, `WAVE`, `fmt `, PCM=1, mono=1, 16 kHz, 16-bit, correct byte rate and sizes) — **not** compared against a hardcoded byte blob
- `parseSseChunk` — a `data:` line split across two chunk boundaries yields exactly one token; `[DONE]` yields none; malformed JSON does not throw
- `vadStep` — no `speech-end` without a preceding `speech-start`; threshold boundaries exercised from `cfg`, not literals

---

### M1b — Adapter + wiring (`src/utils/openai.js`) `[manual]`
*Goal: a session that hears and answers with no Gemini key present.*

- [x] Create `src/utils/openai.js`. **Lazy-require `./gemini` inside functions** — see G1.
- [x] Adapter owns all mutable session state and threads it through the pure core
- [x] `transcribeAudio` → OpenAI transcriptions; `requestOpenAi` → chat completions; `sendToOpenAi`
- [x] Write `initializeOpenAiSession(profile, customPrompt)` — model it on `initializeLocalSession:425` but **drop** the download/spawn/`AbortController` machinery. It should: validate the key, set `currentSystemPrompt` via `getSystemPrompt` (`prompts.js:217`), reset VAD state, call `initializeNewSession`, emit `session-initializing` false, return bool.
- [x] Write `closeOpenAiSession()` — mirror `closeLocalSession:489` **minus** `stopNativeServer`. Must reset every module-level mutable: `isSpeaking`, `speechBuffers`, `silenceFrameCount`, `speechFrameCount`, `resampleRemainder`, history, `currentSystemPrompt`. See G3.
- [x] Write `processOpenAiAudio`, `sendOpenAiText`, `isOpenAiSessionActive`
- [x] `module.exports` mirroring `localai.js:592`

Wire into `src/utils/gemini.js`:
- [x] Add `getOpenAi()` lazy accessor next to `getLocalAi():12`
- [x] `:1092` — add `ipcMain.handle('initialize-openai', ...)`, modeled on `initialize-local:1085`; set `currentProviderMode = 'openai'`, revert to `'byok'` on failure
- [x] `:1113` — `send-audio-content`: add `if (currentProviderMode === 'openai')` arm
- [x] `:1148` — `send-mic-audio-content`: same arm
- [x] `:1224` — `send-text-message`: same arm
- [x] `:1290` — `close-session`: same arm (call `closeOpenAiSession()`, reset mode, `closeTransportLog()`)
- [x] `:924` — **`startMacOSAudioCapture`**: add the arm here too. This is inside a `stdout.on('data')` callback, not an IPC handler — easiest branch in the codebase to miss. See G2.

Wire into the renderer:
- [x] `src/utils/renderer.js:170` — add `initializeOpenAI(profile)`, modeled on `initializeLocal:156`; read key from storage, bail with `setStatus('error')` if empty, set status `'OpenAI Live'` on success
- [x] `src/components/app/CheatingDaddyApp.js:620` — add `else if (providerMode === 'openai')` arm to `handleStart`, mirroring the `local` arm (including the `triggerApiKeyError()` failure path)

**Verify:**
1. Set an OpenAI key, clear the Gemini key, set provider mode to `openai` (via DevTools: `cheatingDaddy.storage.updatePreference('providerMode','openai')` until M3 lands the UI).
2. Start a session, speak → transcript appears in logs, a streamed answer renders.
3. Type into the text box → answer streams.
4. End session → no orphaned state; starting again works cleanly.
5. Confirm zero requests to `generativelanguage.googleapis.com` (main-process console).

---

### M2 — Vision path
- [x] `src/utils/openai.js` — add `sendOpenAiImage(base64Data, prompt)`, ported from `sendLocalImage:541` using `config.openaiImageModel`
- [x] `src/utils/gemini.js:1195` — `send-image-content`: add the `openai` arm **above** the `hasGroqKey()` ternary at `:1200`
- [x] Export from `openai.js`

**Verify:** with a session live, wait for the screenshot interval (`startCapture`, fired from `renderer.js:539/644`) → an image-grounded answer arrives. Confirm the request body carries a `data:image/jpeg;base64,` URL.

---

### M3 — UI
- [x] `src/components/views/MainView.js:972` — **repoint the dead `_saveOpenaiKey`** from `setCredentials({...creds, openaiKey})` to `setOpenAiApiKey(val)` (G7)
- [x] `:769` — `_loadFromStorage`: read via `getOpenAiApiKey()` instead of `creds.openaiKey`
- [x] `:704` — add `_openaiModel`, `_openaiImageModel`, `_openaiTranscribeModel` to `properties`, `:733` constructor, `:773` load
- [x] Add `_saveOpenaiModel` / `_saveOpenaiImageModel` / `_saveOpenaiTranscribeModel`, matching `_saveGroqModel:954`
- [x] Add `_renderOpenAiMode()` — clone the `<details class="config-section">` structure from `_renderByokMode:1159`; one key field + three model fields; link to `https://platform.openai.com/api-keys`; end with `${this._renderStartButton()} ${this._renderDivider()}` and mode links back to `byok` / `local`
- [x] `:1347` — add `${this._mode === 'openai' ? this._renderOpenAiMode() : ''}` to the render switch
- [x] `:1241` — add `<button class="mode-link" @click=${() => this._saveMode('openai')}>Use OpenAI</button>` to the byok **and** local mode-link rows, so the new mode is reachable and escapable

**Verify:** full round trip with no DevTools — switch to OpenAI mode in the UI, paste key, Start, get an answer. Reload the app and confirm mode + key persist.

---

### M4 — Polish
- [x] Map HTTP failures to useful status text: 401 → "Invalid OpenAI API key", 429 → "Rate limited / quota exceeded", 400 → surface `error.message` from the body
- [ ] Optional: `logTransportEvent('openai.*', ...)` calls mirroring the Groq path (`gemini.js:291` etc.). `localai.js` has none, so this is additive — decide once, apply consistently.
- [x] `npx prettier --write .` (per `AGENTS.md`: 4-space, width 150, single quotes)

---

## 3b. M5 — Realtime streaming transcription

**Status:** Planned. Supersedes decision D1's deferral of the Realtime API.
**Docs pulled:** 2026-08-06 from `developers.openai.com` (the `platform.openai.com` guide 301s there now).

### Why this changes the architecture

Four facts from the current docs reshape the obvious design:

**F1 · 24 kHz PCM is the native input format.** Realtime takes
`{"type": "audio/pcm", "rate": 24000}`. This app **already captures at exactly 24000**
(`renderer.js` `SAMPLE_RATE`, and `startMacOSAudioCapture`'s `SAMPLE_RATE = 24000`).
So the Realtime path needs **no resampling and no WAV wrapping** — `resample24kTo16k`
and `createWavBuffer` are simply not used. The batch path's two most delicate pieces
of DSP drop out entirely.

**F2 · There are two session types, and the smaller one fits better.**

| Session | URL | Purpose |
|---|---|---|
| `type: "transcription"` | `wss://api.openai.com/v1/realtime?intent=transcription` | transcription only |
| `type: "realtime"` | `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1` | full voice agent |

**F3 · The model lineup has moved on.** `gpt-live-transcribe` (streaming deltas,
tunable latency/quality), `gpt-transcribe` (post-commit, language detection),
`gpt-realtime-2.1` (voice agent). The `whisper-1` default chosen in D5 is now
legacy — OpenAI publishes a migration cookbook away from it.

**F4 · `gpt-live-transcribe` explicitly does not provide speaker labels.**
Documented limitation, alongside no word timestamps and no confidence scores.
**So Realtime does not close the diarization gap against Gemini Live.** That gap is
structural, not a consequence of choosing batch.

### D10 — Use a transcription-only session, keep chat completions for answers

Realtime replaces **only** the transcription leg. Answers keep flowing through the
already-working `requestOpenAi` chat-completions path.

```
audio 24k ──► Realtime WS (transcription session) ──► transcript
                                                          │
                                                          ▼
                                          chat completions (proven, M1b)
                                                          │
                                                          ▼
                                              streamed markdown answer
```

Rationale:
- **It mirrors the shape the app already has.** Gemini Live transcribes, Groq answers.
  This is the same split with OpenAI on both legs.
- **The app has no audio output path at all.** A full `realtime` session's headline
  feature is speech out; this UI renders markdown. Requesting
  `output_modalities: ["text"]` from a voice-agent session means paying realtime rates
  for text this app already gets cheaply.
- **Smaller blast radius.** The answer path stays untouched and tested.

A full voice-agent session stays a possible M6 — worth it only if audio-native
reasoning (tone, prosody, interruption) turns out to matter.

### D11 — `ws` is already a dependency

`cloud.js` uses it. No new packages, and `cloud.js` is a working in-repo precedent for
a WebSocket provider: connect, `handleMessage` dispatch, reconnect, teardown.

### D12 — Split pure core again

`openai-realtime-core.js` (pure, TDD) + `openai-realtime.js` (socket + state, manual).
Same reasoning as D6.

### Milestones

**M5a — `src/utils/openai-realtime-core.js` `[TDD]`**

| Function | Contract |
|---|---|
| `buildTranscriptionSessionUpdate(model, opts)` | → the `session.update` payload |
| `buildAudioAppend(pcmBuffer)` | → `{type:'input_audio_buffer.append', audio:<base64>}` |
| `createTranscriptState()` | → per-`item_id` accumulator |
| `applyServerEvent(state, event)` | → `{state, effects[]}` where effect ∈ `partial-transcript` \| `final-transcript` \| `error` \| `null` |

- [ ] Tests first, one red per row
- [ ] Deltas for the same `item_id` accumulate in order
- [ ] Interleaved `item_id`s do not cross-contaminate
- [ ] `.completed` emits exactly one `final-transcript` and clears that item
- [ ] Unknown event types are ignored, not thrown on
- [ ] `error` events surface a usable message
- [ ] Audio chunks respect the 15 MB per-message cap

**M5b — `src/utils/openai-realtime.js` `[manual]`**
- [ ] Connect with `Authorization: Bearer` (see Q1 on the beta header)
- [ ] Send `session.update` on `session.created`
- [ ] Feed 24 kHz PCM straight through — **no resample, no WAV**
- [ ] Route `final-transcript` into the existing `sendToOpenAi` from `openai.js`
- [ ] Reconnect on socket drop, modelled on `cloud.js`
- [ ] Teardown resets state and closes the socket

**M5c — Wiring `[manual]`**
- [ ] Reuse the existing `openai` provider mode; add a preference toggling
      batch vs realtime transcription rather than adding a fifth mode
- [ ] MainView: a checkbox in the OpenAI panel
- [ ] Fall back to batch if the socket cannot connect

### Open questions to resolve at implementation time

**Q1 · Is `OpenAI-Beta: realtime=v1` still required?** The GA WebSocket guide shows
**only** `Authorization`, and the overview notes the beta header was *removed* at GA.
But several sources — including one describing the `intent=transcription` connection —
still show it. **Resolve empirically:** connect with `Authorization` alone; if the
handshake 4xxs, add the beta header. Do not guess.

**Q2 · Server VAD or manual commit?** `turn_detection: null` means the client commits
turns via `input_audio_buffer.commit` — which would reuse the existing energy-gate VAD.
Configuring server VAD instead hands boundary detection to OpenAI and moots G3/G4.
Start with server VAD; keep manual commit as the fallback.

**Q3 · Does M0's `whisper-1` default need updating?** Per F3 it is legacy. Changing it
affects the shipped batch path, so treat it as a separate decision, not a silent edit.

**Q4 · Cost.** Realtime is billed differently from batch transcription. G5 already
notes there is no spend guardrail anywhere; streaming continuously makes that sharper.

---

## 4. Gotchas — read before writing code

**G1 · Circular require.** `localai.js:4` requires `gemini.js` for `sendToRenderer` / `initializeNewSession` / `saveConversationTurn`, while `gemini.js:12` uses a lazy `getLocalAi()` *specifically* to break that cycle. `openai.js` must repeat the pattern exactly: top-level `require('./gemini')` in `openai.js` is fine, but `gemini.js` must reach `openai.js` only through a lazy accessor. Get this wrong and it fails at module load, not at runtime.

**G2 · The hidden 21st branch.** `currentProviderMode` is switched on at 21 sites, all in `gemini.js`. Twenty are in IPC handlers. One — `:922-928` — is inside `startMacOSAudioCapture`'s `stdout.on('data')` callback. Miss it and macOS system audio silently routes to Gemini while every other path uses OpenAI. Grep `currentProviderMode` and check off all 21 before declaring M1 done.

**G3 · Module-global VAD state.** `isSpeaking`, `speechBuffers`, `silenceFrameCount`, `speechFrameCount`, `resampleRemainder` are module-level mutables. Safe because only one provider is active at a time — but `closeOpenAiSession()` must reset all five or a second session starts mid-utterance with a corrupt resampler remainder.

**G4 · Pre-existing: dual audio streams share one VAD.** `send-audio-content` and `send-mic-audio-content` both feed the *same* VAD instance in local mode. With `audioMode: 'both'`, speaker and mic chunks interleave into one buffer and corrupt `resampleRemainder`. Default is `'speaker_only'` (`storage.js:31`) so it's usually masked. **`openai.js` inherits this bug by construction.** Not in scope — do not fix here. Flagged so it isn't mistaken for a new regression.

**G5 · Cost has no guardrail.** This app listens continuously and screenshots on an interval. Nothing in the codebase rate-limits or caps spend. The Groq quota bookkeeping (`storage.js:373` `getModelForToday`, `incrementCharUsage:344`) is hardcoded to Groq's free tier and does **not** transfer. `VAD_MODES.VERY_AGGRESSIVE` (`localai.js:39`) is the only thing limiting transcription volume. Worth telling the user; out of scope to build.

**G6 · Plaintext credentials.** The OpenAI key lands in the same plaintext JSON as every other key (`storage.js` credentials file). Consistent with existing behavior; not changing it here.

**G7 · Abandoned scaffolding.** `MainView.js` already has `_openaiKey` (`:700`, `:729`, `:769`) and `_saveOpenaiKey()` (`:972-977`) writing `creds.openaiKey` — but no input renders it, `openaiKey` is absent from `DEFAULT_CREDENTIALS`, and no main-process code reads it. Someone started this and stopped. **Repoint it to `openaiApiKey` in M3** rather than leaving two competing credential keys. This is in-scope cleanup (it *is* the OpenAI key field), not unrelated dead code.

**G8 · No tests.** Zero test files, no runner. Every "Verify" step is manual via `npm start`. Budget for it.

---

## 5. Change surface

| File | Type | Touch points |
|---|---|---|
| `src/utils/openai-core.js` | **new** | ~130 lines, zero deps, fully unit-tested |
| `test/openai-core.test.js` | **new** | TDD suite for the core |
| `test/storage.test.js` | **new** | TDD suite for the new accessors |
| `package.json` | modify | add `test` script |
| `src/utils/openai.js` | **new** | ~120 lines adapter |
| `src/utils/gemini.js` | modify | `getOpenAi()` accessor, 1 new IPC handler, 6 branch arms (incl. `:924`) |
| `src/storage.js` | modify | 3 config defaults, 1 credential default, 2 accessors, 2 exports |
| `src/index.js` | modify | 2 IPC handlers |
| `src/utils/renderer.js` | modify | 2 bridge methods, `initializeOpenAI()` |
| `src/components/app/CheatingDaddyApp.js` | modify | 1 dispatch arm |
| `src/components/views/MainView.js` | modify | 4 state fields, 4 save handlers, `_renderOpenAiMode()`, render switch, 2 mode links, repoint `_saveOpenaiKey` |

**~350 new lines, ~45 modified, across 7 files.** Mechanical, but wide — hence this doc.

---

## 6. Out of scope

Named so they don't get pulled in mid-implementation:

- ~~Realtime API (D1)~~ — **promoted to M5**, see §3b
- Fixing G4 (shared VAD across audio streams)
- Spend caps or rate limiting (G5)
- Credential encryption (G6)
- Refactoring the 21-branch `currentProviderMode` if-ladder into a provider registry — tempting while touching all 21, but it is not what was asked
- Re-enabling `cloud` mode (`MainView.js:1146`, `CheatingDaddyApp.js:600`)
- The unrelated dead code found while exploring: `src/components/index.js` (nothing imports it; exports a non-existent `AdvancedView.js`), and `src/index.html:194` loading a non-existent `src/script.js`

---

## 7. Progress log

| Date | Milestone | Notes |
|---|---|---|
| 2026-08-06 | Plan written | Not started |
| 2026-08-06 | D1/D6/D7/D8 confirmed | Batch transcription; split pure core; `node:test`; new-code-only scope |
| 2026-08-06 | **M-1 done** | `npm test` → `node --test test/`, zero devDependencies added |
| 2026-08-06 | **M0 done** | `test/storage.test.js` 9/9 green. Red-first confirmed: accessors absent, config keys undefined. Electron-bound IPC + renderer bridge written, pending manual verify. |
| 2026-08-06 | **M1a done** | `test/openai-core.test.js` — 39 tests, red-first (module absent), then green. Includes `describeApiError`, TDD'd separately. |
| 2026-08-06 | **M1b done** | `openai.js` adapter + all 6 `currentProviderMode` arms (parity verified: 6 local / 6 openai, including the hidden `startMacOSAudioCapture` branch). |
| 2026-08-06 | **M2 done** | Vision via `sendOpenAiImage`; `send-image-content` arm placed above the `hasGroqKey()` ternary. |
| 2026-08-06 | **M3 done** | `_renderOpenAiMode()`, mode links from byok and local, dead `_saveOpenaiKey` repointed to `setOpenAiApiKey` (G7 resolved). |
| 2026-08-06 | **M4 partial** | Error mapping done (401/403, 429, body-message passthrough). Transport logging still deferred. |
| 2026-08-06 | **M5 planned** | Realtime docs pulled from `developers.openai.com`. Architecture changed by findings: 24 kHz is native (no resample/WAV), a transcription-only session type exists, models moved to `gpt-live-transcribe`/`gpt-realtime-2.1`, and `gpt-live-transcribe` still has no speaker labels. |
| 2026-08-06 | Verification | 48/48 unit tests; prettier clean; circular-require + IPC registration verified under a stubbed electron; full pipeline smoke-tested against a faked API (VAD → transcribe → SSE stream → history → image). **`npm start` could not run here:** the sandbox lacks `libnss3.so`, so the UI is unverified. |
