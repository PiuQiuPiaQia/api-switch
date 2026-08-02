//! Minimal tray surface for the VV Code single-provider distribution.

use tauri::menu::{Menu, MenuBuilder, MenuItem};

use crate::error::AppError;

pub(crate) const TRAY_ID: &str = "vv-code";

pub(crate) fn create_tray_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, AppError> {
    let texts = crate::tray::current_tray_texts();
    let show_main = MenuItem::with_id(app, "show_main", texts.show_main, true, None::<&str>)
        .map_err(|error| AppError::Message(format!("创建打开主界面菜单失败: {error}")))?;
    let quit = MenuItem::with_id(app, "quit", texts.quit, true, None::<&str>)
        .map_err(|error| AppError::Message(format!("创建退出菜单失败: {error}")))?;

    MenuBuilder::new(app)
        .item(&show_main)
        .separator()
        .item(&quit)
        .build()
        .map_err(|error| AppError::Message(format!("构建菜单失败: {error}")))
}
