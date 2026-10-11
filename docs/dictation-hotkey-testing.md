# Windows dictation hotkey verification

The native keyboard hook listens while TalkEcho is running, independently of
window focus. Its callback updates per-press routing, snapshots Right Ctrl-only
event/foreground metadata and tries a bounded, nonblocking worker queue.
Window operations and WebView events are dispatched separately on the UI thread.
The native layer shows the window before emitting the recording event. A newly
loaded or resumed frontend reconciles against the native sequence number.

The hook message loop blocks in `GetMessageW`; it does not poll key state.
A Windows timer attempts renewal every 30 seconds, because Windows can silently
remove a hook after a timeout. Failed renewals retain the previous hook. Renewal
is deferred while a tracked physical/test press is held; moving to the head of
the hook chain between down/up could strand another hook's modifier state.
After release, renewal retries on the next timer event (up to 30 seconds later).

Each physical press chooses Consume or Forward on its first down. Repeats and
the matching up keep that choice, even if dispatch fails or recovers mid-press.
An up without an observed down passes through. A Ctrl held at startup is seeded
as forwarded when Windows reports it down. Normal/system key messages may mix.
Untagged software-injected Right Ctrl events pass through without toggling or
changing physical ownership; physical Right Ctrl dictation remains unchanged.
Keyboard macros that formerly injected Right Ctrl will no longer trigger it.

This does **not** prove physical release after a lost key-up. In particular, if
Windows removes the hook during an owned press and its release is missed,
renewal remains deferred. This is a known availability limitation of this draft,
not a solved sleep/recovery path. Do not merge/release on unit tests alone.
There is no synthetic Ctrl-up repair or timeout-based ownership reset: a zero
GetAsyncKeyState result/focus change is not safe evidence of physical release.
Startup querying and the observer below report Windows state only.

## Automated policy tests (no desktop input)

```powershell
npm run test:native
```

These cover normal/system/mixed edges, long repeat sequences, 50,000 sequential
presses with dispatch failures, orphan releases, startup-held routing, injected
events mixed with a physical hold, test/physical isolation and renewal deferral.
A competing-hook **model** demonstrates why reordering between down/up can
strand a modifier; it does not execute or reproduce mstsc. Focus is not used to
reset press ownership. No actual RDP session, sleep, lock or key injection occurs.

### Investigation run: 2026-10-11

- `npm run test:native`: 27 passed (14 routing-policy tests, including the
  50,000-press stress loop; other existing native tests also pass).
- `npm test`: 38 passed; existing meeting/provider coverage remains green.
- Both PowerShell scripts parse successfully; the read-only observer ran for
  one second and returned a Ctrl/foreground snapshot without input injection.
- No actual mstsc session was running during this investigation. No desktop
  smoke, physical keyboard, RDP, sleep, lock or installer tests were executed.
- Existing local dictation logs ended on September 20 and contain no per-edge
  routing data; they cannot establish the cause of the reported remote latch.

Confirmed by code: the old dispatch-failure path forwarded down but swallowed
the subsequent up. Hook renewal changing order during a press is a plausible
second mechanism, supported by a chain-order **model**, not an RDP reproduction.
The diagnostic build is for gathering that missing evidence, not declaring #70
closed. Consult Microsoft's [LowLevelKeyboardProc contract](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc),
[hook-chain ordering](https://learn.microsoft.com/en-us/windows/win32/winmsg/about-hooks)
and [GetAsyncKeyState limitations](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate).

## Release smoke test

Exit existing TalkEcho instances first. From the repository directory:

```powershell
$env:CARGO_BUILD_JOBS = '1'
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-dictation-hotkey.ps1 -ExecutablePath src-tauri/target/release/talkecho.exe -IdleSeconds 0
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-dictation-hotkey.ps1 -ExecutablePath src-tauri/target/release/talkecho.exe -IdleSeconds 35
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-dictation-hotkey.ps1 -ExecutablePath src-tauri/target/release/talkecho.exe -IdleSeconds 0 -HoldAcrossRenewal
```

The test launches and terminates only its own process. It explicitly enables
`TALKECHO_HOTKEY_TEST_INPUT=1` for that child and tags its synthetic events with
`0x54453730`; the environment is restored afterwards. Ordinary injected events
still bypass the hotkey. It verifies native popup, microphone initialization,
repeat suppression, Left Ctrl exclusion, injected bypass, paired release and (with
the idle interval) hidden-window startup and hook renewal. It never stops the
recording through the application, so no test audio is submitted to STT.
`-HoldAcrossRenewal` holds the tagged test key for 35 seconds and requires a
renewal-deferral diagnostic before releasing it (still no STT submission).
Do not type or use dictation during the test. Synthetic keys do not prove that
every physical keyboard or competing hook behaves identically.
This test temporarily injects desktop-wide keys and may show a recording HUD;
coordinate a quiet interval first. It is not safe to run over a user's active
RDP typing session. Cleanup only releases an unmatched test-owned down, not an
unconditional Ctrl-up.

## Issue #70: real RDP acceptance (not yet executed)

Run a Ctrl observer on **each computer**, independently (copy this script to the
remote server yourself; it does not connect remotely):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/watch-ctrl-state.ps1 -DurationSeconds 300
```

This only reads Left/Right Ctrl's Windows-reported states and foreground HWND/PID.
It does not install hooks, inject keys, read typed content/window titles, or
change focus. Optional `| Tee-Object -FilePath ctrl-local.csv` (or `ctrl-remote.csv`)
retains the output for comparison. A remote clock should be synchronized before
comparing timestamps. 100 ms polling can miss quick taps; use it to observe a
**latched** modifier, not to count every edge. Zero/up is inconclusive on secure
or inaccessible desktops. Local swallowed-down state may differ from hardware.

Keep unrelated keyboard-hook apps exited for the first pass. Record Windows and
TalkEcho versions, keyboard layout, mstsc keyboard setting (local/remote/fullscreen
only), privilege levels and competing apps. Do not share credentials or .rdp files.
Use a scratch remote document/browser, not an active production terminal. Speech
or stop-dictation tests may call your configured provider; agree on that first.

| Scenario | Procedure / expected result | Status |
| --- | --- | --- |
| Baseline | Fully exit TalkEcho; repeat Ctrl taps, scrolling and normal shortcuts | Pending |
| RDP windowed | Start diagnostic build; 20 physical down/up pairs; scroll after each | Pending |
| RDP fullscreen | Same, including fullscreen transitions while keys are released | Pending |
| Long hold | Hold Right Ctrl across a 30 s renewal tick; one toggle, deferred renewal, normal release | Pending |
| Rapid pairs | Repeat fast press/release in a scratch context; no latched remote Ctrl | Pending |
| Focus during hold | Down in RDP, switch focus, release; then reverse direction | Pending |
| Both Ctrl keys | Hold Left Ctrl, tap Right Ctrl, release separately; never release Left Ctrl implicitly | Pending |
| Already held | Start TalkEcho while Right Ctrl is held; no toggle until next complete press | Pending |
| Lock / unlock | Release all keys; lock/unlock; compare states and first dictation press | Pending |
| Sleep / resume | Release all keys; manually sleep/resume; repeat. Separately investigate a hold across sleep only in a safe session | Pending |
| Competing hooks | Repeat with Typeless/other hook apps, started both before and after TalkEcho | Pending |
| Installed build | Repeat passing scenarios with an installed test package | Pending |

Do not automate lock, sleep, disconnect or focus stealing on a working machine.
If stuck, **before attempting the two-press workaround**, record the UTC time,
local/remote reported states, whether the HUD took focus and both dictation logs.
The observer cannot establish what mstsc sent over the wire. A discrepancy can
narrow the failure location but does not by itself identify the responsible app.

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
Right Ctrl message/time/scan/flags, Physical/Injected/Test source, Down/Repeat/Up/
OrphanUp edge, Consume/Forward decision, state before/after, foreground HWND/PID,
hook generation, installation/renewal/deferral, native toggle/show, frontend sync and
recording start. Logs rotate at approximately 1 MiB, retaining one previous file.
Persistent logs exclude transcripts, audio, prompts, other typed keys, window
titles and credentials. Queue pressure drops work instead of blocking a hook;
new presses fail open as whole pairs. A dropped-work message means the event
trace may be incomplete: do not infer a missing up solely from that trace.

No `toggle` after a press points to the input/hook path. A native show with no
frontend progress points to the WebView/startup path. A recording milestone means
the hotkey succeeded; subsequent transcription failures are a separate stage.

The application must actually be running. Windows lock/UAC secure desktops,
another application swallowing the key, a crashed process or resource exhaustion
are not covered by an unconditional hotkey guarantee.
