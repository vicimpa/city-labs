fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["host_action"])),
    )
    .expect("Tauri build configuration failed");
}
