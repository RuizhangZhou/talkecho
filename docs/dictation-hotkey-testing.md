# Windows dictation hotkey verification

The native keyboard hook listens while TalkEcho is running, independently of
window focus. Its callback only updates the held-key state and queues a message.
Window operations and WebView events are dispatched separately on the UI thread.
The native layer shows the window before emitting the recording event. A newly
loaded or resumed frontend reconciles against the native sequence number.

The hook message loop blocks in `GetMessageW`; it does not poll key state.
A Windows timer renews the hook every 30 seconds, because Windows can silently
remove a hook after a timeout. Failed renewals retain the previous hook and retry
on the next timer event. This is bounded recovery, not a guarantee that a press
inside a hook-outage interval will be captured.

## Release smoke test

Exit existing TalkEcho instances first. From the repository directory:

```powershell
$env:CARGO_BUILD_JOBS = '1'
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-dictation-hotkey.ps1 -ExecutablePath src-tauri/target/release/talkecho.exe -IdleSeconds 0
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-dictation-hotkey.ps1 -ExecutablePath src-tauri/target/release/talkecho.exe -IdleSeconds 35
```

The test launches and terminates only its own process. It verifies native popup,
microphone initialization, repeat suppression, Left Ctrl exclusion, and (with
the idle interval) hidden-window startup and hook renewal. It never stops the
recording through the application, so no test audio is submitted to STT.
Do not type or use dictation during the test. Synthetic keys do not prove that
every physical keyboard or competing hook behaves identically.

## Physical-key acceptance

Use the built release executable, then repeat with the installed package:

- Press and release Right Ctrl to start; press and release again to stop.
- Hold Right Ctrl: it must start once, not toggle repeatedly.
- Hide the dashboard and switch to another normal desktop application; repeat.
- Leave the app idle for several minutes; repeat.
- Lock/unlock and sleep/resume Windows; repeat after returning to the desktop.
- Check with Typeless both running and exited.
- Copy a result and immediately begin another recording; the delayed close must
  not hide the new recording.

Check `%LOCALAPPDATA%\com.talkecho.desktop\logs\dictation.log` for the process ID,
hook installation/renewal, native toggle, native show, frontend state sync and
recording start. Logs rotate at approximately 1 MiB, retaining one previous file.
Persistent logs exclude transcripts, audio, prompts and credentials.

No `toggle` after a press points to the input/hook path. A native show with no
frontend progress points to the WebView/startup path. A recording milestone means
the hotkey succeeded; subsequent transcription failures are a separate stage.

The application must actually be running. Windows lock/UAC secure desktops,
another application swallowing the key, a crashed process or resource exhaustion
are not covered by an unconditional hotkey guarantee.
