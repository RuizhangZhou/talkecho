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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use enigo::{Enigo, Keyboard, Settings as EnigoSettings};
    use serde::Serialize;
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const VK_RCONTROL: u32 = 0xA3;

    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
    static DICTATION_ACTIVE: AtomicBool = AtomicBool::new(false);
    static RCTRL_HELD: AtomicBool = AtomicBool::new(false);

    fn right_ctrl_transition(held: bool, msg: u32) -> (bool, bool) {
        match msg {
            WM_KEYDOWN | WM_SYSKEYDOWN => (true, !held),
            WM_KEYUP | WM_SYSKEYUP => (false, false),
            _ => (held, false),
        }
    }

    #[derive(Clone, Serialize)]
    struct DictationTogglePayload {
        active: bool,
    }

    unsafe extern "system" fn keyboard_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);

            // TEMPORARY DEBUG: log Right Ctrl events while the feature is in beta.
            if info.vkCode == VK_RCONTROL {
                eprintln!(
                    "[dictation] hook saw vkCode=0x{:X} msg=0x{:X}",
                    info.vkCode, msg
                );
            }

            if info.vkCode == VK_RCONTROL {
                let held = RCTRL_HELD.load(Ordering::SeqCst);
                let (next_held, should_toggle) = right_ctrl_transition(held, msg);
                RCTRL_HELD.store(next_held, Ordering::SeqCst);

                if should_toggle {
                    toggle_dictation();
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
    }

    fn toggle_dictation() {
        let active = !DICTATION_ACTIVE.fetch_xor(true, Ordering::SeqCst);
        eprintln!("[dictation] toggle -> active={active}");
        match APP_HANDLE.get() {
            Some(app) => {
                if let Err(e) = app.emit("dictation://toggle", DictationTogglePayload { active }) {
                    eprintln!("[dictation] failed to emit toggle event: {e}");
                }
            }
            None => eprintln!("[dictation] APP_HANDLE not set yet"),
        }
    }

    /// Installs the Right Ctrl low-level keyboard hook on a dedicated thread
    /// with its own message loop (required by `WH_KEYBOARD_LL`).
    pub fn start_hotkey_listener(app: &AppHandle) {
        let _ = APP_HANDLE.set(app.clone());

        std::thread::spawn(|| unsafe {
            eprintln!("[dictation] hotkey listener thread starting, installing hook...");
            let hook: HHOOK =
                match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), None, 0) {
                    Ok(hook) => {
                        eprintln!("[dictation] keyboard hook installed successfully");
                        hook
                    }
                    Err(err) => {
                        eprintln!("[dictation] Failed to install dictation keyboard hook: {err}");
                        return;
                    }
                };

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            eprintln!("[dictation] message loop exited, unhooking");
            let _ = UnhookWindowsHookEx(hook);
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
        .focused(false)
        .shadow(false)
        .visible(true)
        .build()?;
        Ok(())
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
        eprintln!("[dictation] show_dictation_window invoked from frontend");
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
            let scale = monitor.scale_factor();
            let win_w = (DICTATION_WINDOW_WIDTH * scale) as i32;
            let win_h = (DICTATION_WINDOW_HEIGHT * scale) as i32;
            let x = (size.width as i32 - win_w) / 2;
            let y = size.height as i32 - win_h - (40.0 * scale) as i32;
            let _ =
                window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        }

        window.show().map_err(|e| e.to_string())
    }

    pub fn hide_dictation_window(app: AppHandle) -> Result<(), String> {
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

    pub fn hide_dictation_window(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
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
pub fn hide_dictation_window(app: AppHandle) -> Result<(), String> {
    platform::hide_dictation_window(app)
}

// TEMPORARY DEBUG: lets the dictation window's webview (which has no visible
// devtools) report progress to the same terminal as the Rust logs.
#[tauri::command]
pub fn dictation_debug_log(message: String) {
    eprintln!("[dictation][js] {message}");
}
