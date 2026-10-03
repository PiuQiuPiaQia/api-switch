//! System-browser launch for VV Code flows.
//!
//! Windows calls `ShellExecuteExW` with `SEE_MASK_FLAG_NO_UI` so a missing
//! default-browser association fails quietly instead of popping the system
//! "找不到应用程序" dialog; callers fall back to surfacing the link themselves.

use tauri::AppHandle;

/// Opens `url` with the platform default application (normally the browser),
/// without OS-level error UI on Windows.
pub(crate) fn open_url_silent(app: &AppHandle, url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        windows_shell_open(url)
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<String>)
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "windows")]
fn windows_shell_open(url: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const SEE_MASK_NOASYNC: u32 = 0x0000_0100;
    const SEE_MASK_FLAG_NO_UI: u32 = 0x0000_0400;
    const SW_SHOWNORMAL: i32 = 1;
    const COINIT_MULTITHREADED: u32 = 0x0000_0000;
    const RPC_E_CHANGED_MODE: i32 = -2147417850; // 0x8001_0106
    const S_OK: i32 = 0;
    const S_FALSE: i32 = 1;

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *const core::ffi::c_void, co_init: u32) -> i32;
        fn CoUninitialize();
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfoW) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
    }

    #[repr(C)]
    struct ShellExecuteInfoW {
        cb_size: u32,
        f_mask: u32,
        hwnd: isize,
        lp_verb: *const u16,
        lp_file: *const u16,
        lp_parameters: *const u16,
        lp_directory: *const u16,
        n_show: i32,
        h_inst_app: isize,
        lp_id_list: *mut core::ffi::c_void,
        lp_class: *const u16,
        hkey_class: isize,
        dw_hot_key: u32,
        h_icon: isize,
        h_process: isize,
    }

    let mut url_wide: Vec<u16> = OsStr::new(url)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // ShellExecuteEx requires COM on the calling thread; tokio workers have
    // none, so initialize it for the duration of the call.
    let com_initialized = match unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED) } {
        S_OK | S_FALSE => true,
        RPC_E_CHANGED_MODE => false,
        code => return Err(format!("初始化系统 COM 环境失败 (0x{code:08X})")),
    };

    let mut info = ShellExecuteInfoW {
        cb_size: std::mem::size_of::<ShellExecuteInfoW>() as u32,
        f_mask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        hwnd: 0,
        lp_verb: std::ptr::null(),
        lp_file: url_wide.as_ptr(),
        lp_parameters: std::ptr::null(),
        lp_directory: std::ptr::null(),
        n_show: SW_SHOWNORMAL,
        h_inst_app: 0,
        lp_id_list: std::ptr::null_mut(),
        lp_class: std::ptr::null(),
        hkey_class: 0,
        dw_hot_key: 0,
        h_icon: 0,
        h_process: 0,
    };

    let result = unsafe { ShellExecuteExW(&mut info) };
    let h_inst_app = info.h_inst_app as i32;
    let last_error = if result == 0 {
        unsafe { GetLastError() }
    } else {
        0
    };
    if com_initialized {
        unsafe { CoUninitialize() };
    }
    if result != 0 && h_inst_app > 32 {
        return Ok(());
    }
    Err(describe_shell_failure(h_inst_app, last_error))
}

#[cfg(target_os = "windows")]
fn describe_shell_failure(h_inst_app: i32, last_error: u32) -> String {
    match h_inst_app {
        0 => "内存不足，无法打开系统浏览器".to_string(),
        2 => "系统找不到打开链接的程序".to_string(),
        27 | 31 => "系统未设置默认浏览器，请手动打开授权链接".to_string(),
        _ => format!("无法打开系统浏览器 (hInstApp={h_inst_app}, GetLastError={last_error})"),
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::describe_shell_failure;

    #[test]
    fn no_association_reports_missing_default_browser() {
        let message = describe_shell_failure(31, 0);
        assert!(message.contains("默认浏览器"));
    }

    #[test]
    fn incomplete_association_reports_missing_default_browser() {
        let message = describe_shell_failure(27, 0);
        assert!(message.contains("默认浏览器"));
    }

    #[test]
    fn other_failures_keep_shell_error_codes() {
        let message = describe_shell_failure(5, 1223);
        assert!(message.contains("hInstApp=5"));
        assert!(message.contains("GetLastError=1223"));
    }
}
