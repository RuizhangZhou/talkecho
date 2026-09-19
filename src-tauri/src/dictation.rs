// "Press Right Ctrl to toggle dictation" feature.
//
// Currently implemented for Windows only: a dedicated OS thread installs a
// low-level keyboard hook (WH_KEYBOARD_LL), watches for the Right Ctrl key's
// press edge (ignoring OS key-repeat and the matching key-up), and toggles
// dictation on/off. The toggle is broadcast to the frontend as a
// `dictation://toggle` event; recording, transcription, and cleanup all
// happen in the webview, which then asks Rust to type the result into
// whatever control currently has focus.
//
// Other platforms get inert stubs so the commands stay registered everywhere
// and the frontend can detect lack of support via the returned error.

use tauri::AppHandle;

const DICTATION_WINDOW_LABEL: &str = "dictation";
const DICTATION_WINDOW_WIDTH: f64 = 360.0;
const DICTATION_WINDOW_HEIGHT: f64 = 140.0;

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};

    use enigo::{Enigo, Keyboard, Settings as EnigoSettings};
    use serde::Serialize;
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, KillTimer, SetTimer, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
        WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
    };

    const VK_CONTROL: u32 = 0x11;
    const VK_RCONTROL: u32 = 0xA3;
    // Some keyboard drivers report Right Ctrl as generic Ctrl with this flag
    // rather than using VK_RCONTROL.
    const LLKHF_EXTENDED: u32 = 0x01;

    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
    // One atomic snapshot: odd sequences are recording, even sequences stopped.
    static DICTATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    static RCTRL_HELD: AtomicBool = AtomicBool::new(false);
    static WORKER: OnceLock<mpsc::Sender<HotkeyWork>> = OnceLock::new();
    static LOG_LOCK: Mutex<()> = Mutex::new(());
    const HOOK_REFRESH_MS: u32 = 30_000;

    enum HotkeyWork {
        Toggle,
        Diagnostic(String),
    }

    // Never call this from the keyboard callback: even stderr/file I/O can block.
    pub fn diagnostic(message: &str) {
        eprintln!("[dictation] {message}");
        let Some(app) = APP_HANDLE.get() else { return };
        let Ok(directory) = app.path().app_log_dir() else {
            return;
        };
        let Ok(_guard) = LOG_LOCK.lock() else { return };
        if std::fs::create_dir_all(&directory).is_err() {
            return;
        }
        let path = directory.join("dictation.log");
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 1_048_576) {
            let backup = directory.join("dictation.previous.log");
            let _ = std::fs::remove_file(&backup);
            let _ = std::fs::rename(&path, backup);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let _ = writeln!(file, "{now} pid={} {message}", std::process::id());
        }
    }

    fn right_ctrl_transition(held: bool, msg: u32) -> (bool, bool) {
        match msg {
            WM_KEYDOWN | WM_SYSKEYDOWN => (true, !held),
            WM_KEYUP | WM_SYSKEYUP => (false, false),
            _ => (held, false),
        }
    }

    fn is_right_ctrl(vk_code: u32, flags: u32) -> bool {
        vk_code == VK_RCONTROL || (vk_code == VK_CONTROL && flags & LLKHF_EXTENDED != 0)
    }

    #[derive(Clone, Serialize)]
    pub struct DictationTogglePayload {
        active: bool,
        sequence: u64,
    }

    impl DictationTogglePayload {
        fn from_sequence(sequence: u64) -> Self {
            Self {
                active: sequence % 2 == 1,
                sequence,
            }
        }

        fn permits_hide(&self, expected_sequence: Option<u64>) -> bool {
            !self.active && expected_sequence.is_none_or(|sequence| sequence == self.sequence)
        }
    }

    unsafe extern "system" fn keyboard_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);

            if is_right_ctrl(info.vkCode, info.flags.0) {
                let held = RCTRL_HELD.load(Ordering::SeqCst);
                let (next_held, should_toggle) = right_ctrl_transition(held, msg);
                RCTRL_HELD.store(next_held, Ordering::SeqCst);

                if should_toggle {
                    // No WebView calls, logging, or window operations on the hook
                    // thread. Windows silently removes hooks that take too long.
                    if WORKER
                        .get()
                        .is_none_or(|worker| worker.send(HotkeyWork::Toggle).is_err())
                    {
                        return CallNextHookEx(None, code, wparam, lparam);
                    }
                }

                // Right Ctrl is reserved for TalkEcho while it is running. Do
                // not forward it to the focused application.
                return LRESULT(1);
            }
        }

        CallNextHookEx(None, code, wparam, lparam)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn right_ctrl_toggles_once_per_press_for_system_messages() {
            let (held, toggle) = right_ctrl_transition(false, WM_SYSKEYDOWN);
            assert!(held);
            assert!(toggle);

            let (held, toggle) = right_ctrl_transition(held, WM_SYSKEYDOWN);
            assert!(held);
            assert!(!toggle, "key repeat must not toggle dictation");

            let (held, toggle) = right_ctrl_transition(held, WM_SYSKEYUP);
            assert!(!held);
            assert!(!toggle);

            let (held, toggle) = right_ctrl_transition(held, WM_SYSKEYDOWN);
            assert!(held);
            assert!(toggle, "the next physical press must toggle again");
        }

        #[test]
        fn right_ctrl_accepts_mixed_normal_and_system_messages() {
            let (held, toggle) = right_ctrl_transition(false, WM_KEYDOWN);
            assert!(held);
            assert!(toggle);

            let (held, toggle) = right_ctrl_transition(held, WM_KEYUP);
            assert!(!held);
            assert!(!toggle);

            let (held, toggle) = right_ctrl_transition(held, WM_SYSKEYDOWN);
            assert!(held);
            assert!(toggle);
        }

        #[test]
        fn recognizes_both_windows_right_ctrl_representations() {
            assert!(is_right_ctrl(VK_RCONTROL, 0));
            assert!(is_right_ctrl(VK_CONTROL, LLKHF_EXTENDED));
            assert!(
                !is_right_ctrl(VK_CONTROL, 0),
                "Left Ctrl must remain unused"
            );
        }

        #[test]
        fn delayed_close_cannot_hide_a_new_recording_or_its_result() {
            assert!(DictationTogglePayload::from_sequence(0).permits_hide(Some(0)));
            assert!(!DictationTogglePayload::from_sequence(1).permits_hide(Some(0)));
            assert!(!DictationTogglePayload::from_sequence(1).permits_hide(None));
            assert!(DictationTogglePayload::from_sequence(2).permits_hide(Some(2)));
            assert!(!DictationTogglePayload::from_sequence(4).permits_hide(Some(2)));
        }
    }

    fn toggle_dictation() {
        let sequence = DICTATION_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
        let active = sequence % 2 == 1;
        diagnostic(&format!("toggle -> active={active} sequence={sequence}"));
        match APP_HANDLE.get() {
            Some(app) => {
                // Wake the native window BEFORE relying on its hidden WebView.
                // Also wakes a minimized/suspended window and recreates a closed one.
                if active {
                    if let Err(e) = show_dictation_window(app.clone()) {
                        diagnostic(&format!("native show failed: {e}"));
                    }
                }
                if let Err(e) = app.emit_to(
                    DICTATION_WINDOW_LABEL,
                    "dictation://toggle",
                    DictationTogglePayload { active, sequence },
                ) {
                    diagnostic(&format!("failed to emit toggle event: {e}"));
                }
            }
            None => eprintln!("[dictation] APP_HANDLE not set yet"),
        }
    }

    /// Installs the Right Ctrl low-level keyboard hook on a dedicated thread
    /// with its own message loop (required by `WH_KEYBOARD_LL`).
    pub fn start_hotkey_listener(app: &AppHandle) {
        let _ = APP_HANDLE.set(app.clone());
        let (sender, receiver) = mpsc::channel();
        if WORKER.set(sender).is_err() {
            return;
        }
        diagnostic(&format!(
            "starting version={} debug={}",
            env!("CARGO_PKG_VERSION"),
            cfg!(debug_assertions)
        ));

        // Serial dispatch preserves physical press order. Window creation must
        // run on the UI thread, never in the low-level hook or its message pump.
        let app = app.clone();
        std::thread::spawn(move || {
            for work in receiver {
                match work {
                    HotkeyWork::Toggle => {
                        if let Err(error) = app.run_on_main_thread(toggle_dictation) {
                            diagnostic(&format!("hotkey dispatch failed: {error}"));
                        }
                    }
                    HotkeyWork::Diagnostic(message) => diagnostic(&message),
                }
            }
        });

        std::thread::spawn(|| unsafe {
            let report = |message: String| {
                if let Some(worker) = WORKER.get() {
                    let _ = worker.send(HotkeyWork::Diagnostic(message));
                }
            };
            let install =
                || match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), None, 0) {
                    Ok(hook) => Some(hook),
                    Err(error) => {
                        report(format!("hook installation failed: {error}"));
                        None
                    }
                };
            let mut hook = install();
            report(format!("keyboard hook installed={}", hook.is_some()));
            // Windows provides no notification when it removes a timed-out hook.
            // Renew twice per minute, including after sleep, and retry failures.
            // This does NOT poll keys; GetMessage blocks between OS events.
            let timer = SetTimer(None, 0, HOOK_REFRESH_MS, None);
            if timer == 0 {
                report("hook recovery timer failed".into());
            }
            let mut msg = MSG::default();
            loop {
                let result = GetMessageW(&mut msg, None, 0, 0).0;
                if result <= 0 {
                    report(format!("hook message loop exited: {result}"));
                    break;
                }
                if msg.message == WM_TIMER && msg.wParam.0 == timer {
                    // Install first: if renewal fails, retain the previous hook.
                    if let Some(next) = install() {
                        if let Some(previous) = hook.replace(next) {
                            let _ = UnhookWindowsHookEx(previous);
                        }
                        report("keyboard hook renewed".into());
                    }
                    continue;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if timer != 0 {
                let _ = KillTimer(None, timer);
            }
            if let Some(hook) = hook {
                let _ = UnhookWindowsHookEx(hook);
            }
        });
    }

    /// Types `text` into whatever control currently has OS focus by simulating
    /// keystrokes via SendInput (Unicode-safe). This is the "direct injection"
    /// path; the frontend falls back to a copy-to-clipboard UI if it errors.
    pub fn inject_text(text: String) -> Result<(), String> {
        let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|e| e.to_string())?;
        enigo.text(&text).map_err(|e| e.to_string())
    }

    // A window created with `.visible(false)` never gets its WebView2
    // controller initialized on Windows, so its JS (and the
    // `dictation://toggle` listener) never runs. Instead, create it visible
    // but parked off-screen so the webview loads immediately; showing/hiding
    // it later just repositions + shows/hides the already-loaded window.
    const OFFSCREEN_X: i32 = -10000;
    const OFFSCREEN_Y: i32 = -10000;

    fn create_dictation_window(app: &AppHandle) -> Result<(), tauri::Error> {
        WebviewWindowBuilder::new(
            app,
            DICTATION_WINDOW_LABEL,
            WebviewUrl::App("index.html#/dictation".into()),
        )
        .title("TalkEcho Dictation")
        .inner_size(DICTATION_WINDOW_WIDTH, DICTATION_WINDOW_HEIGHT)
        .position(OFFSCREEN_X as f64, OFFSCREEN_Y as f64)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focusable(true)
        .focused(false)
        .shadow(false)
        .visible(true)
        // Do not hide at PageLoadEvent::Finished: React may not have registered
        // its listener yet. The frontend hides only after state synchronization.
        .build()?;
        Ok(())
    }

    pub fn get_state() -> DictationTogglePayload {
        let sequence = DICTATION_SEQUENCE.load(Ordering::SeqCst);
        DictationTogglePayload::from_sequence(sequence)
    }

    /// Creates the dictation window (parked off-screen) at app startup if it
    /// doesn't exist yet. It must exist before the first hotkey press so its
    /// webview is already loaded and listening for `dictation://toggle`.
    pub fn init_window(app: &AppHandle) {
        if app.get_webview_window(DICTATION_WINDOW_LABEL).is_none() {
            match create_dictation_window(app) {
                Ok(()) => eprintln!("[dictation] dictation window created at startup"),
                Err(e) => {
                    eprintln!("[dictation] Failed to create dictation window on startup: {e}")
                }
            }
        } else {
            eprintln!("[dictation] dictation window already exists at startup");
        }
    }

    /// Shows the small floating dictation window, positioned near the
    /// bottom-center of the primary monitor.
    pub fn show_dictation_window(app: AppHandle) -> Result<(), String> {
        diagnostic("show window requested");
        let window = match app.get_webview_window(DICTATION_WINDOW_LABEL) {
            Some(window) => window,
            None => {
                create_dictation_window(&app).map_err(|e| e.to_string())?;
                app.get_webview_window(DICTATION_WINDOW_LABEL)
                    .ok_or("Failed to create dictation window")?
            }
        };

        if let Ok(Some(monitor)) = window.primary_monitor() {
            let size = monitor.size();
            let monitor_position = monitor.position();
            let scale = monitor.scale_factor();
            let win_w = (DICTATION_WINDOW_WIDTH * scale) as i32;
            let win_h = (DICTATION_WINDOW_HEIGHT * scale) as i32;
            let x = monitor_position.x + (size.width as i32 - win_w) / 2;
            let y = monitor_position.y + size.height as i32 - win_h - (40.0 * scale) as i32;
            let _ =
                window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        }

        // Transparent windows can inherit click-through state from a previous
        // overlay configuration on Windows. Dictation must remain mouse
        // interactive so users can copy or dismiss its result, while avoiding
        // an explicit focus change that would steal the target text field.
        let _ = window.set_ignore_cursor_events(false);
        let _ = window.set_focusable(true);
        // Reassert TOPMOST every time the transient HUD is shown. This keeps
        // it above normal application windows after hide/show, sleep/resume,
        // and Z-order changes while leaving focus in the user's target app.
        let _ = window.set_always_on_top(true);
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        diagnostic("native window shown");
        Ok(())
    }

    pub fn hide_dictation_window(
        app: AppHandle,
        expected_sequence: Option<u64>,
    ) -> Result<(), String> {
        let state = get_state();
        if !state.permits_hide(expected_sequence) {
            diagnostic("ignored stale hide request");
            return Ok(());
        }
        if let Some(window) = app.get_webview_window(DICTATION_WINDOW_LABEL) {
            window.hide().map_err(|e| e.to_string())?;
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: OFFSCREEN_X,
                y: OFFSCREEN_Y,
            }));
        }
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod stub_impl {
    use super::*;

    #[derive(serde::Serialize)]
    pub struct DictationTogglePayload {
        active: bool,
        sequence: u64,
    }

    const UNSUPPORTED: &str = "Dictation hotkey/injection is currently only implemented on Windows";

    pub fn start_hotkey_listener(_app: &AppHandle) {
        eprintln!("{UNSUPPORTED} — skipping hotkey listener setup");
    }

    pub fn init_window(_app: &AppHandle) {}

    pub fn inject_text(_text: String) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn show_dictation_window(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn hide_dictation_window(
        _app: AppHandle,
        _expected_sequence: Option<u64>,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn get_state() -> DictationTogglePayload {
        DictationTogglePayload {
            active: false,
            sequence: 0,
        }
    }
}

#[cfg(not(target_os = "windows"))]
use stub_impl as platform;
#[cfg(target_os = "windows")]
use windows_impl as platform;

/// Installs the global Right Ctrl toggle listener. Call once at app startup.
pub fn start_hotkey_listener(app: &AppHandle) {
    platform::start_hotkey_listener(app);
}

/// Creates the (hidden) dictation window so it exists before the first
/// hotkey toggle arrives. Call once at app startup.
pub fn init_window(app: &AppHandle) {
    platform::init_window(app);
}

#[tauri::command]
pub fn inject_text(text: String) -> Result<(), String> {
    platform::inject_text(text)
}

#[tauri::command]
pub fn show_dictation_window(app: AppHandle) -> Result<(), String> {
    platform::show_dictation_window(app)
}

#[tauri::command]
pub fn hide_dictation_window(app: AppHandle, expected_sequence: Option<u64>) -> Result<(), String> {
    platform::hide_dictation_window(app, expected_sequence)
}

#[tauri::command]
pub fn get_dictation_state() -> impl serde::Serialize {
    #[cfg(target_os = "windows")]
    windows_impl::diagnostic("frontend synchronizing state");
    platform::get_state()
}

// TEMPORARY DEBUG: lets the dictation window's webview (which has no visible
// devtools) report progress to the same terminal as the Rust logs.
#[tauri::command]
pub fn dictation_debug_log(message: String) {
    // Persist only lifecycle metadata, never transcripts, prompts or credentials.
    #[cfg(target_os = "windows")]
    if message.starts_with("useDictation:")
        || message == "startRecording: requesting getUserMedia..."
        || message == "startRecording: getUserMedia resolved"
        || message == "startRecording: status set to 'recording'"
    {
        windows_impl::diagnostic(&format!("frontend: {message}"));
        return;
    }
    #[cfg(debug_assertions)]
    eprintln!("[dictation][js] {message}");
}
