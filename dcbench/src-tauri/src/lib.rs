//! DC Bench desktop shell. All survey maths and protocol work lives in the
//! TypeScript core (src/core); Rust only hosts the webview and native plugins
//! (file dialogs, filesystem, serial ports for GeoCOM).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_serialplugin::init())
        .run(tauri::generate_context!())
        .expect("error while running DC Bench");
}
