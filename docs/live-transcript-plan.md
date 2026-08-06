# Plan: Live Japanese Transcript for Meetings

**Status:** T1–T5 implemented. `pnpm test` 66/66 green. **T0 (capture spike) is yours to run** — it's the remaining risk.
**Created:** 2026-08-06
**Goal:** During a Google Meet call, capture the incoming audio and display a **live,
word-by-word Japanese transcript** on screen, with a Vietnamese translation under each
completed line. No AI answer generation in this mode.

> **This is a new feature, not a port.** The app has never displayed a live transcript.
> In Gemini mode `currentTranscription` accumulates in the main process (`gemini.js:684`)
> and is used only to feed the AI and to write history; it is never sent to the renderer.
> The sole place a transcript reaches the screen today is `HistoryView.js:377`, after the
> session ends. The transcript UI, the streaming IPC channel, and continuous
> transcription all have to be built regardless of provider.

---

## 0. Decisions

| # | Decision | Rationale |
|---|---|---|
| T1 | New provider mode **`transcribe`** — transcript only, no answer generation | User chose "transcript only". Keeps chat-completions cost at zero and the screen uncluttered. |
| T2 | **OpenAI Realtime transcription session** (`type: "transcription"`, model `gpt-live-transcribe`) | Word-by-word display requires streaming deltas. The batch path emits one block ~2-3s after each pause — that is not what was asked for. |
| T3 | **No resampling, no WAV** | Realtime's native input is `{"type":"audio/pcm","rate":24000}` and the app already captures at exactly 24000 (`renderer.js:10`). `resample24kTo16k` and `createWavBuffer` are simply unused here. |
| T4 | Pin **`language: "ja"`** | Auto-detect is a liability when the target language is known; it can flip mid-meeting on short utterances. |
| T5 | ~~Server-side VAD~~ → **client-side VAD + explicit `input_audio_buffer.commit`** | **Corrected against the live API 2026-08-06.** `server_vad` is rejected: *"Turn detection is not supported for this transcription model."* The client segments turns using the already-tested VAD from `openai-core.js`, and gates uploads on it — so silence is never billed. |
| T6 | Translate **finalized utterances only**, via `gpt-4o-mini` | Translating deltas would flicker unreadably and multiply cost. One translation call per completed line. |
| T7 | Split pure core: `openai-realtime-core.js` (TDD) + `openai-realtime.js` (socket) | Same reasoning as D6 in the provider plan — anything importing `gemini.js` needs an Electron runtime. |
| T8 | Target **Windows + macOS**. WSL2 is unsupported for capture. | Windows has a loopback branch (`renderer.js` startCapture `else`), macOS has `SystemAudioDump`. WSLg has no route to Windows audio devices. |

---

## 1. Limitation to accept up front

**No speaker labels.** `gpt-live-transcribe` explicitly does not provide speaker
attribution, word timestamps, or confidence scores. In a meeting with an interpreter and
a client, the transcript will be **one flat stream** with no "who said this".

This is not fixable by choosing a different OpenAI model — Gemini Live is the only
provider in this codebase that returns speaker-tagged results (`formatSpeakerResults`,
`gemini.js:40`). Mitigation is cosmetic only: timestamp each utterance and separate them
visually so turn boundaries are at least legible.

**Decide before building:** if knowing who spoke is essential, this needs a different
approach and we should talk about it first.

---

## 2. Architecture

```
Google Meet audio
      │
      ▼
getDisplayMedia loopback (Windows) │ SystemAudioDump (macOS)
      │  24 kHz PCM16 mono, 100 ms chunks
      ▼
ipcMain 'send-audio-content'  ── mode 'transcribe' ──►  openai-realtime.js
                                                              │
                                    input_audio_buffer.append (base64, as-is)
                                                              ▼
                                        wss://api.openai.com/v1/realtime
                                              ?intent=transcription
                                                              │
              ┌───────────────────────────────────────────────┤
              ▼                                               ▼
  ...transcription.delta                        ...transcription.completed
              │                                               │
              ▼                                               ▼
   'transcript-partial' ──► live line              'transcript-final' ──► committed line
                                                              │
                                                    gpt-4o-mini translate JA→VI
                                                              │
                                                              ▼
                                                   'transcript-translation'
```

---

## 3. Milestones

### T0 — Capture spike `[manual, do this first]`

The single biggest risk. **No feature code until this passes.**

- [ ] Run the app on Windows (or macOS), start a session, join a Meet call
- [ ] Confirm `send-audio-content` receives non-silent PCM while the far side speaks
- [ ] Verify by dumping a few seconds to a `.wav` and listening to it

**Why first:** if Meet audio cannot be captured, every line below is wasted. The existing
`saveDebugAudio` helper in `audioUtils.js` already writes debug wavs — reuse it.

---

### T1 — `src/utils/openai-realtime-core.js` `[TDD]`

Pure, zero-dependency. No electron, no `ws`, no fs.

| Function | Contract |
|---|---|
| `buildTranscriptionSessionUpdate(opts)` | → `session.update` payload with model, `audio.input.format`, `transcription.language`, `turn_detection` |
| `buildAudioAppend(pcmBuffer)` | → `{type:'input_audio_buffer.append', audio:<base64>}` |
| `createTranscriptState()` | → per-`item_id` accumulator |
| `applyServerEvent(state, event)` | → `{state, effects[]}`, effect ∈ `partial` \| `final` \| `error` \| `null` |

Tests that must exist (each is a real defect class):
- [x] Deltas for one `item_id` accumulate in arrival order
- [x] Two interleaved `item_id`s do not contaminate each other
- [x] `.completed` emits exactly one `final` and releases that item's state
- [x] A `.completed` with no preceding delta still emits a usable `final`
- [x] Unknown/unhandled event types are ignored, never thrown on
- [x] `error` events surface a readable message
- [x] Audio append respects the 15 MB per-message cap
- [x] Session payload pins `rate: 24000` and `language: 'ja'` from config, not literals

---

### T2 — `src/utils/openai-realtime.js` `[manual]`

- [x] Connect `wss://api.openai.com/v1/realtime?intent=transcription`, header `Authorization: Bearer`
      — **see Q1 on the beta header**
- [x] Send `session.update` on `session.created`
- [x] `appendAudio(pcm24k)` — pass straight through, no conversion
- [x] Dispatch server events through the pure core; emit effects to the renderer
- [x] Reconnect on drop, modelled on `cloud.js:connectCloud`
- [x] Teardown closes the socket and clears state
- [x] Lazy-require `./gemini` (circular-dependency rule G1)

---

### T3 — Translation `[manual]`

- [x] On `final` only, call `gpt-4o-mini` with a JA→VI instruction
- [x] Emit `transcript-translation` keyed by `item_id` so it lands under the right line
- [x] Failure is non-fatal: the Japanese line stays, translation shows as unavailable
- [x] Never translate partials

---

### T4 — `src/components/views/TranscriptView.js` `[manual]`

- [x] Scrolling list of committed utterances: timestamp, Japanese, Vietnamese underneath
- [x] One "live" line at the bottom showing the current partial, visually distinct
- [x] Auto-scroll, with auto-scroll suspended when the user scrolls up
- [x] Japanese-capable font stack; do not let the existing UI font mangle kana/kanji
- [x] Readable at the app's small overlay width

---

### T5 — Wiring `[manual]`

- [x] `currentProviderMode === 'transcribe'` arms in `gemini.js` — audio in, close-session,
      and **the `startMacOSAudioCapture` branch at `:929`** (G2)
- [x] `initialize-transcribe` IPC handler
- [x] `renderer.js`: `initializeTranscribe()` + transcript event listeners
- [x] `CheatingDaddyApp`: route to `TranscriptView` when mode is `transcribe`
- [x] `MainView`: a "Live transcript" entry point with the OpenAI key field
- [x] Force `audioMode: 'speaker_only'` in this mode — **see G-T1**

---

## 4. Gotchas

**G-T1 · `audioMode: 'both'` corrupts the stream.** System audio and mic audio arrive on
two IPC channels and would be appended to the *same* socket buffer, interleaving two
unrelated PCM streams into one — producing garbled audio, not a mix. The provider plan's
G4 is the same root cause. For meetings you want the far side anyway, so pin
`speaker_only` in this mode rather than trying to mix.

**G-T2 · RESOLVED — audio is now VAD-gated.** Because the model forced client-side turn
segmentation (T5), gating fell out for free: chunks are only uploaded while speech is
detected, with a 300 ms pre-roll so quiet sentence openings are not clipped. Silence is
never billed. Still outstanding: no idle auto-stop and no spend cap, so a forgotten
session keeps a socket open.

**G-T3 · No session cleanup on crash.** An abandoned socket keeps billing. Ensure
`before-quit` (`index.js:41`) closes it, as it already does for `localai`.

**G-T4 · Japanese text rendering.** The overlay CSS was never exercised with CJK. Line
height, wrapping, and font fallback all need checking — this is a real UI task, not a
detail.

---

## 5. Open questions

**Q1 · RESOLVED 2026-08-06 — the beta header is NOT required.** A live connection to
`wss://api.openai.com/v1/realtime?intent=transcription` with only `Authorization: Bearer`
reached `WebSocket open`. Do not add `OpenAI-Beta`.

**Q2 · Latency vs quality knob.** `gpt-live-transcribe` exposes delay settings — lower
delay yields earlier partials, higher delay yields better text. Needs tuning against real
Japanese speech; start at the default.

---

## 6. Cost

| Item | Per 1h meeting | ~20 meetings/month |
|---|---|---|
| `gpt-live-transcribe`, streaming continuously | ~$1.02 | ~$20 |
| `gpt-live-transcribe`, VAD-gated | ~$0.71 | ~$14 |
| JA→VI translation on `gpt-4o-mini` | pennies | pennies |

---

## 7. Relationship to the OpenAI provider work

Independent. The provider port (`docs/openai-provider-plan.md`, M-1→M3, shipped) gives
answers from audio; this gives a readable transcript. They share the OpenAI key, the
credential plumbing, and `openai.js`'s chat-completions client — which T3 reuses for
translation. Neither blocks the other.

---

## 8. Progress log

| Date | Milestone | Notes |
|---|---|---|
| 2026-08-06 | Plan written | Confirmed: Windows + macOS, word-by-word, JA + VI, transcript-only |
| 2026-08-06 | **T1 done** | `openai-realtime-core.js`, 15 tests, red-first (module absent) then green |
| 2026-08-06 | **T2 done** | `openai-realtime.js` — WS connect, session.update, reconnect, teardown |
| 2026-08-06 | **T3 done** | `getTranslation()` in `openai.js`; finals only, non-fatal on failure |
| 2026-08-06 | **T4 done** | `TranscriptView.js` — CJK font stack, live line, scroll-pin, jump-to-live |
| 2026-08-06 | **T5 done** | 6 provider arms (parity with local/openai), IPC, renderer, app routing, MainView panel |
| 2026-08-06 | **First live API contact** | Connected successfully. Two findings: Q1 resolved (no beta header), and `server_vad` rejected by `gpt-live-transcribe` → switched to client VAD + explicit commit, which also delivered the G-T2 cost gating. |
| 2026-08-06 | Verification | 66/66 tests; prettier clean; fake-WebSocket smoke test drove the full chain (session.update → audio append → deltas → final → JA→VI translation → error → close); app boots in transcript mode with no renderer errors. **Never connected to the real API.** |
