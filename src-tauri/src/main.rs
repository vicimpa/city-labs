#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const MAX_BYTES: u64 = 128 * 1024 * 1024;
#[derive(Default)]
struct Document {
    file: Option<PathBuf>,
    initial_file: Option<PathBuf>,
    dirty: bool,
    force_close: bool,
    ready: bool,
    fingerprint: Option<(SystemTime, u64)>,
    open_requests: Vec<PathBuf>,
    allowed: HashSet<PathBuf>,
    lang: String,
    mcp_error: Option<String>,
}
struct Host {
    doc: Mutex<Document>,
    child: Mutex<Option<CommandChild>>,
}
fn fingerprint(path: &Path) -> Option<(SystemTime, u64)> {
    let m = fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}
fn send_state(app: &tauri::AppHandle) {
    let host = app.state::<Host>();
    let doc = host.doc.lock().unwrap();
    let line = json!({"type":"state", "file":doc.file, "dirty":doc.dirty}).to_string() + "\n";
    if let Some(child) = host.child.lock().unwrap().as_mut() {
        let _ = child.write(line.as_bytes());
    };
}
fn set_file(app: &tauri::AppHandle, path: Option<PathBuf>) {
    let host = app.state::<Host>();
    let mut doc = host.doc.lock().unwrap();
    doc.fingerprint = path.as_deref().and_then(fingerprint);
    if let Some(p) = &path {
        doc.allowed.insert(p.clone());
    }
    doc.file = path;
    doc.initial_file = None;
    drop(doc);
    send_state(app);
}
fn read_document(path: &Path) -> Result<Value, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err("World exceeds 128 MiB".into());
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    if !data.starts_with(b"VSPB") {
        return Err("Not a VSPB world".into());
    }
    Ok(json!({"path":path, "bytesBase64":STANDARD.encode(data)}))
}
fn open_document(app: &tauri::AppHandle, path: PathBuf) -> Result<Value, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let result = read_document(&path)?;
    app.state::<Host>().doc.lock().unwrap().allowed.insert(path);
    // The adapter validates the complete world before accepting this path as a save target.
    Ok(result)
}

fn selected(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.state::<Host>().doc.lock().unwrap().file.clone()
}
fn pick_path(app: &tauri::AppHandle, save: bool, name: Option<&str>) -> Option<PathBuf> {
    let mut picker = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        picker = picker.set_parent(&window);
    }
    let ext = name
        .and_then(|n| Path::new(n).extension())
        .and_then(|s| s.to_str())
        .unwrap_or("vspb");
    picker = picker.add_filter("City Labs", &[ext]);
    if let Some(path) = selected(app) {
        if let Some(dir) = path.parent() {
            picker = picker.set_directory(dir);
        }
    }
    if let Some(name) = name {
        picker = picker.set_file_name(name);
    }
    let path = if save {
        picker.blocking_save_file()
    } else {
        picker.blocking_pick_file()
    }?;
    path.into_path().ok()
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or("Invalid file name")?
        .to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}
fn request_open(app: &tauri::AppHandle, path: PathBuf) {
    let Ok(path) = fs::canonicalize(path) else {
        return;
    };
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("vspb"))
    {
        return;
    }
    let host = app.state::<Host>();
    let mut doc = host.doc.lock().unwrap();
    doc.allowed.insert(path.clone());
    if doc.ready {
        drop(doc);
        let _ = app.emit_to("main", "file:open-request", json!({"path":path}));
    } else {
        doc.open_requests.push(path);
    }
}
fn menu(app: &tauri::AppHandle, lang: &str) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let ru = lang == "ru";
    let item = |id: &str, en: &str, localized: &str, key: &str| {
        MenuItemBuilder::with_id(id, if ru { localized } else { en })
            .accelerator(key)
            .build(app)
    };
    let new = item("new", "New", "Новый", "CmdOrCtrl+N")?;
    let open = item("open", "Open…", "Открыть…", "CmdOrCtrl+O")?;
    let save = item("save", "Save", "Сохранить", "CmdOrCtrl+S")?;
    let save_as = item("saveAs", "Save as…", "Сохранить как…", "CmdOrCtrl+Shift+S")?;
    let export = item("export", "Export…", "Экспорт…", "CmdOrCtrl+E")?;
    let quit = item("quit", "Quit", "Выход", "CmdOrCtrl+Q")?;
    let application = SubmenuBuilder::new(app, "City Labs")
        .about(None)
        .separator()
        .item(&quit)
        .build()?;
    let file = SubmenuBuilder::new(app, if ru { "Файл" } else { "File" })
        .items(&[&new, &open, &save, &save_as])
        .separator()
        .text(
            "reload",
            if ru {
                "Перечитать с диска"
            } else {
                "Reload from disk"
            },
        )
        .text(
            "sample",
            if ru {
                "Пример города"
            } else {
                "Sample city"
            },
        )
        .item(&export)
        .build()?;
    let edit = SubmenuBuilder::new(app, if ru { "Правка" } else { "Edit" })
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let app_menu = MenuBuilder::new(app)
        .items(&[&application, &file, &edit])
        .build()?;
    app.set_menu(app_menu)?;
    Ok(())
}

#[tauri::command]
async fn host_action(
    app: tauri::AppHandle,
    action: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let args = args.unwrap_or(Value::Null);
    match action.as_str() {
        "info" => Ok(
            json!({"name":"City Labs", "version":app.package_info().version.to_string(), "mode":if tauri::is_dev() {"dev"} else {"prod"}, "platform":std::env::consts::OS, "mcpPort":std::env::var("VSPB_MCP_PORT").unwrap_or("7357".into()), "update":null, "mcpError":app.state::<Host>().doc.lock().unwrap().mcp_error}),
        ),
        "ready" => {
            let queued = {
                let host = app.state::<Host>();
                let mut doc = host.doc.lock().unwrap();
                doc.ready = true;
                std::mem::take(&mut doc.open_requests)
            };
            for path in queued {
                let _ = app.emit_to("main", "file:open-request", json!({"path":path}));
            }
            Ok(Value::Null)
        }
        "current" | "reload" => {
            let host = app.state::<Host>();
            let doc = host.doc.lock().unwrap();
            doc.file
                .clone()
                .or(doc.initial_file.clone())
                .map(|p| read_document(&p))
                .unwrap_or(Ok(Value::Null))
        }
        "newFile" => {
            set_file(&app, None);
            Ok(Value::Null)
        }
        "acceptFile" => {
            let path = fs::canonicalize(args["path"].as_str().ok_or("Missing path")?)
                .map_err(|e| e.to_string())?;
            if !app
                .state::<Host>()
                .doc
                .lock()
                .unwrap()
                .allowed
                .contains(&path)
            {
                return Err("File was not selected".into());
            }
            set_file(&app, Some(path));
            Ok(Value::Null)
        }
        "openPath" => {
            let path = PathBuf::from(args["path"].as_str().ok_or("Missing path")?);
            let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
            if !app
                .state::<Host>()
                .doc
                .lock()
                .unwrap()
                .allowed
                .contains(&path)
            {
                return Err("Path was not selected by the user or operating system".into());
            }
            open_document(&app, path)
        }
        "open" => {
            let chosen = pick_path(&app, false, None);
            chosen
                .map(|p| open_document(&app, p))
                .unwrap_or(Ok(Value::Null))
        }
        "openSample" => {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("worlds");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join("vespera.vspb");
            if !path.exists() {
                write_atomic(&path, include_bytes!("../../city/data/vespera.vspb"))?;
            }
            open_document(&app, path)
        }
        "save" | "saveAs" | "exportFile" => {
            let encoded = args["bytesBase64"].as_str().ok_or("Missing bytes")?;
            if encoded.len() as u64 > MAX_BYTES.div_ceil(3) * 4 {
                return Err("File exceeds 128 MiB".into());
            }
            let data = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
            if data.len() as u64 > MAX_BYTES {
                return Err("File exceeds 128 MiB".into());
            }
            if action != "exportFile" && !data.starts_with(b"VSPB") {
                return Err("Not a VSPB world".into());
            }
            let name = args["name"]
                .as_str()
                .and_then(|n| Path::new(n).file_name())
                .and_then(|n| n.to_str());
            let path = if action == "save" {
                selected(&app).or_else(|| pick_path(&app, true, Some("city.vspb")))
            } else {
                pick_path(&app, true, name.or(Some("city.vspb")))
            };
            let Some(path) = path else {
                return Ok(Value::Null);
            };
            write_atomic(&path, &data)?;
            if action != "exportFile" {
                set_file(&app, Some(path.clone()));
            }
            Ok(json!({"path":path}))
        }
        "setDirty" => {
            app.state::<Host>().doc.lock().unwrap().dirty =
                args["dirty"].as_bool().unwrap_or(false);
            send_state(&app);
            Ok(Value::Null)
        }
        "setTitle" => {
            if let Some(w) = app.get_webview_window("main") {
                w.set_title(args["title"].as_str().unwrap_or("City Labs"))
                    .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "setLang" => {
            let lang = args["lang"].as_str().unwrap_or("en");
            app.state::<Host>().doc.lock().unwrap().lang = lang.into();
            menu(&app, lang).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "menu" => {
            if let Some(w) = app.get_webview_window("main") {
                if let Some(m) = app.menu() {
                    w.popup_menu(&m).map_err(|e| e.to_string())?;
                }
            }
            Ok(Value::Null)
        }
        "zoom" => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_maximized().unwrap_or(false) {
                    w.unmaximize()
                } else {
                    w.maximize()
                }
                .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "closeNow" => {
            app.state::<Host>().doc.lock().unwrap().force_close = true;
            if let Some(w) = app.get_webview_window("main") {
                w.close().map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "toolResult" => {
            let line = json!({"type":"result", "id":args["id"], "result":args["result"]})
                .to_string()
                + "\n";
            if let Some(child) = app.state::<Host>().child.lock().unwrap().as_mut() {
                child.write(line.as_bytes()).map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "update" => Ok(Value::Null), // Full signed installers, no downloaded executable code bundles.
        _ => Err(format!("Unknown host operation: {action}")),
    }
}
fn start_sidecar(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let command = if tauri::is_dev() {
        let node = std::env::var("CITY_LABS_NODE").unwrap_or_else(|_| "node".into());
        let root = std::env::var("CITY_LABS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .to_owned()
            });
        app.shell()
            .command(node)
            .arg(root.join("desktop/bridge.mjs"))
    } else {
        let script = app
            .path()
            .resolve("resources/mcp.cjs", tauri::path::BaseDirectory::Resource)?;
        app.shell().sidecar("city-labs-node")?.arg(script)
    };
    let (mut rx, child) = command.spawn()?;
    *app.state::<Host>().child.lock().unwrap() = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Ok(msg) = serde_json::from_slice::<Value>(&bytes) {
                        if msg["type"] == "call" {
                            let _ = handle.emit_to("main", "mcp:call", msg);
                        } else if msg["type"] == "ready" {
                            send_state(&handle);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => eprintln!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Terminated(payload) => {
                    eprintln!("MCP sidecar stopped: {payload:?}");
                    handle.state::<Host>().doc.lock().unwrap().mcp_error = Some(
                        "MCP server stopped; check port availability and restart the app".into(),
                    );
                    let _ = handle.emit_to(
                        "main",
                        "mcp:error",
                        "MCP server stopped; check port availability and restart the app",
                    );
                }
                _ => {}
            }
        }
    });
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            for arg in args.into_iter().skip(1).filter(|a| !a.starts_with('-')) {
                request_open(app, Path::new(&cwd).join(arg));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Host {
            doc: Mutex::new(Document::default()),
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![host_action])
        .setup(|app| {
            menu(app.handle(), "en")?;
            for arg in std::env::args().skip(1).filter(|a| !a.starts_with('-')) {
                let path = fs::canonicalize(arg).ok();
                if let Some(path) = path.filter(|p| {
                    p.extension()
                        .is_some_and(|e| e.eq_ignore_ascii_case("vspb"))
                }) {
                    if app
                        .state::<Host>()
                        .doc
                        .lock()
                        .unwrap()
                        .initial_file
                        .is_none()
                    {
                        if read_document(&path).is_ok() {
                            let host = app.state::<Host>();
                            let mut doc = host.doc.lock().unwrap();
                            doc.allowed.insert(path.clone());
                            doc.initial_file = Some(path);
                        }
                    } else {
                        request_open(app.handle(), path);
                    }
                }
            }
            start_sidecar(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(700));
                let host = handle.state::<Host>();
                let mut doc = host.doc.lock().unwrap();
                if let Some(path) = doc.file.clone() {
                    let new = fingerprint(&path);
                    if new.is_some() && doc.fingerprint != new {
                        doc.fingerprint = new;
                        drop(doc);
                        let _ = handle.emit_to("main", "file:changed", json!({"path":path}));
                    }
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            } else {
                let _ = app.emit_to("main", "menu", event.id().as_ref());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let host = app.state::<Host>();
                let doc = host.doc.lock().unwrap();
                if !doc.dirty || doc.force_close {
                    return;
                }
                api.prevent_close();
                let ru = doc.lang == "ru";
                drop(doc);
                let app = app.clone();
                let parent = window.clone();
                std::thread::spawn(move || {
                    let result = app
                        .dialog()
                        .message(if ru {
                            "Сохранить изменения?"
                        } else {
                            "Save changes before closing?"
                        })
                        .title("City Labs")
                        .parent(&parent)
                        .buttons(MessageDialogButtons::YesNoCancelCustom(
                            if ru { "Сохранить" } else { "Save" }.into(),
                            if ru {
                                "Не сохранять"
                            } else {
                                "Don't save"
                            }
                            .into(),
                            if ru { "Отмена" } else { "Cancel" }.into(),
                        ))
                        .blocking_show_with_result();
                    match result {
                        MessageDialogResult::Yes => {
                            let _ = app.emit_to("main", "app:save-and-close", ());
                        }
                        MessageDialogResult::Custom(label)
                            if label == if ru { "Сохранить" } else { "Save" } =>
                        {
                            let _ = app.emit_to("main", "app:save-and-close", ());
                        }
                        MessageDialogResult::Custom(label)
                            if label
                                == if ru {
                                    "Не сохранять"
                                } else {
                                    "Don't save"
                                } =>
                        {
                            app.state::<Host>().doc.lock().unwrap().force_close = true;
                            let _ = parent.close();
                        }
                        MessageDialogResult::No => {
                            app.state::<Host>().doc.lock().unwrap().force_close = true;
                            let _ = parent.close();
                        }
                        _ => {}
                    }
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to create City Labs")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        request_open(app, path);
                    }
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } => {
                let host = app.state::<Host>();
                let doc = host.doc.lock().unwrap();
                if doc.dirty && !doc.force_close {
                    api.prevent_exit();
                    drop(doc);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.close();
                    }
                }
            }
            tauri::RunEvent::Exit => {
                if let Some(child) = app.state::<Host>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "city-labs-io-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn atomic_replacement_and_invalid_read() {
        let dir = scratch();
        let path = dir.join("город with spaces.vspb");
        write_atomic(&path, b"VSPB first version").unwrap();
        write_atomic(&path, b"VSPB second version").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"VSPB second version");
        let result = read_document(&path).unwrap();
        assert_eq!(
            STANDARD
                .decode(result["bytesBase64"].as_str().unwrap())
                .unwrap(),
            b"VSPB second version"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::write(&path, b"invalid").unwrap();
        assert!(read_document(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn refused_temp_file_preserves_original() {
        let dir = scratch();
        let path = dir.join("world.vspb");
        fs::write(&path, b"VSPB original").unwrap();
        let temp = dir.join(format!(".world.vspb.{}.tmp", std::process::id()));
        fs::write(&temp, b"occupied").unwrap();
        assert!(write_atomic(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"VSPB original");
        assert_eq!(fs::read(&temp).unwrap(), b"occupied");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn oversized_document_refused_before_loading() {
        let dir = scratch();
        let path = dir.join("huge.vspb");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(read_document(&path).unwrap_err().contains("128 MiB"));
        fs::remove_dir_all(dir).unwrap();
    }
}
