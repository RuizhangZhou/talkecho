# TalkEcho

_Invisible real-time meeting subtitles & translation assistant — with all features enabled by default (forked from [Pluely](https://github.com/iamsrikanthnani/pluely))._

TalkEcho runs as a translucent desktop overlay that captures both system audio and microphone input, streams them to the speech-to-text / LLM providers you choose, and returns bilingual captions without tipping anyone off.

**No membership / paywall:** this fork keeps the “small Pro features” enabled out of the box. Just bring your own API keys and run it locally.

---

## What is TalkEcho?

- **Desktop floating window** – always-on-top glass panel that follows your cursor shortcuts but never appears on screen shares.
- **Dual audio capture** – mixes the app/mic audio so you see both sides of the conversation.
- **Bring-your-own providers** – configure Groq, OpenAI, Anthropic, Ollama, or any curl-based API for STT + completion.
- **Opinionated defaults** – prefilled prompts target "DE -> ZH/EN" translation for recruiting / sales meetings; swap to your own flows anytime.

## Key Features

- **Invisible overlay** – adjustable transparency, keyboard-driven focus, no dock/taskbar icon when stealth mode is enabled.
- **Dual audio (system + mic)** – simultaneous capture so the AI hears remote participants and you.
- **Real-time translation** – default prompt streams Whisper transcripts into your chosen LLM for bilingual subtitles.
- **Bring-your-own AI keys** – Groq, OpenAI, Anthropic, Perplexity, xAI, local Ollama… anything that exposes a curl command.
- **Screenshot & Q&A helpers** – capture full screen or selection, auto-send to your prompt for quick summaries.
- **Dictation (Windows, beta)** – press `Right Ctrl` anywhere to talk; TalkEcho transcribes, strips filler words/repetition with a fast LLM cleanup pass, and types the result wherever your cursor is. See [Dictation mode](#dictation-mode-windows-beta) below.

## Download

| Platform | Status |
| --- | --- |
| Windows | Download the latest `.msi` or `.exe` from [GitHub Releases](https://github.com/ruizhangzhou/talkecho/releases). |
| macOS | Coming soon - contributions welcome! |
| Linux | Coming soon - contributions welcome! |

Want to build from source or hack on TalkEcho instead? See [Local development](#local-development) below.

## Configuration (Groq Example)

Provider setup now lives in **TalkEcho -> Dev Space**, where every AI/STT provider is defined as a curl command (so you can point TalkEcho at literally any REST API). The translation overlay, dictation cleanup pass, and meeting captions all reuse the same provider list — pick whichever model fits each job from the dropdowns where they're used.

1. **Create a Groq account** at [console.groq.com](https://console.groq.com) and generate an API key.
2. **Open TalkEcho -> Dev Space -> AI Providers** and add Groq Llama (e.g. `llama-3.1-8b-instant` for fast responses):
   - Provider: paste a curl for the chat/completions endpoint using `{{TEXT}}`, `{{SYSTEM_PROMPT}}` placeholders.
   - API key: paste the value into the provider variables.
   - Select it as your **AI Provider** wherever a model picker appears (overlay translation, dictation cleanup, etc.).
3. **Add a Speech-to-Text provider** in **Dev Space -> STT Providers**:
   - Paste a curl for Groq Whisper (or any other STT API) and select it as your **STT Provider**.
   - Then pick your audio devices ("System audio" + "Microphone") inside Audio Settings.
4. **Before the meeting**:
   - Press `Ctrl+Shift+M` to enable system-audio capture.
   - Press `Ctrl+Shift+A` to enable mic capture.
   - Pick the "DE -> ZH/EN translation" preset in the overlay prompt switcher.
5. **During the meeting**:
   - Use `Ctrl+\` to focus the overlay.
   - Hit `Enter` to send transcripts to your provider-captions stream back instantly.

> Want another stack? Duplicate the provider entries with OpenAI, Anthropic, Groq LPU, or your own Ollama endpoint. TalkEcho only needs a curl you control — no hardcoded model list to fight with.

## Dictation mode (Windows, beta)

A Typeless/Wispr-Flow-style "speak instead of type" mode that works system-wide, separate from the meeting overlay:

1. Configure an **STT provider** and an **AI provider** in Dev Space (see above) — dictation reuses both. Pick a fast model for cleanup; small, non-reasoning instruction models (e.g. Groq + Llama 3.1 8B) work best here since speed matters more than perfect accuracy.
2. Press **Right Ctrl** anywhere on your system to start talking, and press it again to stop.
3. TalkEcho transcribes your speech, runs a narrow-scope LLM pass that strips filler words ("um", "uh"), collapses repetition/false starts, and fixes punctuation — without changing your meaning or wording.
4. The cleaned text is typed directly into whatever field has focus. A small floating window also shows the result with a copy button as a fallback (and stays visible briefly if direct insertion isn't possible).

This is an early, Windows-only beta — macOS/Linux support (and the underlying OS permissions/text-injection work they require) is planned for a later release.
While TalkEcho is running, it reserves **Right Ctrl** for dictation and does not forward that key to other applications. **Right Alt** remains available for Typeless and AltGr input.

## Local development

Prerequisites: `Node 18+`, `Rust stable`, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/ruizhangzhou/talkecho.git
cd talkecho
npm install
npm run tauri dev
```

This starts the Vite dev server and launches the Tauri shell with hot-reload. Useful related scripts: `npm run dev` (frontend only, in a browser — native/Tauri APIs won't work), `npm run build` (typecheck + production frontend bundle), `npm run tauri build` (full desktop installer).

## Privacy

- TalkEcho stores conversations locally (SQLite + localStorage).
- Audio/text is only sent to the STT/LLM providers you configure; there is **no TalkEcho cloud**.
- There is no telemetry, crash reporting, or hidden analytics. Logs stay on your machine and redact API keys.
- Source code for every binary you distribute must remain available because TalkEcho is GPL-3.0 (original license preserved).

## Credits

TalkEcho is a community fork of [Pluely](https://github.com/iamsrikanthnani/pluely) by Srikanth Nani. Original copyright notices stay in `LICENSE`, and additional changes are credited in `NOTICE`. Massive thanks to the Pluely maintainers for the stealth desktop foundation.

---

Need help? Open an issue or ping `ruizhang.zhou@mail.com`.



