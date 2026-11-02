#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager, Window};

static CHILD_PID: AtomicU32 = AtomicU32::new(0);
static CANCELLED: AtomicBool = AtomicBool::new(false);

const NO_WINDOW: u32 = 0x0800_0000;
const PROGID: &str = "AnyCompresssionThatMayWork.Archive";

#[link(name = "shell32")]
extern "system" {
    fn SHChangeNotify(event_id: i32, flags: u32, item1: *const std::ffi::c_void, item2: *const std::ffi::c_void);
}

#[derive(Serialize, Clone)]
struct FileItem {
    name: String,
    size: u64,
    path: String,
}

enum RunError {
    Cancelled,
    Failed(String),
}

/* ---------- 压缩核心定位 ---------- */

fn cli_path() -> PathBuf {
    let base = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));

    if let Some(dir) = base {
        let candidates = [
            dir.join("compressor-cli.exe"),
            dir.join("resources").join("compressor-cli.exe"),
            dir.join("../../../cli/compressor-cli.exe"),
        ];
        if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
            return found;
        }
    }
    PathBuf::from("compressor-cli.exe")
}

/// 去掉压缩包扩展名，得到解压目标文件夹名
fn strip_archive_ext(name: &str) -> String {
    let lower = name.to_lowercase();
    for ext in [
        ".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
        ".rar",
    ] {
        if lower.ends_with(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}

fn kill_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .creation_flags(NO_WINDOW)
        .status();
}

/* ---------- CLI 执行 ---------- */

fn run_cli<F: Fn(f64) -> f64>(window: &Window, args: &[String], map: F) -> Result<(), RunError> {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(cli_path());
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(NO_WINDOW);

    let mut child = command.spawn().map_err(|err| {
        RunError::Failed(format!(
            "无法启动压缩核心：{}（{}）",
            err,
            cli_path().display()
        ))
    })?;

    CHILD_PID.store(child.id(), Ordering::SeqCst);

    let stderr_handle = child.stderr.take().map(|stream| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = BufReader::new(stream).read_to_string(&mut buffer);
            buffer
        })
    });

    if let Some(stream) = child.stdout.take() {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("type").and_then(Value::as_str) != Some("progress") {
                continue;
            }
            let processed = message.get("processed").and_then(Value::as_f64).unwrap_or(0.0);
            let total = message.get("total").and_then(Value::as_f64).unwrap_or(0.0);
            let ratio = if total > 0.0 {
                (processed / total).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let _ = window.emit("task:progress", json!({ "percent": map(ratio) }));
        }
    }

    let status = child
        .wait()
        .map_err(|err| RunError::Failed(err.to_string()))?;
    CHILD_PID.store(0, Ordering::SeqCst);

    let stderr_text = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();

    if CANCELLED.load(Ordering::SeqCst) {
        return Err(RunError::Cancelled);
    }
    if status.success() {
        return Ok(());
    }

    let message = stderr_text.trim();
    Err(RunError::Failed(if message.is_empty() {
        "操作失败".to_string()
    } else {
        message.to_string()
    }))
}

fn run_task(window: &Window, payload: Value) -> Value {
    CANCELLED.store(false, Ordering::SeqCst);

    let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("");
    let password = payload
        .get("password")
        .and_then(Value::as_str)
        .map(str::to_string);

    if mode == "compress" {
        let output = payload
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let format = payload
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("zip")
            .to_string();
        let files: Vec<String> = payload
            .get("files")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        if let Some(parent) = Path::new(&output).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut args = vec!["compress".to_string(), format, output.clone()];
        args.extend(files);
        if let Some(pass) = password {
            args.push("--password".to_string());
            args.push(pass);
        }

        return match run_cli(window, &args, |ratio| ratio) {
            Ok(()) => json!({ "ok": true, "output": output }),
            Err(RunError::Cancelled) => json!({ "ok": false, "cancelled": true }),
            Err(RunError::Failed(message)) => json!({ "ok": false, "error": message }),
        };
    }

    let dir = payload
        .get("dir")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let items: Vec<(String, String)> = payload
        .get("files")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let name = item.get("name")?.as_str()?.to_string();
                    let path = item.get("path")?.as_str()?.to_string();
                    Some((name, path))
                })
                .collect()
        })
        .unwrap_or_default();

    let total = items.len() as f64;
    for (index, (name, path)) in items.iter().enumerate() {
        if CANCELLED.load(Ordering::SeqCst) {
            return json!({ "ok": false, "cancelled": true });
        }

        let outdir = Path::new(&dir)
            .join(strip_archive_ext(name))
            .to_string_lossy()
            .to_string();

        let mut args = vec!["decompress".to_string(), path.clone(), outdir];
        if let Some(pass) = &password {
            args.push("--password".to_string());
            args.push(pass.clone());
        }

        let base = index as f64;
        let result = run_cli(window, &args, move |ratio| (base + ratio) / total);
        match result {
            Ok(()) => {}
            Err(RunError::Cancelled) => return json!({ "ok": false, "cancelled": true }),
            Err(RunError::Failed(message)) => return json!({ "ok": false, "error": message }),
        }
    }

    json!({ "ok": true, "output": dir })
}

/* ---------- 系统集成（仅安装版） ---------- */

fn current_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_default()
}

fn install_dir() -> Option<PathBuf> {
    current_exe().parent().map(Path::to_path_buf)
}

/// 安装版目录里有卸载程序；免安装版没有，据此区分两种发布形态
fn is_installed() -> bool {
    install_dir()
        .map(|dir| dir.join("uninstall.exe").exists())
        .unwrap_or(false)
}

fn exe_name() -> String {
    current_exe()
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "AnyCompresssionThatMayWork.exe".to_string())
}

fn reg_call(args: &[String]) -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("reg.exe")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(NO_WINDOW)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn reg_set(key: &str, name: Option<&str>, kind: &str, data: &str) -> bool {
    let mut args = vec!["add".to_string(), key.to_string()];
    match name {
        Some(value) => args.extend(["/v".to_string(), value.to_string()]),
        None => args.push("/ve".to_string()),
    }
    args.extend([
        "/t".to_string(),
        kind.to_string(),
        "/d".to_string(),
        data.to_string(),
        "/f".to_string(),
    ]);
    reg_call(&args)
}

fn reg_delete_key(key: &str) {
    reg_call(&["delete".to_string(), key.to_string(), "/f".to_string()]);
}

fn reg_delete_value(key: &str, name: &str) {
    reg_call(&[
        "delete".to_string(),
        key.to_string(),
        "/v".to_string(),
        name.to_string(),
        "/f".to_string(),
    ]);
}

fn notify_shell() {
    unsafe { SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null()) }
}

fn assoc_enabled() -> bool {
    reg_call(&[
        "query".to_string(),
        format!("HKCU\\Software\\Classes\\{}", PROGID),
        "/ve".to_string(),
    ])
}

/// 只登记为“打开方式”候选，绝不修改系统默认程序
fn apply_assoc(enabled: bool) -> Result<bool, String> {
    if !is_installed() {
        return Err("免安装版不修改系统设置".to_string());
    }

    let exe = current_exe().to_string_lossy().to_string();

    if enabled {
        let key = format!("HKCU\\Software\\Classes\\{}", PROGID);
        reg_set(&key, None, "REG_SZ", "AnyCompresssionThatMayWork Archive");
        reg_set(
            &format!("{}\\DefaultIcon", key),
            None,
            "REG_SZ",
            &format!("\"{}\",0", exe),
        );
        reg_set(
            &format!("{}\\shell\\open\\command", key),
            None,
            "REG_SZ",
            &format!("\"{}\" \"%1\"", exe),
        );

        let app = format!("HKCU\\Software\\Classes\\Applications\\{}", exe_name());
        reg_set(&app, Some("FriendlyAppName"), "REG_SZ", "AnyCompresssionThatMayWork");
        reg_set(
            &format!("{}\\shell\\open\\command", app),
            None,
            "REG_SZ",
            &format!("\"{}\" \"%1\"", exe),
        );

        for ext in [".zip", ".tar", ".gz", ".tgz"] {
            reg_set(
                &format!("HKCU\\Software\\Classes\\{}\\OpenWithProgids", ext),
                Some(PROGID),
                "REG_SZ",
                "",
            );
            reg_set(
                &format!("{}\\SupportedTypes\\{}", app, ext),
                None,
                "REG_SZ",
                "",
            );
        }
    } else {
        reg_delete_key(&format!("HKCU\\Software\\Classes\\{}", PROGID));
        reg_delete_key(&format!(
            "HKCU\\Software\\Classes\\Applications\\{}",
            exe_name()
        ));
        for ext in [".zip", ".tar", ".gz", ".tgz"] {
            reg_delete_value(
                &format!("HKCU\\Software\\Classes\\{}\\OpenWithProgids", ext),
                PROGID,
            );
        }
    }

    notify_shell();
    Ok(assoc_enabled())
}

#[tauri::command]
fn app_info() -> Value {
    let installed = is_installed();
    json!({
        "installed": installed,
        "assoc": installed && assoc_enabled(),
    })
}

#[tauri::command]
fn set_assoc(enabled: bool) -> Result<bool, String> {
    apply_assoc(enabled)
}

#[tauri::command]
fn open_default_apps() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    Command::new("cmd.exe")
        .args(["/c", "start", "", "ms-settings:defaultapps"])
        .creation_flags(NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

/// 等本进程退出后再静默跑卸载程序，保证能删干净自身目录
#[tauri::command]
fn uninstall_app(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let uninstall = install_dir()
        .map(|dir| dir.join("uninstall.exe"))
        .ok_or("无法定位卸载程序")?;
    if !uninstall.exists() {
        return Err("免安装版没有卸载程序，直接删除文件夹即可".to_string());
    }

    let pid = std::process::id();
    let target = uninstall.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Wait-Process -Id {pid} -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; Start-Process -FilePath '{target}' -ArgumentList '/S'"
    );

    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(NO_WINDOW)
        .spawn()
        .map_err(|err| err.to_string())?;

    app.exit(0);
    Ok(())
}

/* ---------- 命令 ---------- */

#[tauri::command]
fn pick_files(mode: String) -> Vec<FileItem> {
    let mut dialog = rfd::FileDialog::new();
    if mode == "decompress" {
        dialog = dialog.add_filter("压缩包", &["zip", "tar", "gz", "tgz"]);
    }
    let picked = dialog.pick_files().unwrap_or_default();
    picked
        .into_iter()
        .map(|path| {
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            FileItem {
                name,
                size,
                path: path.to_string_lossy().to_string(),
            }
        })
        .collect()
}

#[tauri::command]
fn pick_directory() -> String {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn default_dir() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.to_string_lossy().to_string()))
        .unwrap_or_default()
}

#[tauri::command]
fn path_exists(target: String) -> bool {
    Path::new(&target).exists()
}

fn to_file_items(paths: Vec<String>) -> Vec<FileItem> {
    paths
        .into_iter()
        .map(|raw| {
            let path = PathBuf::from(&raw);
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| raw.clone());
            FileItem {
                name,
                size,
                path: raw,
            }
        })
        .collect()
}

#[tauri::command]
fn stat_paths(paths: Vec<String>) -> Vec<FileItem> {
    to_file_items(paths)
}

/// “打开方式”传进来的参数（第 0 个是可执行文件本身），只保留真实存在的文件
fn arg_files(args: &[String]) -> Vec<FileItem> {
    let candidates: Vec<String> = args
        .iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .cloned()
        .collect();
    to_file_items(candidates)
        .into_iter()
        .filter(|item| Path::new(&item.path).is_file())
        .collect()
}

#[tauri::command]
fn launch_files() -> Vec<FileItem> {
    arg_files(&std::env::args().collect::<Vec<_>>())
}

#[tauri::command]
async fn start_task(window: Window, payload: Value) -> Result<Value, String> {
    let handle = tauri::async_runtime::spawn_blocking(move || run_task(&window, payload));
    handle.await.map_err(|err| err.to_string())
}

#[tauri::command]
fn cancel_task() {
    CANCELLED.store(true, Ordering::SeqCst);
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid != 0 {
        kill_pid(pid);
    }
}

#[tauri::command]
fn window_control(window: Window, action: String) {
    match action.as_str() {
        "minimize" => {
            let _ = window.minimize();
        }
        "toggleMaximize" => {
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
        }
        "close" => {
            let _ = window.close();
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = arg_files(&argv);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
                if !files.is_empty() {
                    let _ = window.emit("app:open-files", files);
                }
            }
        }))
        /* 窗口在 setup 里手动创建：WebView2 数据目录固定为 exe 同级 data，不写 C 盘 */
        .setup(|app| {
            let data_dir = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join("data")))
                .unwrap_or_else(|| PathBuf::from("data"));
            let _ = std::fs::create_dir_all(&data_dir);

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("AnyCompresssionThatMayWork")
            .inner_size(900.0, 720.0)
            .min_inner_size(720.0, 620.0)
            .center()
            .resizable(true)
            .decorations(false)
            .data_directory(data_dir)
            .build()?;
            let _ = window.show();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_files,
            pick_directory,
            default_dir,
            path_exists,
            stat_paths,
            launch_files,
            start_task,
            cancel_task,
            window_control,
            app_info,
            set_assoc,
            open_default_apps,
            uninstall_app
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                /* 关窗即彻底退出：先结束压缩核心，再让外壳退出，避免残留后台进程 */
                let pid = CHILD_PID.swap(0, Ordering::SeqCst);
                if pid != 0 {
                    kill_pid(pid);
                }
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run AnyCompresssionThatMayWork");
}
