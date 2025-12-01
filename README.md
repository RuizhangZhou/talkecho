# TalkEcho

_Invisible real-time meeting subtitles & translation assistant (forked from [Pluely](https://github.com/iamsrikanthnani/pluely))._

TalkEcho runs as a translucent desktop overlay that captures both system audio and microphone input, streams them to the speech-to-text / LLM providers you choose, and returns bilingual captions without tipping anyone off.

---

## What is TalkEcho?

- **Desktop floating window** – always-on-top glass panel that follows your cursor shortcuts but never appears on screen shares.
- **Dual audio capture** – mixes the app/mic audio so you see both sides of the conversation.
- **Bring-your-own providers** – configure Groq, OpenAI, Anthropic, Ollama, or any curl-based API for STT + completion.
- **Opinionated defaults** – prefilled prompts target "DE -> ZH/EN" translation for recruiting / sales meetings; swap to your own flows anytime.

## Key Features

- **Invisible overlay** – adjustable transparency, keyboard-driven focus, no dock/taskbar icon when stealth mode is enabled.
- **Dual audio (system + mic)** – simultaneous capture so the AI hears remote participants and you.
- **Real-time translation** – default prompt streams Whisper transcripts into Groq Llama-3.1 (or your provider) for bilingual subtitles.
- **Bring-your-own AI keys** – Groq, OpenAI, Anthropic, Perplexity, xAI, local Ollama… anything that exposes a curl command.
- **Screenshot & Q&A helpers** – capture full screen or selection, auto-send to your prompt for quick summaries.

## Download

| Platform | Status |
| --- | --- |
| Windows | Download the latest `.msi` or `.exe` from [GitHub Releases](https://github.com/ruizhangzhou/talkecho/releases). |
| macOS | Coming soon - contributions welcome! |
| Linux | Coming soon - contributions welcome! |

1. Install dependencies (`Node 18+`, `Rust stable`, [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).
2. Clone and run `npm install && npm run tauri dev` for local builds.

## Configuration (Groq Example)

1. **Create a Groq account** at [console.groq.com](https://console.groq.com) and generate an API key.
2. **Open TalkEcho -> Settings -> AI Providers** and add Groq Llama-3.1:
   - Provider: REST / custom.
   - Curl: Groq chat/completions endpoint using `{{TEXT}}`, `{{SYSTEM_PROMPT}}` placeholders.
   - API key: paste the value into the provider variables.
3. **Set Speech-to-Text** in Settings -> STT Providers:
   - Choose Groq Whisper or paste a curl for another provider.
   - Select "System audio" + "Microphone" devices inside Audio Settings.
4. **Before the meeting**:
   - Press `Ctrl+Shift+M` to enable system-audio capture.
   - Press `Ctrl+Shift+A` to enable mic capture.
   - Pick the "DE -> ZH/EN translation" preset in the overlay prompt switcher.
5. **During the meeting**:
   - Use `Ctrl+\` to focus the overlay.
   - Hit `Enter` to send transcripts to your provider-captions stream back instantly.

> Want another stack? Duplicate the provider entries with OpenAI, Anthropic, Groq LPU, or your own Ollama endpoint. TalkEcho only needs a curl you control.

## Privacy

- TalkEcho stores conversations locally (SQLite + localStorage).
- Audio/text is only sent to the STT/LLM providers you configure; there is **no TalkEcho cloud**.
- There is no telemetry, crash reporting, or hidden analytics. Logs stay on your machine and redact API keys.
- Source code for every binary you distribute must remain available because TalkEcho is GPL-3.0 (original license preserved).

## Credits

TalkEcho is a community fork of [Pluely](https://github.com/iamsrikanthnani/pluely) by Srikanth Nani. Original copyright notices stay in `LICENSE`, and additional changes are credited in `NOTICE`. Massive thanks to the Pluely maintainers for the stealth desktop foundation.

---

Need help? Open an issue or ping `ruizhang.zhou@mail.com`.



