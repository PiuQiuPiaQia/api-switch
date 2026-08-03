//! VV Code release-channel discovery and signed application updates.
//!
//! GitHub's `releases/latest` endpoint intentionally excludes prereleases, so
//! beta builds discover releases through the GitHub Releases API and then hand
//! the selected release's `latest.json` to Tauri's signed updater.

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_MANIFEST_ASSET: &str = "latest.json";
const UPDATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Base64-encoded minisign public-key file. CI injects it at compile time so
/// the renderer never decides which signing key should be trusted.
pub(crate) const fn public_key() -> &'static str {
    match option_env!("VV_CODE_UPDATER_PUBKEY") {
        Some(value) => value,
        None => "",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    fn configured() -> Self {
        match option_env!("VV_CODE_UPDATE_CHANNEL") {
            Some("beta") => Self::Beta,
            _ => Self::Stable,
        }
    }

    fn accepts(self, release: &GithubRelease) -> bool {
        match self {
            Self::Stable => !release.prerelease,
            // Beta users receive prereleases and can also graduate to a newer
            // stable release when its semantic version is higher.
            Self::Beta => true,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

impl GithubRelease {
    fn version(&self) -> Option<Version> {
        Version::parse(self.tag_name.trim_start_matches('v')).ok()
    }

    fn manifest_url(&self) -> Option<&str> {
        self.assets
            .iter()
            .find(|asset| asset.name == UPDATE_MANIFEST_ASSET)
            .map(|asset| asset.browser_download_url.as_str())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VvCodeUpdateInfo {
    current_version: String,
    available_version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    release_url: String,
    channel: UpdateChannel,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn select_release<'a>(
    releases: &'a [GithubRelease],
    current: &Version,
    channel: UpdateChannel,
) -> Option<(&'a GithubRelease, Version)> {
    releases
        .iter()
        .filter(|release| !release.draft && channel.accepts(release))
        .filter(|release| release.manifest_url().is_some())
        .filter_map(|release| release.version().map(|version| (release, version)))
        .filter(|(_, version)| version > current)
        .max_by(|(_, left), (_, right)| left.cmp(right))
}

async fn fetch_releases() -> Result<Vec<GithubRelease>, String> {
    let response = crate::proxy::http_client::get()
        .get(crate::vvcode::brand::GITHUB_RELEASES_API_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header(
            "User-Agent",
            format!("{}-updater", crate::vvcode::brand::USER_AGENT),
        )
        .timeout(UPDATE_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("连接 GitHub Releases 失败: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub Releases 返回异常状态: {}",
            response.status()
        ));
    }

    response
        .json::<Vec<GithubRelease>>()
        .await
        .map_err(|error| format!("解析 GitHub Releases 失败: {error}"))
}

async fn find_update(
    app: &AppHandle,
) -> Result<Option<(GithubRelease, Version, UpdateChannel)>, String> {
    let current = app.package_info().version.clone();
    let channel = UpdateChannel::configured();
    let releases = fetch_releases().await?;

    Ok(select_release(&releases, &current, channel)
        .map(|(release, version)| (release.clone(), version, channel)))
}

async fn build_tauri_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let Some((release, _, _)) = find_update(app).await? else {
        return Ok(None);
    };

    if public_key().is_empty() {
        return Err("当前安装包未配置更新签名公钥，请先从 GitHub 手动安装新版".to_string());
    }

    let manifest_url = release
        .manifest_url()
        .ok_or_else(|| "新版本缺少更新清单".to_string())?
        .parse()
        .map_err(|error| format!("更新清单地址无效: {error}"))?;

    let mut builder = app
        .updater_builder()
        .pubkey(public_key())
        .endpoints(vec![manifest_url])
        .map_err(|error| format!("设置更新通道失败: {error}"))?
        .timeout(UPDATE_TIMEOUT);

    if let Some(proxy) = crate::proxy::http_client::get_current_proxy_url() {
        let proxy = proxy
            .parse()
            .map_err(|error| format!("全局代理地址无效: {error}"))?;
        builder = builder.proxy(proxy);
    }

    let updater = builder
        .build()
        .map_err(|error| format!("初始化更新器失败: {error}"))?;

    updater
        .check()
        .await
        .map_err(|error| format!("读取更新清单失败: {error}"))
}

#[tauri::command]
pub async fn vvcode_check_for_update(app: AppHandle) -> Result<Option<VvCodeUpdateInfo>, String> {
    let current_version = app.package_info().version.to_string();
    let Some((release, available_version, channel)) = find_update(&app).await? else {
        return Ok(None);
    };

    Ok(Some(VvCodeUpdateInfo {
        current_version,
        available_version: available_version.to_string(),
        notes: release.body,
        pub_date: release.published_at,
        release_url: release.html_url,
        channel,
    }))
}

#[tauri::command]
pub async fn vvcode_install_update_and_restart(app: AppHandle) -> Result<bool, String> {
    let Some(update) = build_tauri_update(&app).await? else {
        return Ok(false);
    };

    log::info!(
        "开始下载 {} 更新: {}",
        crate::vvcode::brand::DISPLAY_NAME,
        update.version
    );
    let progress_handle = app.clone();
    let mut downloaded = 0_u64;
    let bytes = update
        .download(
            move |chunk_len, content_len| {
                downloaded = downloaded.saturating_add(chunk_len as u64);
                let _ = progress_handle.emit(
                    "vvcode-update-download-progress",
                    UpdateDownloadProgress {
                        downloaded,
                        total: content_len,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| format!("下载或校验更新失败: {error}"))?;

    log::info!(
        "开始安装 {} 更新: {}",
        crate::vvcode::brand::DISPLAY_NAME,
        update.version
    );

    #[cfg(target_os = "windows")]
    {
        crate::save_window_state_before_exit(&app);
        crate::cleanup_before_exit(&app).await;
        crate::remove_tray_icon_before_exit(&app);
        crate::destroy_single_instance_lock(&app);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        update.install(bytes).map_err(|error| {
            format!(
                "Windows 更新安装失败: {error}。请重新打开 {} 后重试。",
                crate::vvcode::brand::DISPLAY_NAME
            )
        })?;
        Ok(true)
    }

    #[cfg(not(target_os = "windows"))]
    {
        update
            .install(bytes)
            .map_err(|error| format!("安装更新失败: {error}"))?;

        crate::save_window_state_before_exit(&app);
        crate::cleanup_before_exit(&app).await;
        log::info!(
            "{} 更新安装完成，正在重启",
            crate::vvcode::brand::DISPLAY_NAME
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        crate::restart_process(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, prerelease: bool, draft: bool, has_manifest: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            html_url: format!("https://example.test/{tag}"),
            body: None,
            published_at: None,
            draft,
            prerelease,
            assets: has_manifest
                .then(|| GithubAsset {
                    name: UPDATE_MANIFEST_ASSET.to_string(),
                    browser_download_url: format!("https://example.test/{tag}/latest.json"),
                })
                .into_iter()
                .collect(),
        }
    }

    #[test]
    fn beta_channel_selects_highest_semantic_version_not_api_order() {
        let releases = vec![
            release("v0.1.0-beta.4", true, false, true),
            release("v0.1.0-beta.12", true, false, true),
            release("v0.1.0-beta.7", true, false, true),
        ];

        let (_, version) = select_release(
            &releases,
            &Version::parse("0.1.0-beta.3").unwrap(),
            UpdateChannel::Beta,
        )
        .unwrap();

        assert_eq!(version, Version::parse("0.1.0-beta.12").unwrap());
    }

    #[test]
    fn stable_channel_ignores_prereleases_drafts_and_missing_manifests() {
        let releases = vec![
            release("v0.4.0", false, true, true),
            release("v0.3.0", false, false, false),
            release("v0.2.0-beta.9", true, false, true),
            release("v0.1.1", false, false, true),
        ];

        let (_, version) = select_release(
            &releases,
            &Version::parse("0.1.0").unwrap(),
            UpdateChannel::Stable,
        )
        .unwrap();

        assert_eq!(version, Version::parse("0.1.1").unwrap());
    }

    #[test]
    fn beta_channel_can_graduate_to_a_newer_stable_release() {
        let releases = vec![
            release("v1.0.0-beta.8", true, false, true),
            release("v1.0.0", false, false, true),
        ];

        let (_, version) = select_release(
            &releases,
            &Version::parse("1.0.0-beta.7").unwrap(),
            UpdateChannel::Beta,
        )
        .unwrap();

        assert_eq!(version, Version::parse("1.0.0").unwrap());
    }
}
