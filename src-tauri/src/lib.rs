pub mod formatters;
pub mod fs_ops;
pub mod transforms;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            fs_ops::read_file_smart,
            fs_ops::write_file_smart,
            fs_ops::list_workspace_tree,
            fs_ops::create_fs_entry,
            fs_ops::rename_fs_entry,
            fs_ops::delete_fs_entry,
            fs_ops::search_workspace,
            formatters::format_document,
            formatters::validate_document,
            formatters::convert_format,
            formatters::query_json,
            transforms::transform_text,
            transforms::compute_diff,
            transforms::compute_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kunai Tauri application");
}
