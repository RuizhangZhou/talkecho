# Meeting latency investigation (#71)

Issue: https://github.com/RuizhangZhou/talkecho/issues/71

## Findings

The v0.2.1 implementation avoids fixed queue overflow but can amplify provider latency:

1. Transcription is serial. A promoted batch is completely transcribed before any of its text reaches translation. When speech arrives every four seconds and STT takes six seconds per file, this stage cannot keep up, even with a fast translator.
2. The single pending text buffer is sent as one unbounded request. As the audio backlog grows, translation requests become larger and may exceed the 60-second request timeout. One earlier request can also hit the stream inactivity timeout before producing text; a retry then adds another wait.
3. Frontend abort previously left native provider HTTP running. Stream retries could overlap abandoned requests until their native timeouts expired.
4. A new reqwest client was built for every provider request, preventing connection reuse between segments.
5. ETA summed overlapping stages and treated segment count as uniform work. A displayed 100-second backlog was neither a measured age nor a reliable drain estimate.

Automatic translation already excluded prior assistant translations and limited raw reference context to 2,000 estimated tokens. It did not send the entire meeting history. The selected provider/model and the user's historical red errors were not available during this investigation, so provider-specific slowdown remains unmeasured.

## Changes

- Run at most two file-STT requests concurrently. Commit successful and failed outcomes in capture order. Each completed transcript can move to translation as soon as earlier STT outcomes are known; it does not wait for the rest of a promoted batch.
- Save the raw transcript before translation. A translation failure leaves the original visible and eligible for normal incremental conversation saving.
- Retain one mutable pending text buffer, but promote bounded slices: at most eight parts and 400 estimated input tokens including per-part source-label allowance. Split oversized utterances without deleting characters or whitespace. Continue processing the remaining buffer in order.
- Limit automatic raw reference context to 400 estimated tokens, excluding the utterance being processed and any newer pending transcripts. Custom system prompts remain user-controlled and are not truncated.
- Estimate translation work by text size and STT work by available worker slots. Account for stage overlap and observed transcript sizes. Display the actual age of the oldest unfinished part alongside approximate drain time. Age is measured from receipt of the completed audio segment, not from the start of speech. The estimate assumes no additional incoming speech and cannot predict future stalls or retries.
- Propagate AbortSignal to native HTTP through registered request IDs. A cancelled native future drops the HTTP operation; a stalled translation stream is stopped before retry. Respect Retry-After on translation retries. Keep the existing 60-second translation total timeout and 20-second stream inactivity timeout.
- Reuse the native provider HTTP client, keeping per-request timeout, body, credentials and headers separate.
- Distinguish native timeout/connect errors. Show the processing stage and error kind, retain ten recent errors in the meeting panel, and persist structured timing/error metadata to rotating local logs. Show the most recent STT duration, AI first-text delay, and AI total duration.
- Ensure native Windows unit tests link Common Controls v6. The test executable otherwise failed at startup with missing `comctl32!TaskDialogIndirect` on this Windows 10 host. See [Cargo build script linker arguments](https://doc.rust-lang.org/cargo/reference/build-scripts.html#rustc-link-arg).

The new native cancellation path applies to custom provider HTTP. Managed TalkEcho STT still uses its existing non-replayable Tauri invocation; frontend retry remains disabled for that path.

Raw audio is not persisted after final STT failure. Such a failure is surfaced as an untranscribed audio segment; transcript retention applies to successfully recognized text when downstream translation fails.

## Deterministic 30-minute simulation

Run from the repository root:

```powershell
npm test -- src/lib/functions/meeting-pipeline.test.ts
```

The test uses the production queue classes and generated PCM segments, advances a virtual clock, and controls provider service times. It is a scheduling/throughput experiment, not an ASR quality benchmark. The legacy harness reproduces the previous serial transcription and whole-batch handoff; the improved harness uses the production ordered pool and bounded queue. There are 450 segments, arriving every four seconds. Each STT call takes six seconds. Translation takes two seconds of request overhead plus two seconds per segment, with the existing 60-second total timeout.

| Metric | Previous pipeline | Updated pipeline |
| --- | ---: | ---: |
| Unfinished parts at meeting end | 241 | 2 |
| Largest translation request, segments | 136 | 1 |
| Simulated translation timeouts, batches | 5 | 0 |
| Additional time to finish known work | 960 s | 6 s |
| Successful translations, p95 latency from audio receipt | 238 s | 10 s |

The updated simulation retains and translates all 450 segments in order. The previous p95 includes only successful translations; failed batches are counted separately. The bounded-queue stress test additionally exercises 31 pending parts, promotes slices of at most five 80-token parts, and confirms every part is delivered exactly once. A deliberately slower translator (six seconds per segment) still accumulates backlog, but requests remain bounded and content drains in order after input stops. No queue design can keep up indefinitely when provider throughput is below incoming speech throughput.

## Provider and native error tests

```powershell
npm test -- src/lib/functions/meeting-provider.integration.test.ts
npm run test:native
```

The loopback provider tests use the production STT/AI functions and HTTP bridge adapter with a simulated Tauri bridge. They upload a generated 16 kHz WAV, receive streaming translation, reproduce STT and stream timeouts, exercise HTTP 429/503 recovery and permanent context-limit rejection, and cancel requests while native registration is pending. They verify that stream retries do not overlap and that the red error formatter identifies transcription versus translation.

The Rust tests independently run a stalled HTTP response on a real local TCP listener, cancel the native request, and assert that the server observes socket closure. A separate stalled-body test verifies that native response-read timeouts retain their timeout classification. They also test cancellation before the HTTP future starts and reject arbitrary diagnostic content fields.

`test:native` supplies the Windows test-only Common Controls manifest in its child process; the normal Tauri application continues using its existing embedded manifest.

These tests do not exercise actual microphone/loopback capture hardware, WebView layout, a paid provider, or the user's exact earlier error. No live meeting recording or provider credential is required.

## Checking an actual meeting

1. Run this branch with `npm run tauri dev`, or build an embedded frontend executable with `node node_modules/@tauri-apps/cli/tauri.js build --no-bundle`. Close other TalkEcho processes first to avoid duplicate capture/listeners.
2. Use the usual provider/model, system audio and microphone settings for a 20-30 minute meeting. Note the oldest-part age and estimated catch-up time.
3. Expand **Meeting diagnostics** in the meeting panel. Compare last STT, AI first-text, and AI total time. **Copy diagnostics** copies recent structured events and the actual native log location. Errors are kept in this panel even after the red status clears.
4. On this Windows installation the log directory is `%LOCALAPPDATA%\com.talkecho.desktop\logs`. The writer keeps `meeting.log` and a rotated `meeting.previous.log`, each about 1 MiB. Logs survive app closure. They contain timestamps, stage, provider/model identifiers, sizes, durations, retry attempts and error kinds/status codes; no audio, transcript, prompt, authorization header or provider response body.
5. STT `start` records audio bytes/duration and queue wait; STT `complete` records request duration and estimated transcript tokens. Translation `start` records estimated prompt/input tokens and wait, followed by `first_token`, `complete`, `retry` or `failure`. Pipeline `snapshot` records parts, estimated drain milliseconds and oldest-part age every 15 seconds while busy. Inspect timestamp order if concurrent log writes arrive out of order.
6. Growing STT queue wait with long STT service time points to transcription throughput. Fast STT plus growing translation wait points to generation throughput. Long first-text time with a small bounded input points to provider queueing, reasoning/model behavior, or transport; high completion time relative to first text points to generation/output length. HTTP 429 indicates provider rate limits; timeout/context_limit identify different remedies.

The next field validation should compare measured service times with arrival rate before choosing a faster STT/translation model or pursuing realtime transcription in #67. Increasing queue size, increasing timeouts, or merging indefinitely does not increase provider throughput.
