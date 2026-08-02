//! VV Code compatibility launchers for CLIs discovered outside the user's
//! default command path.

use serde::Serialize;
use std::path::{Path, PathBuf};

const SUPPORTED_TOOLS: &[&str] = &["claude", "codex", "gemini", "openclaw", "hermes"];

#[derive(Debug, Serialize)]
pub struct ToolCommandRepairResult {
    launcher_path: String,
    installation_path: String,
    changed: bool,
}

struct RunnableInstallation {
    path: String,
    is_path_default: bool,
}

fn validate_tool(tool: &str) -> Result<(), String> {
    if SUPPORTED_TOOLS.contains(&tool) {
        Ok(())
    } else {
        Err(format!("不支持修复此客户端命令: {tool}"))
    }
}

fn runnable_installation(tool: &str) -> Result<RunnableInstallation, String> {
    let installs = crate::commands::enumerate_tool_installations(tool);
    if let Some(default) = installs
        .iter()
        .find(|install| install.is_path_default && install.runnable)
    {
        return Ok(RunnableInstallation {
            path: default.path.clone(),
            is_path_default: true,
        });
    }

    let mut runnable = installs
        .into_iter()
        .filter(|install| install.runnable)
        .collect::<Vec<_>>();
    match runnable.len() {
        0 => Err(format!("未找到可正常运行的 {tool} 安装")),
        1 => {
            let installation = runnable.remove(0);
            Ok(RunnableInstallation {
                path: installation.path,
                is_path_default: installation.is_path_default,
            })
        }
        _ => Err(format!(
            "检测到多份可运行的 {tool} 安装，无法安全地自动选择，请先在 CC Switch 的工具诊断中处理冲突"
        )),
    }
}

#[cfg(not(target_os = "windows"))]
fn launcher_directories(home: &Path, login_path: &str) -> Vec<PathBuf> {
    let path_dirs = std::env::split_paths(login_path).collect::<Vec<_>>();
    let mut candidates = Vec::new();
    let mut push = |candidate: PathBuf| {
        if path_dirs.contains(&candidate) && !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    };

    // Prefer stable, user-owned bin directories. If neither is configured,
    // reuse the directory that exposes the active npm executable; this follows
    // the same runtime selection the user's login shell already made.
    push(home.join(".local/bin"));
    push(home.join("bin"));
    for dir in &path_dirs {
        if dir.join("npm").is_file() {
            push(dir.clone());
        }
    }
    candidates
}

#[cfg(not(target_os = "windows"))]
fn repair_tool_command(tool: &str) -> Result<ToolCommandRepairResult, String> {
    use std::os::unix::fs::symlink;

    let installation = runnable_installation(tool)?;
    if installation.is_path_default {
        return Ok(ToolCommandRepairResult {
            launcher_path: installation.path.clone(),
            installation_path: installation.path,
            changed: false,
        });
    }

    let home = dirs::home_dir().ok_or_else(|| "无法确定用户主目录".to_string())?;
    let login_path = crate::commands::login_shell_path()
        .ok_or_else(|| "无法读取当前登录终端的 PATH".to_string())?;
    let directories = launcher_directories(&home, &login_path);
    if directories.is_empty() {
        return Err("当前 PATH 中没有可用于创建兼容命令的用户目录".to_string());
    }

    let source = PathBuf::from(&installation.path);
    let mut last_error = None;
    for directory in directories {
        if let Err(error) = std::fs::create_dir_all(&directory) {
            last_error = Some(error.to_string());
            continue;
        }
        let launcher = directory.join(tool);
        let mut created = false;
        if launcher.exists() || std::fs::symlink_metadata(&launcher).is_ok() {
            let same_target =
                std::fs::canonicalize(&launcher).ok() == std::fs::canonicalize(&source).ok();
            if !same_target {
                return Err(format!("{} 已存在，未覆盖现有命令", launcher.display()));
            }
        } else if let Err(error) = symlink(&source, &launcher) {
            last_error = Some(error.to_string());
            continue;
        } else {
            created = true;
        }

        let repaired = crate::commands::enumerate_tool_installations(tool)
            .into_iter()
            .any(|install| install.is_path_default && install.runnable);
        if repaired {
            return Ok(ToolCommandRepairResult {
                launcher_path: launcher.display().to_string(),
                installation_path: installation.path,
                changed: created,
            });
        }

        // Only remove the link we just created. An already-existing link is
        // preserved even when the subsequent shell probe behaves unexpectedly.
        let points_to_source =
            std::fs::canonicalize(&launcher).ok() == std::fs::canonicalize(&source).ok();
        if created && points_to_source {
            let _ = std::fs::remove_file(&launcher);
        }
        last_error = Some("兼容命令创建后仍无法从当前终端运行".to_string());
    }

    Err(last_error.unwrap_or_else(|| "无法创建兼容命令".to_string()))
}

#[cfg(target_os = "windows")]
fn repair_tool_command(_tool: &str) -> Result<ToolCommandRepairResult, String> {
    Err("Windows 当前无法安全创建兼容命令，请在 CC Switch 的工具诊断中处理安装冲突".to_string())
}

#[tauri::command]
pub async fn vvcode_repair_tool_command(tool: String) -> Result<ToolCommandRepairResult, String> {
    validate_tool(&tool)?;
    tokio::task::spawn_blocking(move || repair_tool_command(&tool))
        .await
        .map_err(|error| format!("修复客户端命令任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn stable_user_bin_precedes_active_npm_directory() {
        let home = Path::new("/Users/tester");
        let path = "/Users/tester/node/bin:/Users/tester/.local/bin:/usr/bin";
        let dirs = launcher_directories(home, path);
        assert_eq!(dirs.first(), Some(&home.join(".local/bin")));
    }

    #[test]
    fn rejects_tools_outside_the_product_scenarios() {
        assert!(validate_tool("opencode").is_err());
    }
}
