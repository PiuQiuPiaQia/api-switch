//! Single-provider NewAPI desktop integration.
//!
//! OAuth secrets and management requests stay in the Rust process. The
//! renderer only receives a redacted session summary and normalized product
//! catalog data.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use once_cell::sync::Lazy;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;
use uuid::Uuid;

const LEGACY_AUTHORIZE_PATH: &str = "/api/oauth/vscode";
const LEGACY_TOKEN_PATH: &str = "/api/oauth/vscode/token";
const DESKTOP_BOOTSTRAP_PATH: &str = "/api/oauth/desktop/bootstrap";
const STATUS_PATH: &str = "/api/status";
const SESSION_FILE: &str = "newapi-session.json";
const OAUTH_TTL_SECONDS: i64 = 10 * 60;
const LOOPBACK_CALLBACK_PATH: &str = "/oauth/newapi";
const MAX_LOOPBACK_HEADER_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone)]
struct PendingOAuth {
    server_url: String,
    state: String,
    verifier: String,
    redirect_uri: String,
    created_at: i64,
}

static PENDING_OAUTH: Lazy<Mutex<Option<PendingOAuth>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    server_url: String,
    access_token: String,
    token_type: String,
    user_id: i64,
    username: String,
    display_name: String,
    role: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiSessionSummary {
    server_url: String,
    user_id: i64,
    username: String,
    display_name: String,
    role: i64,
    created_at: i64,
}

impl From<&StoredSession> for NewApiSessionSummary {
    fn from(session: &StoredSession) -> Self {
        Self {
            server_url: session.server_url.clone(),
            user_id: session.user_id,
            username: session.username.clone(),
            display_name: session.display_name.clone(),
            role: session.role,
            created_at: session.created_at,
        }
    }
}

#[derive(Debug, Clone)]
struct NewApiOAuthCallback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiUser {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    username: String,
    #[serde(default, alias = "display_name")]
    display_name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    role: i64,
    #[serde(default)]
    status: i64,
    #[serde(default)]
    group: String,
    #[serde(default)]
    quota: i64,
    #[serde(default, alias = "used_quota")]
    used_quota: i64,
    #[serde(default, alias = "request_count")]
    request_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiModel {
    #[serde(default, alias = "model_name")]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, alias = "owner_by")]
    vendor: String,
    #[serde(default, alias = "quota_type")]
    quota_type: i64,
    #[serde(default, alias = "model_ratio")]
    model_ratio: f64,
    #[serde(default, alias = "model_price")]
    model_price: f64,
    #[serde(default, alias = "completion_ratio")]
    completion_ratio: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiConnection {
    #[serde(default, alias = "base_url")]
    base_url: String,
    #[serde(default, alias = "api_key")]
    api_key: String,
    #[serde(default, alias = "api_format")]
    api_format: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiGroup {
    #[serde(default, alias = "type")]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, alias = "desc")]
    description: String,
    #[serde(default)]
    ratio: String,
    #[serde(default, alias = "base_url")]
    base_url: String,
    #[serde(default, alias = "api_key")]
    api_key: String,
    #[serde(default, alias = "default_model_id")]
    default_model_id: String,
    #[serde(default, alias = "api_provider")]
    api_provider: String,
    #[serde(default, alias = "cc_provider")]
    cc_provider: String,
    #[serde(default, alias = "is_default")]
    is_default: bool,
    #[serde(default)]
    models: Vec<NewApiModel>,
    #[serde(default)]
    connections: BTreeMap<String, NewApiConnection>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiBootstrap {
    #[serde(default)]
    user: NewApiUser,
    #[serde(default)]
    groups: Vec<NewApiGroup>,
    #[serde(default)]
    source: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewApiInfoRoute {
    id: String,
    url: String,
    route: String,
    description: String,
    color: String,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn session_path() -> std::path::PathBuf {
    crate::config::get_app_config_dir().join(SESSION_FILE)
}

fn save_session(session: &StoredSession) -> Result<(), String> {
    let path = session_path();
    crate::config::write_json_file(&path, session).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("无法收紧登录会话文件权限: {e}"))?;
    }

    Ok(())
}

fn load_session() -> Result<Option<StoredSession>, String> {
    let path = session_path();
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| format!("无法读取登录会话: {e}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("登录会话文件已损坏: {e}"))
}

fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("尚未配置 NewAPI 服务地址".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|_| "NewAPI 服务地址格式无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("NewAPI 服务地址必须是有效的 HTTP(S) 地址".to_string());
    }
    if parsed.scheme() == "http" {
        let host = parsed.host_str().unwrap_or_default();
        let is_loopback = host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        if !is_loopback {
            return Err("生产环境的 NewAPI 服务地址必须使用 HTTPS".to_string());
        }
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("NewAPI 服务地址不得包含用户名或密码".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("NewAPI 服务地址不得包含查询参数或片段".to_string());
    }

    Ok(trimmed.to_string())
}

fn endpoint(server_url: &str, path: &str) -> String {
    format!("{}{}", server_url.trim_end_matches('/'), path)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(format!("VV-Code-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("无法初始化网络客户端: {e}"))
}

fn oauth_random() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn response_message(value: &Value, fallback: &str) -> String {
    value
        .get("message")
        .or_else(|| value.get("error_description"))
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

async fn response_json(response: reqwest::Response) -> Result<(StatusCode, Value), String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取 NewAPI 响应失败: {e}"))?;
    let value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text)
            .map_err(|_| format!("NewAPI 返回了无法识别的响应（HTTP {}）", status.as_u16()))?
    };
    Ok((status, value))
}

async fn authenticated_get(
    client: &Client,
    session: &StoredSession,
    path: &str,
) -> Result<(StatusCode, Value), String> {
    let response = client
        .get(endpoint(&session.server_url, path))
        .bearer_auth(&session.access_token)
        .header("New-Api-User", session.user_id.to_string())
        .send()
        .await
        .map_err(|e| format!("连接 NewAPI 失败: {e}"))?;
    response_json(response).await
}

async fn authenticated_post_json(
    client: &Client,
    session: &StoredSession,
    path: &str,
    body: &Value,
) -> Result<(StatusCode, Value), String> {
    let response = client
        .post(endpoint(&session.server_url, path))
        .bearer_auth(&session.access_token)
        .header("New-Api-User", session.user_id.to_string())
        .json(body)
        .send()
        .await
        .map_err(|e| format!("连接 NewAPI 失败: {e}"))?;
    response_json(response).await
}

fn data(value: &Value) -> &Value {
    value.get("data").unwrap_or(value)
}

fn value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn value_i64(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(value)) => value.as_i64().unwrap_or_default(),
        Some(Value::String(value)) => value.parse().unwrap_or_default(),
        _ => 0,
    }
}

fn api_info_routes(value: &Value) -> Vec<NewApiInfoRoute> {
    let payload = data(value);
    if payload
        .get("api_info_enabled")
        .and_then(Value::as_bool)
        .is_some_and(|enabled| !enabled)
    {
        return Vec::new();
    }

    let items = match payload.get("api_info") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(items)) => serde_json::from_str::<Vec<Value>>(items).unwrap_or_default(),
        _ => Vec::new(),
    };

    items
        .into_iter()
        .filter_map(|item| {
            let url = value_string(item.get("url")).trim().to_string();
            if url.is_empty() {
                return None;
            }
            Some(NewApiInfoRoute {
                id: value_string(item.get("id")),
                url,
                route: value_string(item.get("route")).trim().to_string(),
                description: value_string(item.get("description")).trim().to_string(),
                color: value_string(item.get("color")).trim().to_string(),
            })
        })
        .collect()
}

async fn fetch_api_info_routes(session: &StoredSession) -> Result<Vec<NewApiInfoRoute>, String> {
    let response = client()?
        .get(endpoint(&session.server_url, STATUS_PATH))
        .send()
        .await
        .map_err(|e| format!("拉取网站 API 信息失败: {e}"))?;
    let (status, value) = response_json(response).await?;
    if !status.is_success()
        || value
            .get("success")
            .and_then(Value::as_bool)
            .is_some_and(|success| !success)
    {
        return Err(response_message(&value, "拉取网站 API 信息失败"));
    }
    Ok(api_info_routes(&value))
}

fn api_token_items(value: &Value) -> &[Value] {
    data(value)
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| data(value).as_array())
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn preferred_group_token_ids(value: &Value) -> BTreeMap<String, i64> {
    let mut candidates = BTreeMap::<String, (u8, i64)>::new();
    for item in api_token_items(value) {
        if value_i64(item.get("status")) != 1 {
            continue;
        }
        let id = value_i64(item.get("id"));
        let group_id = value_string(item.get("group"));
        let name = value_string(item.get("name"));
        if id <= 0 || group_id.is_empty() {
            continue;
        }

        let priority = if name == format!("desktop-{group_id}") {
            2
        } else if name == group_id {
            1
        } else {
            0
        };
        if priority == 0 {
            continue;
        }

        let replace = candidates
            .get(&group_id)
            .is_none_or(|(current_priority, _)| priority > *current_priority);
        if replace {
            candidates.insert(group_id, (priority, id));
        }
    }

    candidates
        .into_iter()
        .map(|(group_id, (_, id))| (group_id, id))
        .collect()
}

fn merge_group_token_keys(
    token_by_group: &mut BTreeMap<String, Value>,
    token_ids: &BTreeMap<String, i64>,
    keys_value: &Value,
    server_url: &str,
) {
    let keys = data(keys_value).get("keys").and_then(Value::as_object);
    let Some(keys) = keys else {
        return;
    };

    for (group_id, token_id) in token_ids {
        let Some(raw_key) = keys
            .get(&token_id.to_string())
            .and_then(Value::as_str)
            .filter(|key| !key.trim().is_empty())
        else {
            continue;
        };
        let full_key = if raw_key.starts_with("sk-") {
            raw_key.to_string()
        } else {
            format!("sk-{raw_key}")
        };
        let item = token_by_group.entry(group_id.clone()).or_insert_with(|| {
            serde_json::json!({
                "type": group_id,
                "name": group_id,
                "baseUrl": server_url,
            })
        });
        if let Some(object) = item.as_object_mut() {
            object.insert("apiKey".to_string(), Value::String(full_key));
            let missing_base_url = object
                .get("baseUrl")
                .or_else(|| object.get("base_url"))
                .and_then(Value::as_str)
                .is_none_or(|base_url| base_url.trim().is_empty());
            if missing_base_url {
                object.insert("baseUrl".to_string(), Value::String(server_url.to_string()));
            }
        }
    }
}

fn user_from_value(value: &Value, session: &StoredSession) -> NewApiUser {
    let response_user_id = value_i64(value.get("id"));
    let response_role = value_i64(value.get("role"));
    NewApiUser {
        id: if response_user_id > 0 {
            response_user_id
        } else {
            session.user_id
        },
        username: value_string(value.get("username")).or_else_value(&session.username),
        display_name: value_string(
            value
                .get("display_name")
                .or_else(|| value.get("displayName")),
        )
        .or_else_value(&session.display_name),
        email: value_string(value.get("email")),
        role: if response_role > 0 {
            response_role
        } else {
            session.role
        },
        status: value_i64(value.get("status")),
        group: value_string(value.get("group")),
        quota: value_i64(value.get("quota")),
        used_quota: value_i64(value.get("used_quota").or_else(|| value.get("usedQuota"))),
        request_count: value_i64(
            value
                .get("request_count")
                .or_else(|| value.get("requestCount")),
        ),
    }
}

trait OrElseValue {
    fn or_else_value(self, fallback: &str) -> String;
}

impl OrElseValue for String {
    fn or_else_value(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn desktop_bootstrap_from_value(value: &Value) -> Option<NewApiBootstrap> {
    let payload = data(value).clone();
    serde_json::from_value::<NewApiBootstrap>(payload)
        .ok()
        .map(|mut bootstrap| {
            if bootstrap.source.is_empty() {
                bootstrap.source = "desktop-v1".to_string();
            }
            for group in &mut bootstrap.groups {
                if group.name.is_empty() {
                    group.name = group.id.clone();
                }
                for model in &mut group.models {
                    if model.name.is_empty() {
                        model.name = model.id.clone();
                    }
                }
            }
            bootstrap
        })
}

async fn fetch_legacy_bootstrap(
    client: &Client,
    session: &StoredSession,
) -> Result<NewApiBootstrap, String> {
    let (self_result, groups_result, tokens_result, api_tokens_result) = tokio::join!(
        authenticated_get(client, session, "/api/user/self"),
        authenticated_get(client, session, "/api/user/self/groups"),
        authenticated_get(client, session, "/api/oauth/vscode/group_tokens"),
        authenticated_get(client, session, "/api/token/?p=1&size=100"),
    );

    let (self_status, self_value) = self_result?;
    if !self_status.is_success() {
        return Err(response_message(&self_value, "登录已失效，请重新登录"));
    }
    let (groups_status, groups_value) = groups_result?;
    if !groups_status.is_success() {
        return Err(response_message(&groups_value, "无法获取用户可用分组"));
    }
    let (tokens_status, tokens_value) = tokens_result?;
    if !tokens_status.is_success() {
        return Err(response_message(&tokens_value, "无法获取分组密钥"));
    }

    let user = user_from_value(data(&self_value), session);
    let usable_groups = data(&groups_value).as_object().cloned().unwrap_or_default();
    let token_items = data(&tokens_value).as_array().cloned().unwrap_or_default();
    let api_tokens_value = match api_tokens_result {
        Ok((status, value)) if status.is_success() => value,
        _ => Value::Null,
    };

    let mut token_by_group = BTreeMap::<String, Value>::new();
    for item in token_items {
        let id = value_string(item.get("type").or_else(|| item.get("id")));
        if !id.is_empty() {
            token_by_group.insert(id, item);
        }
    }

    // The standard token APIs are the source of truth for desktop-created
    // credentials. Keep group_tokens as a compatibility source for old keys.
    let desktop_token_ids = preferred_group_token_ids(&api_tokens_value);
    if !desktop_token_ids.is_empty() {
        let ids = desktop_token_ids.values().copied().collect::<Vec<_>>();
        let body = serde_json::json!({ "ids": ids });
        if let Ok((status, keys_value)) =
            authenticated_post_json(client, session, "/api/token/batch/keys", &body).await
        {
            let success = keys_value
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(status.is_success());
            if status.is_success() && success {
                merge_group_token_keys(
                    &mut token_by_group,
                    &desktop_token_ids,
                    &keys_value,
                    &session.server_url,
                );
            }
        }
    }

    let mut all_group_ids = BTreeSet::new();
    all_group_ids.extend(usable_groups.keys().cloned());
    all_group_ids.extend(token_by_group.keys().cloned());

    let mut groups = Vec::new();
    for group_id in all_group_ids {
        let usable = usable_groups.get(&group_id).and_then(Value::as_object);
        let token = token_by_group.get(&group_id);
        let name = value_string(token.and_then(|item| item.get("name"))).or_else_value(&group_id);
        let ratio = value_string(usable.and_then(|item| item.get("ratio"))).or_else_value(
            &value_string(token.and_then(|item| item.get("group_ratio"))).or_else_value("1"),
        );
        groups.push(NewApiGroup {
            id: group_id,
            name,
            description: value_string(usable.and_then(|item| item.get("desc"))),
            ratio,
            base_url: value_string(
                token.and_then(|item| item.get("baseUrl").or_else(|| item.get("base_url"))),
            ),
            api_key: value_string(
                token.and_then(|item| item.get("apiKey").or_else(|| item.get("api_key"))),
            ),
            default_model_id: value_string(token.and_then(|item| {
                item.get("defaultModelId")
                    .or_else(|| item.get("default_model_id"))
            })),
            api_provider: value_string(
                token.and_then(|item| item.get("apiProvider").or_else(|| item.get("api_provider"))),
            ),
            cc_provider: value_string(
                token.and_then(|item| item.get("ccProvider").or_else(|| item.get("cc_provider"))),
            ),
            is_default: token
                .and_then(|item| item.get("isDefault").or_else(|| item.get("is_default")))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            models: Vec::new(),
            connections: BTreeMap::new(),
        });
    }

    groups.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(NewApiBootstrap {
        user,
        groups,
        source: "vscode-legacy".to_string(),
    })
}

async fn fetch_bootstrap(session: &StoredSession) -> Result<NewApiBootstrap, String> {
    let client = client()?;
    let (status, value) = authenticated_get(&client, session, DESKTOP_BOOTSTRAP_PATH).await?;
    if status.is_success() {
        if value
            .get("success")
            .and_then(Value::as_bool)
            .is_some_and(|success| !success)
        {
            return Err(response_message(&value, "无法加载工作台数据"));
        }
        return desktop_bootstrap_from_value(&value)
            .ok_or_else(|| "NewAPI 桌面端聚合接口响应格式无效".to_string());
    }

    if !matches!(status, StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED) {
        return Err(response_message(&value, "无法加载工作台数据"));
    }

    fetch_legacy_bootstrap(&client, session).await
}

fn parse_loopback_oauth_target(target: &str) -> Option<NewApiOAuthCallback> {
    if !target.starts_with('/') {
        return None;
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != LOOPBACK_CALLBACK_PATH {
        return None;
    }

    let params: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
    Some(NewApiOAuthCallback {
        code: params.get("code").cloned(),
        state: params.get("state").cloned(),
        error: params.get("error").cloned(),
        error_description: params.get("error_description").cloned(),
    })
}

async fn read_loopback_target(stream: &mut TcpStream) -> Result<String, String> {
    let mut request = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|e| format!("读取本地 OAuth 回调失败: {e}"))?;
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() > MAX_LOOPBACK_HEADER_BYTES {
            return Err("本地 OAuth 回调请求头过大".to_string());
        }
    }

    let request = String::from_utf8(request)
        .map_err(|_| "本地 OAuth 回调不是有效的 HTTP 请求".to_string())?;
    let mut parts = request
        .lines()
        .next()
        .ok_or_else(|| "本地 OAuth 回调缺少请求行".to_string())?
        .split_whitespace();
    if parts.next() != Some("GET") {
        return Err("本地 OAuth 回调只接受 GET 请求".to_string());
    }
    parts
        .next()
        .map(str::to_string)
        .ok_or_else(|| "本地 OAuth 回调缺少请求地址".to_string())
}

async fn write_loopback_page(stream: &mut TcpStream, status: &str, title: &str, message: &str) {
    let body = format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f3ff;color:#211b35;font:16px system-ui,-apple-system,sans-serif}}main{{width:min(520px,calc(100% - 48px));padding:40px;border:1px solid #ded8f4;border-radius:24px;background:#fff;box-shadow:0 24px 70px #5b3ca51f}}h1{{margin:0 0 12px;font-size:26px}}p{{margin:0;color:#625b73;line-height:1.7}}</style><main><h1>{title}</h1><p>{message}</p></main></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn receive_loopback_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<NewApiOAuthCallback, String> {
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|e| format!("等待本地 OAuth 回调失败: {e}"))?;
        if !peer.ip().is_loopback() {
            continue;
        }

        let target = match read_loopback_target(&mut stream).await {
            Ok(target) => target,
            Err(error) => {
                write_loopback_page(
                    &mut stream,
                    "400 Bad Request",
                    "VV Code 登录回调无效",
                    "请返回 VV Code 后重新发起登录。",
                )
                .await;
                return Err(error);
            }
        };
        let Some(callback) = parse_loopback_oauth_target(&target) else {
            write_loopback_page(
                &mut stream,
                "404 Not Found",
                "页面不存在",
                "此本地地址仅用于接收 VV Code 登录回调。",
            )
            .await;
            continue;
        };

        if callback.state.as_deref() != Some(expected_state) {
            write_loopback_page(
                &mut stream,
                "400 Bad Request",
                "VV Code 登录校验失败",
                "登录状态不匹配，请返回 VV Code 后重新尝试。",
            )
            .await;
            return Err("OAuth state 校验失败，请重新登录".to_string());
        }

        if callback.error.is_some() {
            write_loopback_page(
                &mut stream,
                "400 Bad Request",
                "VV Code 登录未完成",
                "授权已取消或服务端拒绝了请求，请返回应用查看详情。",
            )
            .await;
        } else if callback
            .code
            .as_deref()
            .is_some_and(|code| !code.trim().is_empty())
        {
            write_loopback_page(
                &mut stream,
                "200 OK",
                "登录信息已返回 VV Code",
                "可以关闭此页面并回到应用，VV Code 正在完成登录。",
            )
            .await;
        } else {
            write_loopback_page(
                &mut stream,
                "400 Bad Request",
                "VV Code 登录回调不完整",
                "回调中缺少授权信息，请返回 VV Code 后重新尝试。",
            )
            .await;
        }
        return Ok(callback);
    }
}

fn clear_pending_oauth() {
    if let Ok(mut pending) = PENDING_OAUTH.lock() {
        *pending = None;
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn newapi_oauth_begin(
    app: AppHandle,
    server_url: String,
) -> Result<NewApiSessionSummary, String> {
    let server_url = normalize_server_url(&server_url)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法启动本地 OAuth 回调监听: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("无法读取本地 OAuth 回调端口: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{LOOPBACK_CALLBACK_PATH}");

    let state = oauth_random();
    let verifier = oauth_random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorization_url =
        Url::parse(&endpoint(&server_url, LEGACY_AUTHORIZE_PATH)).map_err(|e| e.to_string())?;
    authorization_url
        .query_pairs_mut()
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("redirect_uri", &redirect_uri);

    let pending = PendingOAuth {
        server_url,
        state: state.clone(),
        verifier,
        redirect_uri,
        created_at: now_unix(),
    };
    {
        let mut slot = PENDING_OAUTH
            .lock()
            .map_err(|_| "OAuth 状态锁不可用".to_string())?;
        if slot
            .as_ref()
            .is_some_and(|current| now_unix() - current.created_at <= OAUTH_TTL_SECONDS)
        {
            return Err("已有登录请求正在等待浏览器授权".to_string());
        }
        *slot = Some(pending);
    }

    if let Err(error) = app
        .opener()
        .open_url(authorization_url.as_str(), None::<String>)
    {
        clear_pending_oauth();
        return Err(format!("无法打开系统浏览器: {error}"));
    }

    let callback = match tokio::time::timeout(
        Duration::from_secs(OAUTH_TTL_SECONDS as u64),
        receive_loopback_callback(listener, &state),
    )
    .await
    {
        Ok(Ok(callback)) => callback,
        Ok(Err(error)) => {
            clear_pending_oauth();
            focus_main_window(&app);
            return Err(error);
        }
        Err(_) => {
            clear_pending_oauth();
            focus_main_window(&app);
            return Err("OAuth 登录等待超时，请重新尝试".to_string());
        }
    };
    focus_main_window(&app);

    if let Some(error) = callback.error {
        clear_pending_oauth();
        return Err(callback.error_description.unwrap_or(error));
    }
    let Some(code) = callback.code.filter(|code| !code.trim().is_empty()) else {
        clear_pending_oauth();
        return Err("OAuth 回调缺少授权码".to_string());
    };
    let result = complete_newapi_oauth(code, state).await;
    if result.is_err() {
        clear_pending_oauth();
    }
    result
}

async fn complete_newapi_oauth(
    code: String,
    state: String,
) -> Result<NewApiSessionSummary, String> {
    if code.trim().is_empty() || state.trim().is_empty() {
        return Err("OAuth 回调缺少授权码或 state".to_string());
    }

    let pending = PENDING_OAUTH
        .lock()
        .map_err(|_| "OAuth 状态锁不可用".to_string())?
        .clone()
        .ok_or_else(|| "登录请求已失效，请重新发起登录".to_string())?;
    if pending.state != state {
        return Err("OAuth state 校验失败，请重新登录".to_string());
    }
    if now_unix() - pending.created_at > OAUTH_TTL_SECONDS {
        return Err("OAuth 登录请求已过期，请重新登录".to_string());
    }

    let response = client()?
        .post(endpoint(&pending.server_url, LEGACY_TOKEN_PATH))
        .form(&[
            ("code", code.trim()),
            ("code_verifier", pending.verifier.as_str()),
            ("state", pending.state.as_str()),
            ("redirect_uri", pending.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("交换登录凭据失败: {e}"))?;
    let (status, value) = response_json(response).await?;
    if !status.is_success() {
        return Err(response_message(&value, "交换登录凭据失败"));
    }

    let access_token = value_string(value.get("access_token"));
    let user_id = value_i64(value.get("user_id"));
    if access_token.is_empty() || user_id <= 0 {
        return Err("NewAPI 登录响应缺少 access_token 或 user_id".to_string());
    }
    let username = value_string(value.get("username"));
    let display_name = value_string(value.get("display_name")).or_else_value(&username);
    let session = StoredSession {
        server_url: pending.server_url,
        access_token,
        token_type: value_string(value.get("token_type")).or_else_value("Bearer"),
        user_id,
        username,
        display_name,
        role: value_i64(value.get("role")),
        created_at: now_unix(),
    };
    save_session(&session)?;
    *PENDING_OAUTH
        .lock()
        .map_err(|_| "OAuth 状态锁不可用".to_string())? = None;

    Ok(NewApiSessionSummary::from(&session))
}

#[tauri::command]
pub fn newapi_get_session() -> Result<Option<NewApiSessionSummary>, String> {
    load_session().map(|session| session.as_ref().map(NewApiSessionSummary::from))
}

#[tauri::command]
pub fn newapi_logout() -> Result<bool, String> {
    let path = session_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("无法清除本地登录会话: {e}"))?;
    }
    if let Ok(mut pending) = PENDING_OAUTH.lock() {
        *pending = None;
    }
    Ok(true)
}

#[tauri::command]
pub async fn newapi_get_bootstrap() -> Result<NewApiBootstrap, String> {
    let session = load_session()?.ok_or_else(|| "尚未登录 NewAPI".to_string())?;
    fetch_bootstrap(&session).await
}

#[tauri::command]
pub async fn newapi_get_api_info_routes() -> Result<Vec<NewApiInfoRoute>, String> {
    let session = load_session()?.ok_or_else(|| "尚未登录 NewAPI".to_string())?;
    fetch_api_info_routes(&session).await
}

#[tauri::command]
pub async fn newapi_ensure_group_tokens(group_id: String) -> Result<NewApiBootstrap, String> {
    let session = load_session()?.ok_or_else(|| "尚未登录 NewAPI".to_string())?;
    let group_id = group_id.trim();
    if group_id.is_empty() {
        return Err("未指定需要初始化密钥的分组".to_string());
    }
    let token_name = format!("desktop-{group_id}");
    if token_name.len() > 50 {
        return Err("分组标识过长，无法创建客户端密钥".to_string());
    }

    let client = client()?;
    let encoded_name =
        url::form_urlencoded::byte_serialize(token_name.as_bytes()).collect::<String>();
    let search_path = format!("/api/token/search?keyword={encoded_name}&p=1&size=100");
    let (search_status, search_value) = authenticated_get(&client, &session, &search_path).await?;
    if !search_status.is_success() {
        return Err(response_message(&search_value, "无法检查现有客户端密钥"));
    }

    let existing = api_token_items(&search_value)
        .iter()
        .find(|item| value_string(item.get("name")) == token_name);
    if let Some(existing) = existing {
        let enabled = value_i64(existing.get("status")) == 1;
        let matching_group = value_string(existing.get("group")) == group_id;
        if enabled && matching_group {
            return fetch_bootstrap(&session).await;
        }
        return Err("网站中已存在同名但不可用的客户端密钥，请先在密钥管理中处理".to_string());
    }

    let body = serde_json::json!({
        "name": token_name,
        "remain_quota": 0,
        "expired_time": -1,
        "unlimited_quota": true,
        "model_limits_enabled": false,
        "model_limits": "",
        "allow_ips": "",
        "group": group_id,
        "cross_group_retry": false,
    });
    let (status, value) = authenticated_post_json(&client, &session, "/api/token/", &body).await?;
    if !status.is_success()
        || value
            .get("success")
            .and_then(Value::as_bool)
            .is_some_and(|success| !success)
    {
        return Err(response_message(&value, "无法创建客户端密钥"));
    }
    fetch_bootstrap(&session).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_loopback_oauth_callback() {
        let callback =
            parse_loopback_oauth_target("/oauth/newapi?code=one-time-code&state=expected-state")
                .expect("loopback callback");
        assert_eq!(callback.code.as_deref(), Some("one-time-code"));
        assert_eq!(callback.state.as_deref(), Some("expected-state"));
    }

    #[test]
    fn rejects_non_oauth_loopback_path() {
        assert!(parse_loopback_oauth_target("/favicon.ico").is_none());
        assert!(parse_loopback_oauth_target("https://example.com/oauth/newapi").is_none());
    }

    #[tokio::test]
    async fn receives_loopback_callback_over_http() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("listener address");
        let receiver =
            tokio::spawn(
                async move { receive_loopback_callback(listener, "expected-state").await },
            );

        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream
            .write_all(
                b"GET /oauth/newapi?code=one-time-code&state=expected-state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("write callback");
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .await
            .expect("read response");

        let callback = receiver.await.expect("receiver task").expect("callback");
        assert_eq!(callback.code.as_deref(), Some("one-time-code"));
        assert!(String::from_utf8(response)
            .expect("HTTP response")
            .starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn normalizes_safe_server_url() {
        assert_eq!(
            normalize_server_url("https://api.example.com/root/"),
            Ok("https://api.example.com/root".to_string())
        );
        assert!(normalize_server_url("file:///tmp/newapi").is_err());
        assert!(normalize_server_url("https://user:pass@example.com").is_err());
        assert!(normalize_server_url("http://api.example.com").is_err());
        assert_eq!(
            normalize_server_url("http://127.0.0.1:3000/"),
            Ok("http://127.0.0.1:3000".to_string())
        );
    }

    #[test]
    fn prefers_enabled_desktop_tokens_for_each_group() {
        let value = serde_json::json!({
            "success": true,
            "data": {
                "items": [
                    { "id": 9, "name": "desktop-daily", "group": "daily", "status": 2 },
                    { "id": 8, "name": "daily", "group": "daily", "status": 1 },
                    { "id": 7, "name": "desktop-daily", "group": "daily", "status": 1 },
                    { "id": 6, "name": "unrelated", "group": "daily", "status": 1 },
                    { "id": 5, "name": "desktop-custom", "group": "custom", "status": 1 }
                ]
            }
        });

        let selected = preferred_group_token_ids(&value);
        assert_eq!(selected.get("daily"), Some(&7));
        assert_eq!(selected.get("custom"), Some(&5));
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn extracts_enabled_api_info_routes_from_status() {
        let value = serde_json::json!({
            "success": true,
            "data": {
                "api_info_enabled": true,
                "api_info": [
                    {
                        "id": 1,
                        "route": "默认线路",
                        "description": "默认",
                        "url": "https://vvcode.top",
                        "color": "green"
                    },
                    { "id": 2, "route": "空地址", "url": "" }
                ]
            }
        });

        assert_eq!(
            api_info_routes(&value),
            vec![NewApiInfoRoute {
                id: "1".to_string(),
                route: "默认线路".to_string(),
                description: "默认".to_string(),
                url: "https://vvcode.top".to_string(),
                color: "green".to_string(),
            }]
        );
    }

    #[test]
    fn accepts_json_encoded_api_info_and_respects_disabled_setting() {
        let encoded = serde_json::json!({
            "data": {
                "api_info_enabled": true,
                "api_info": "[{\"id\":3,\"route\":\"香港节点\",\"url\":\"https://hk.vvcode.top\"}]"
            }
        });
        assert_eq!(api_info_routes(&encoded).len(), 1);

        let disabled = serde_json::json!({
            "data": {
                "api_info_enabled": false,
                "api_info": [{ "url": "https://should-not-appear.example" }]
            }
        });
        assert!(api_info_routes(&disabled).is_empty());
    }

    #[test]
    fn merges_full_standard_token_keys_into_group_metadata() {
        let mut groups = BTreeMap::from([(
            "daily".to_string(),
            serde_json::json!({ "type": "daily", "name": "日常组", "baseUrl": "" }),
        )]);
        let ids = BTreeMap::from([("daily".to_string(), 7), ("custom".to_string(), 5)]);
        let keys = serde_json::json!({
            "success": true,
            "data": { "keys": { "7": "daily-key", "5": "sk-custom-key" } }
        });

        merge_group_token_keys(&mut groups, &ids, &keys, "https://api.example.com");

        assert_eq!(
            groups["daily"].get("apiKey").and_then(Value::as_str),
            Some("sk-daily-key")
        );
        assert_eq!(
            groups["daily"].get("baseUrl").and_then(Value::as_str),
            Some("https://api.example.com")
        );
        assert_eq!(
            groups["custom"].get("apiKey").and_then(Value::as_str),
            Some("sk-custom-key")
        );
    }
}
