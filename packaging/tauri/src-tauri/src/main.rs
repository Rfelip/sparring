// Sparring — standalone Tauri shell.
//
// The real product is the `web/` frontend (bundled via frontendDist). This Rust
// binary is a thin native window around the system WebKitGTK webview: no Python,
// no localhost server, no CDN. Study mode loads the committed web/decks/*.json,
// renders with vendored KaTeX, schedules with FSRS-5, and persists FSRS state in
// the webview's localStorage.
//
// localStorage persistence across launches:
//   Tauri gives the webview a *persistent* data directory keyed by the bundle
//   identifier (com.ruanfelipe.sparring). On Linux that is the WebKitGTK
//   WebsiteDataManager base dir under $XDG_DATA_HOME/<identifier>. As long as the
//   identifier is stable (it is), localStorage written in one launch is read back
//   in the next. The Python dev shell's /__api appdata mirror is intentionally
//   absent here — the frontend's `Bridge` probe fails, edit/CRUD chip hides, and
//   the app runs read-only study mode. That is the shareable MVP.

// Hide the extra console window on Windows release builds (no-op on Linux).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Sparring application");
}
