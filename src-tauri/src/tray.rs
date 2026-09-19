//! Native system tray support.
//!
//! The tray owns the background-app lifecycle on Windows: hiding the compact
//! recording bar leaves its webview alive, so recording and global shortcuts
//! continue to work until the user explicitly chooses Quit.

use tauri::AppHandle;

const TRAY_ID: &str = "talkecho-tray";
const READY_TOOLTIP: &str = "TalkEcho — ready";
const RECORDING_TOOLTIP: &str = "TalkEcho — recording";

#[cfg(target_os = "windows")]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(target_os = "windows")]
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(
        app,
        "toggle-main-bar",
        "Show / Hide TalkEcho",
        true,
        None::<&str>,
    )?;
    let dashboard = MenuItem::with_id(app, "open-dashboard", "Open Dashboard", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TalkEcho", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &dashboard, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("application icon".into()))?
        .clone();

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(READY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle-main-bar" => {
                if let Err(error) = crate::window::toggle_main_bar(app) {
                    eprintln!("Failed to toggle main bar from tray: {error}");
                }
            }
            "open-dashboard" => {
                if let Err(error) = crate::window::open_dashboard(app.clone()) {
                    eprintln!("Failed to open dashboard from tray: {error}");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = crate::window::toggle_main_bar(&tray.app_handle()) {
                    eprintln!("Failed to toggle main bar from tray click: {error}");
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn setup(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
pub fn set_recording_state(app: AppHandle, recording: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let tray = app
            .tray_by_id(TRAY_ID)
            .ok_or("TalkEcho tray icon is unavailable")?;
        tray.set_tooltip(Some(if recording {
            RECORDING_TOOLTIP
        } else {
            READY_TOOLTIP
        }))
        .map_err(|error| format!("Failed to update tray tooltip: {error}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    let _ = (app, recording);

    Ok(())
}
