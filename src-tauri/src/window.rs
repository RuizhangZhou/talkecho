#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
use tauri::{App, AppHandle, Emitter, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

// The offset from the top of the screen to the window
const TOP_OFFSET: i32 = 54;

/// Sets up the main window with custom positioning
pub fn setup_main_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("TalkEcho"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    position_window_top_center(&window, TOP_OFFSET)?;

    // Set window as non-focusable on Windows
    // #[cfg(target_os = "windows")]
    // {
    //     let _ = window.set_focusable(false);
    // }

    Ok(())
}

/// Positions a window at the top center of the screen with a specified Y offset
pub fn position_window_top_center(
    window: &WebviewWindow,
    y_offset: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get the primary monitor
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let monitor_position = monitor.position();
        let window_size = window.outer_size()?;

        // Calculate center X position
        let center_x = monitor_position.x
            + (monitor_size.width as i32 - window_size.width as i32) / 2;

        // Set the window position
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: monitor_position.y + y_offset,
        }))?;
    }

    Ok(())
}

/// Future function for centering window completely (both X and Y)
#[allow(dead_code)]
pub fn center_window_completely(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let monitor_position = monitor.position();
        let window_size = window.outer_size()?;

        let center_x = monitor_position.x
            + (monitor_size.width as i32 - window_size.width as i32) / 2;
        let center_y = monitor_position.y
            + (monitor_size.height as i32 - window_size.height as i32) / 2;

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: center_y,
        }))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_window_height(window: tauri::WebviewWindow, height: u32) -> Result<(), String> {
    use tauri::{LogicalSize, Size};

    // Simply set the window size with fixed width and new height
    let new_size = LogicalSize::new(800.0, height as f64);
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))?;

    Ok(())
}

/// Builds the dashboard window from a background thread.
///
/// On Windows `WebviewWindowBuilder::build` deadlocks when it is called from
/// the main thread while the event loop is running, which is where synchronous
/// commands, tray menu callbacks and global shortcut handlers all run. The
/// native window still appears, but its WebView2 controller never finishes
/// initializing and never navigates, so the dashboard stays permanently blank.
/// Building from another thread leaves the event loop free to finish the job.
pub fn spawn_dashboard_creation<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        if app.get_webview_window("dashboard").is_some() {
            return;
        }

        match create_dashboard_window_with_close_handler(&app) {
            Ok(window) => {
                let _ = window.set_focus();
            }
            Err(e) => eprintln!("Failed to create dashboard window: {}", e),
        }
    });
}

#[tauri::command]
pub fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    // Check if dashboard window already exists
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        // Verify the window is still valid by checking if we can get its visibility
        match dashboard_window.is_visible() {
            Ok(_) => {
                // Window is valid, show and focus it
                dashboard_window
                    .show()
                    .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
                dashboard_window
                    .set_focus()
                    .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
            }
            Err(_) => {
                // Window reference is stale, recreate it
                spawn_dashboard_creation(&app);
            }
        }
    } else {
        // Window doesn't exist, create it with platform-aware defaults
        spawn_dashboard_creation(&app);
    }

    Ok(())
}

#[tauri::command]
pub fn toggle_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        match dashboard_window.is_visible() {
            Ok(true) => {
                // Window is visible, hide it
                dashboard_window
                    .hide()
                    .map_err(|e| format!("Failed to hide dashboard window: {}", e))?;
            }
            Ok(false) => {
                // Window is hidden, show and focus it
                dashboard_window
                    .show()
                    .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
                dashboard_window
                    .set_focus()
                    .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
            }
            Err(_) => {
                // Window reference is stale, recreate it
                spawn_dashboard_creation(&app);
            }
        }
    } else {
        // Window doesn't exist, create it with close handler
        spawn_dashboard_creation(&app);
    }

    Ok(())
}

/// Shows the compact recording bar and brings it to the foreground.
///
/// Hiding this window never stops its webview. That is intentional: global
/// shortcuts, dictation and any active audio capture must keep running while
/// TalkEcho is resident in the system tray.
pub fn show_main_bar<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    window
        .unminimize()
        .map_err(|e| format!("Failed to restore main window: {e}"))?;
    window
        .show()
        .map_err(|e| format!("Failed to show main window: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus main window: {e}"))?;
    let _ = window.emit("focus-text-input", serde_json::json!({}));

    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Some(panel) = app.get_webview_panel("main") {
            panel.show();
        }
    }

    Ok(())
}

/// Hides the compact recording bar without destroying the window or stopping
/// background work.
pub fn hide_main_bar<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;

        if let Some(panel) = app.get_webview_panel("main") {
            let _ = panel.hide();
        }
    }

    window
        .hide()
        .map_err(|e| format!("Failed to hide main window: {e}"))
}

/// Toggles the recording bar using native window visibility, rather than a
/// frontend-only CSS state. This is shared by the global shortcut and tray.
pub fn toggle_main_bar<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    match window
        .is_visible()
        .map_err(|e| format!("Failed to read main window visibility: {e}"))?
    {
        true => hide_main_bar(app),
        false => show_main_bar(app),
    }
}

#[tauri::command]
pub fn move_window(app: tauri::AppHandle, direction: String, step: i32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let current_pos = window
            .outer_position()
            .map_err(|e| format!("Failed to get window position: {}", e))?;

        let (new_x, new_y) = match direction.as_str() {
            "up" => (current_pos.x, current_pos.y - step),
            "down" => (current_pos.x, current_pos.y + step),
            "left" => (current_pos.x - step, current_pos.y),
            "right" => (current_pos.x + step, current_pos.y),
            _ => return Err(format!("Invalid direction: {}", direction)),
        };

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: new_x,
                y: new_y,
            }))
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    } else {
        return Err("Main window not found".to_string());
    }

    Ok(())
}

pub fn create_dashboard_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, tauri::Error> {
    let base_builder =
        WebviewWindowBuilder::new(app, "dashboard", tauri::WebviewUrl::App("index.html".into()));

    #[cfg(target_os = "macos")]
    let base_builder = base_builder
        .title("TalkEcho - Dashboard")
        .center()
        .decorations(true)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .content_protected(true)
        .visible(true)
        .traffic_light_position(LogicalPosition::new(14.0, 18.0));

    #[cfg(not(target_os = "macos"))]
    let base_builder = base_builder
        .title("TalkEcho - Dashboard")
        .center()
        .decorations(true)
        .inner_size(1000.0, 700.0)
        .min_inner_size(900.0, 650.0)
        // Keep meeting content out of screenshots in shipped builds, but
        // allow screen captures while developing so UI work and bug reports
        // can be verified with normal OS capture tools.
        .content_protected(!cfg!(debug_assertions))
        .visible(true)
        .resizable(true)
        // The dashboard is reached through the tray or its global shortcut.
        // It should not claim a permanent taskbar slot on Windows.
        .skip_taskbar(cfg!(target_os = "windows"));

    base_builder.build()
}

/// Creates a dashboard window with close event handler that hides instead of destroying
pub fn create_dashboard_window_with_close_handler<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, tauri::Error> {
    let dashboard_window = create_dashboard_window(app)?;

    // Setup close handler to hide instead of destroy
    let window_clone = dashboard_window.clone();
    dashboard_window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Prevent window from being destroyed
            api.prevent_close();
            // Hide the window instead
            let _ = window_clone.hide();
        }
    });

    Ok(dashboard_window)
}

