//! Single-provider NewAPI desktop integration.
//!
//! OAuth secrets and management requests stay in the Rust process. The
//! renderer only receives a redacted session summary and normalized product
//! catalog data.

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;


const DESKTOP_GROUPS_PATH: &str = "/api/desktop/groups";
const USER_GROUPS_PATH: &str = "/api/user/self/groups";
const STATUS_PATH: &str = "/api/status";
const SESSION_FILE: &str = "newapi-session.json";
const MAX_LOOPBACK_HEADER_BYTES: usize = 16 * 1024;
/// 浏览器在真正发送回跳请求前可能先对回跳端口建立探测连接（连接后不发
/// 数据或立即断开，常见于 Chrome/Edge 的 speculative preconnect 和安全软件
/// 的端口扫描）。单个连接等待请求数据的上限，超时或读到空请求时放弃该
/// 连接并继续等待真正的回调。
const LOOPBACK_CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);



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

fn group_models_from_value(value: &Value) -> Result<Vec<String>, String> {
    let items = data(value)
        .as_array()
        .ok_or_else(|| "NewAPI 返回了无效的分组模型列表".to_string())?;
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for item in items {
        let model = value_string(Some(item)).trim().to_string();
        if !model.is_empty() && seen.insert(model.clone()) {
            models.push(model);
        }
    }
    Ok(models)
}

fn group_from_value(id: String, value: &Value, server_url: &str) -> NewApiGroup {
    let object = value.as_object();
    let ratio = object
        .map(|item| value_string(item.get("ratio")))
        .filter(|ratio| !ratio.trim().is_empty())
        .unwrap_or_else(|| {
            let direct = value_string(Some(value));
            if direct.trim().is_empty() {
                "1".to_string()
            } else {
                direct
            }
        });
    let name = object
        .map(|item| value_string(item.get("name")))
        .unwrap_or_default()
        .or_else_value(&id);
    let base_url = object
        .map(|item| value_string(item.get("baseUrl").or_else(|| item.get("base_url"))))
        .unwrap_or_default()
        .or_else_value(server_url);
    let models = object
        .and_then(|item| item.get("models"))
        .cloned()
        .and_then(|models| serde_json::from_value(models).ok())
        .unwrap_or_default();
    let connections = object
        .and_then(|item| item.get("connections"))
        .cloned()
        .and_then(|connections| serde_json::from_value(connections).ok())
        .unwrap_or_default();

    NewApiGroup {
        id,
        name,
        description: object
            .map(|item| value_string(item.get("desc").or_else(|| item.get("description"))))
            .unwrap_or_default(),
        ratio,
        base_url,
        api_key: object
            .map(|item| value_string(item.get("apiKey").or_else(|| item.get("api_key"))))
            .unwrap_or_default(),
        default_model_id: object
            .map(|item| {
                value_string(
                    item.get("defaultModelId")
                        .or_else(|| item.get("default_model_id")),
                )
            })
            .unwrap_or_default(),
        api_provider: object
            .map(|item| value_string(item.get("apiProvider").or_else(|| item.get("api_provider"))))
            .unwrap_or_default(),
        cc_provider: object
            .map(|item| value_string(item.get("ccProvider").or_else(|| item.get("cc_provider"))))
            .unwrap_or_default(),
        is_default: object
            .and_then(|item| item.get("isDefault").or_else(|| item.get("is_default")))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        models,
        connections,
    }
}

fn groups_from_value(value: &Value, server_url: &str) -> Result<Vec<NewApiGroup>, String> {
    let payload = data(value);
    let mut groups = match payload {
        Value::Object(items) => items
            .iter()
            .filter(|(id, _)| !id.trim().is_empty())
            .map(|(id, item)| group_from_value(id.clone(), item, server_url))
            .collect::<Vec<_>>(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                let id = value_string(item.get("id").or_else(|| item.get("type")));
                (!id.trim().is_empty()).then(|| group_from_value(id, item, server_url))
            })
            .collect::<Vec<_>>(),
        _ => return Err("NewAPI 返回了无效的用户分组列表".to_string()),
    };

    groups.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(groups)
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

const MANAGED_TOKEN_PREFIX: &str = "desktop-";
const MANAGED_TOKEN_NAME_MAX_LEN: usize = 50;
const MANAGED_TOKEN_SUFFIX_LIMIT: usize = 100;

fn managed_token_name(group_id: &str, suffix: Option<usize>) -> Result<String, String> {
    let suffix = suffix.map(|value| format!("-{value}")).unwrap_or_default();
    let max_group_bytes = MANAGED_TOKEN_NAME_MAX_LEN
        .checked_sub(MANAGED_TOKEN_PREFIX.len() + suffix.len())
        .ok_or_else(|| "分组标识过长，无法创建客户端密钥".to_string())?;

    if suffix.is_empty() && group_id.len() > max_group_bytes {
        return Err("分组标识过长，无法创建客户端密钥".to_string());
    }

    // 后缀候选需要为序号腾出空间；按 UTF-8 字符边界截断，避免切坏分组名。
    let mut group_part = String::new();
    for character in group_id.chars() {
        if group_part.len() + character.len_utf8() > max_group_bytes {
            break;
        }
        group_part.push(character);
    }
    if group_part.is_empty() {
        return Err("分组标识过长，无法创建客户端密钥".to_string());
    }

    Ok(format!("{MANAGED_TOKEN_PREFIX}{group_part}{suffix}"))
}

fn token_matches_group(token: &Value, group_id: &str) -> bool {
    value_i64(token.get("status")) == 1 && value_string(token.get("group")) == group_id
}

fn token_id(token: &Value) -> Result<i64, String> {
    let id = value_i64(token.get("id"));
    if id <= 0 {
        return Err("网站返回了无效的客户端密钥标识".to_string());
    }
    Ok(id)
}

fn managed_token_rank(token_name: &str, base_name: &str) -> Option<usize> {
    if token_name == base_name {
        return Some(0);
    }

    let suffix = token_name.strip_prefix(&format!("{base_name}-"))?;
    suffix.parse::<usize>().ok().filter(|suffix| *suffix >= 2)
}

async fn find_named_token(
    client: &Client,
    session: &StoredSession,
    token_name: &str,
) -> Result<Option<Value>, String> {
    let encoded_name =
        url::form_urlencoded::byte_serialize(token_name.as_bytes()).collect::<String>();
    let search_path = format!("/api/token/search?keyword={encoded_name}&p=1&size=100");
    let (status, value) = authenticated_get(client, session, &search_path).await?;
    if !status.is_success() {
        return Err(response_message(&value, "无法检查现有客户端密钥"));
    }

    Ok(api_token_items(&value)
        .iter()
        .find(|item| value_string(item.get("name")) == token_name)
        .cloned())
}

async fn find_managed_group_token(
    client: &Client,
    session: &StoredSession,
    group_id: &str,
) -> Result<Option<Value>, String> {
    let base_name = managed_token_name(group_id, None)?;
    // NewAPI 的 keyword 搜索通常只返回精确名称，无法发现 `-2` 这类后缀密钥。
    // 读取当前用户的首批密钥后再按名称、分组和状态在本地筛选。
    let search_path = "/api/token/search?keyword=&p=1&size=100";
    let (status, value) = authenticated_get(client, session, &search_path).await?;
    if !status.is_success() {
        return Err(response_message(&value, "无法检查现有客户端密钥"));
    }

    Ok(api_token_items(&value)
        .iter()
        .filter(|token| token_matches_group(token, group_id))
        .filter_map(|token| {
            managed_token_rank(&value_string(token.get("name")), &base_name)
                .map(|rank| (rank, token))
        })
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, token)| token.clone()))
}

async fn create_group_token(
    client: &Client,
    session: &StoredSession,
    group_id: &str,
    token_name: &str,
) -> Result<i64, String> {
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
    let (status, value) = authenticated_post_json(client, session, "/api/token/", &body).await?;
    if !response_succeeded(status, &value) {
        return Err(response_message(&value, "无法创建客户端密钥"));
    }

    let token = find_named_token(client, session, token_name)
        .await?
        .ok_or_else(|| "网站未返回新建的客户端密钥".to_string())?;
    if !token_matches_group(&token, group_id) {
        return Err("网站返回的新客户端密钥不可用".to_string());
    }
    token_id(&token)
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

async fn fetch_bootstrap_with_client(
    client: &Client,
    session: &StoredSession,
    app: Option<&str>,
) -> Result<NewApiBootstrap, String> {
    let (value, source) = if let Some(app) = app.map(str::trim).filter(|app| !app.is_empty()) {
        let path = desktop_groups_path(app);
        let (status, value) = authenticated_get(client, session, &path).await?;
        let success = response_succeeded(status, &value);
        if success {
            (value, "desktop-groups")
        } else if should_fallback_to_user_groups(status) {
            fetch_user_groups(client, session).await?
        } else {
            return Err(response_message(&value, "无法获取当前应用的可用分组"));
        }
    } else {
        fetch_user_groups(client, session).await?
    };

    Ok(NewApiBootstrap {
        user: user_from_value(&Value::Null, session),
        groups: groups_from_value(&value, &session.server_url)?,
        source: source.to_string(),
    })
}

fn response_succeeded(status: StatusCode, value: &Value) -> bool {
    status.is_success()
        && !value
            .get("success")
            .and_then(Value::as_bool)
            .is_some_and(|success| !success)
}

fn should_fallback_to_user_groups(status: StatusCode) -> bool {
    matches!(status, StatusCode::NOT_FOUND | StatusCode::NOT_IMPLEMENTED)
}

fn desktop_groups_path(app: &str) -> String {
    let encoded_app = url::form_urlencoded::byte_serialize(app.as_bytes()).collect::<String>();
    format!("{DESKTOP_GROUPS_PATH}?app={encoded_app}")
}

async fn fetch_user_groups(
    client: &Client,
    session: &StoredSession,
) -> Result<(Value, &'static str), String> {
    let (status, value) = authenticated_get(client, session, USER_GROUPS_PATH).await?;
    if !response_succeeded(status, &value) {
        return Err(response_message(&value, "无法获取用户可用分组"));
    }
    Ok((value, "user-groups"))
}

async fn fetch_bootstrap(
    session: &StoredSession,
    app: Option<&str>,
) -> Result<NewApiBootstrap, String> {
    fetch_bootstrap_with_client(&client()?, session, app).await
}

async fn fetch_bootstrap_with_group_key(
    client: &Client,
    session: &StoredSession,
    app: Option<&str>,
    group_id: &str,
    token_id: i64,
) -> Result<NewApiBootstrap, String> {
    let mut bootstrap = fetch_bootstrap_with_client(client, session, app).await?;
    let body = serde_json::json!({ "ids": [token_id] });
    let (status, value) =
        authenticated_post_json(client, session, "/api/token/batch/keys", &body).await?;
    if !status.is_success()
        || value
            .get("success")
            .and_then(Value::as_bool)
            .is_some_and(|success| !success)
    {
        return Err(response_message(&value, "无法读取客户端密钥"));
    }
    let raw_key = data(&value)
        .get("keys")
        .and_then(Value::as_object)
        .and_then(|keys| keys.get(&token_id.to_string()))
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "网站未返回当前分组的客户端密钥".to_string())?;
    let api_key = if raw_key.starts_with("sk-") {
        raw_key.to_string()
    } else {
        format!("sk-{raw_key}")
    };
    let group = bootstrap
        .groups
        .iter_mut()
        .find(|group| group.id == group_id)
        .ok_or_else(|| "当前账号已无法使用所选分组".to_string())?;
    group.api_key = api_key;
    Ok(bootstrap)
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



fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
    Ok(true)
}

#[tauri::command]
pub async fn newapi_get_bootstrap(app: Option<String>) -> Result<NewApiBootstrap, String> {
    let session = load_session()?.ok_or_else(|| "尚未登录 NewAPI".to_string())?;
    fetch_bootstrap(&session, app.as_deref()).await
}

#[tauri::command]
pub async fn newapi_get_api_info_routes() -> Result<Vec<NewApiInfoRoute>, String> {
    let session = load_session()?.ok_or_else(|| "尚未登录 NewAPI".to_string())?;
    fetch_api_info_routes(&session).await
}

#[tauri::command]
pub async fn newapi_get_group_models(group_id: String) -> Result<Vec<String>, String> {
    let session = load_session()?.ok_or_else(|| "尚未登录 NewAPI".to_string())?;
    let group_id = group_id.trim();
    if group_id.is_empty() {
        return Err("未指定需要获取模型的分组".to_string());
    }

    let encoded_group =
        url::form_urlencoded::byte_serialize(group_id.as_bytes()).collect::<String>();
    let path = format!("/api/user/models?group={encoded_group}");
    let client = client()?;
    let (status, value) = authenticated_get(&client, &session, &path).await?;
    if !status.is_success()
        || value
            .get("success")
            .and_then(Value::as_bool)
            .is_some_and(|success| !success)
    {
        return Err(response_message(&value, "无法获取分组可用模型"));
    }
    group_models_from_value(&value)
}

#[tauri::command]
pub async fn newapi_ensure_group_tokens(
    group_id: String,
    app: Option<String>,
    create_replacement_key: Option<bool>,
) -> Result<NewApiBootstrap, String> {
    let session = load_session()?.ok_or_else(|| "尚未登录 NewAPI".to_string())?;
    let group_id = group_id.trim();
    if group_id.is_empty() {
        return Err("未指定需要初始化密钥的分组".to_string());
    }

    let client = client()?;
    if let Some(existing) = find_managed_group_token(&client, &session, group_id).await? {
        return fetch_bootstrap_with_group_key(
            &client,
            &session,
            app.as_deref(),
            group_id,
            token_id(&existing)?,
        )
        .await;
    }

    let first_attempt = usize::from(create_replacement_key.unwrap_or(false));
    let replacement_attempts = if create_replacement_key.unwrap_or(false) {
        MANAGED_TOKEN_SUFFIX_LIMIT - 1
    } else {
        0
    };
    for attempt in first_attempt..=replacement_attempts {
        let suffix = (attempt > 0).then_some(attempt + 1);
        let token_name = managed_token_name(group_id, suffix)?;
        match find_named_token(&client, &session, &token_name).await? {
            Some(existing) if token_matches_group(&existing, group_id) => {
                return fetch_bootstrap_with_group_key(
                    &client,
                    &session,
                    app.as_deref(),
                    group_id,
                    token_id(&existing)?,
                )
                .await;
            }
            Some(_) if suffix.is_none() => {
                return Err("客户端密钥不可用，请点击重试".to_string());
            }
            Some(_) => continue,
            None => {
                let token_id = create_group_token(&client, &session, group_id, &token_name).await?;
                return fetch_bootstrap_with_group_key(
                    &client,
                    &session,
                    app.as_deref(),
                    group_id,
                    token_id,
                )
                .await;
            }
        }
    }

    Err("网站中已存在过多不可用的客户端密钥，请先在密钥管理中清理后重试".to_string())
}

// ---------------------------------------------------------------------------
// 应用内登录：在 webview 里完成站点登录，接管用户创建的 scoped 访问令牌
// ---------------------------------------------------------------------------

/// 新版 new-api 把面板凭据换成了 scoped 访问令牌（`nap_` 前缀），只允许在
/// 浏览器会话里创建，且创建前必须通过一次安全验证。桌面端因此改在应用内的
/// webview 里完成整个流程：
/// 1. 打开站点安全设置页，用户在页面里登录；
/// 2. 用户按提示创建访问令牌（安全验证在站点页面里完成，凭据不经过客户端）；
/// 3. 注入脚本截获创建响应，把令牌回传到本地端口，应用写入会话并关闭窗口。
const ACCESS_TOKENS_PATH: &str = "/api/user/access_tokens";
const SECURITY_PAGE_PATH: &str = "/security";
const PAT_LOGIN_WINDOW: &str = "vvcode-pat-login";
const PAT_LOGIN_TTL_SECONDS: u64 = 15 * 60;
const PAT_TOKEN_CALLBACK_PATH: &str = "/vvcode-token";
/// 桌面端实际调用的接口需要的权限，必须与站点
/// `middleware/access_token_routes.go` 中声明的 scope 保持一致。
const DESKTOP_TOKEN_SCOPES: [&str; 4] = [
    "profile:read",
    "api_key:read",
    "api_key:write",
    "api_key:reveal",
];

const PAT_LOGIN_SCRIPT: &str = r#"(function () {
  var PORT = "__PORT__";
  var TARGET = "__TARGET__";
  var CALLBACK = "http://127.0.0.1:" + PORT + "/vvcode-token?t=";
  var SCOPES = __SCOPES__;
  var finished = false;
  var creds = null;
  var jwt = null;
  var creating = false;

  function finish(token) {
    if (finished) return;
    finished = true;
    window.location.href = CALLBACK + encodeURIComponent(token);
  }

  var CARD_STYLE =
    "position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);" +
    "display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);" +
    "padding:12px 16px;border-radius:14px;border:1px solid rgba(255,255,255,.35);" +
    "background:linear-gradient(90deg,#4c1d95,#6d28d9);color:#fff;" +
    "font:500 13px/1.6 system-ui,-apple-system,sans-serif;" +
    "box-shadow:0 16px 40px rgba(76,29,149,.45),0 2px 6px rgba(0,0,0,.18)";
  var PRIMARY_BUTTON_STYLE =
    "height:34px;padding:0 16px;border:0;border-radius:9px;cursor:pointer;background:#fff;color:#4c1d95;" +
    "font:600 13px/1 system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.15);white-space:nowrap";
  var SECONDARY_BUTTON_STYLE =
    "height:34px;padding:0 14px;border:1px solid rgba(255,255,255,.6);border-radius:9px;cursor:pointer;" +
    "background:transparent;color:#fff;font:13px/1 system-ui,-apple-system,sans-serif;white-space:nowrap";
  var INPUT_STYLE =
    "height:34px;min-width:200px;padding:0 12px;border-radius:9px;border:2px solid #fbbf24;" +
    "background:#fff;color:#211b35;font:13px/1.4 system-ui,-apple-system,sans-serif;outline:none;" +
    "box-shadow:0 0 0 3px rgba(251,191,36,.25)";

  function clearBar() {
    var existing = document.getElementById("vvcode-login-hint");
    if (existing) existing.remove();
  }

  function hint(message, closable) {
    clearBar();
    if (!document.body) return;
    var bar = document.createElement("div");
    bar.id = "vvcode-login-hint";
    var text = document.createElement("span");
    text.textContent = message;
    bar.appendChild(text);
    if (closable) {
      var close = document.createElement("button");
      close.type = "button";
      close.textContent = "知道了";
      close.style.cssText = SECONDARY_BUTTON_STYLE;
      close.onclick = function () { bar.remove(); };
      bar.appendChild(close);
    }
    bar.style.cssText = CARD_STYLE;
    document.body.appendChild(bar);
  }

  function inspectCreate(body) {
    try {
      var data = body && body.data ? body.data : null;
      var raw = data && typeof data.token === "string" ? data.token : "";
      if (!raw) return;
      var scopes = (data.item && data.item.scopes) || [];
      var missing = SCOPES.filter(function (scope) { return scopes.indexOf(scope) < 0; });
      if (missing.length) {
        hint("这张访问令牌权限不足，请重新创建并勾选 Profile 的查看与 API keys 的查看/创建/查看完整密钥。缺少：" + missing.join("、"), true);
        return;
      }
      finish(raw);
    } catch (error) {}
  }

  function requestError(stage, response, json, fallbackMessage) {
    var error = new Error((json && json.message) || fallbackMessage);
    error.stage = stage;
    error.status = response ? response.status : 0;
    error.code = (json && json.code) || "";
    return error;
  }

  async function autoCreate() {
    if (creating || finished || !creds || !jwt) return;
    creating = true;
    try {
      var context = { scopes: SCOPES, expires_at: 0 };
      var verifyBody = {
        method: "password",
        scope: "access_token.generate",
        context: context
      };
      if (creds.password) {
        verifyBody.password = creds.password;
      } else {
        verifyBody.password_encrypted = creds.password_encrypted;
        verifyBody.encryption_key_id = creds.encryption_key_id;
      }
      var verified = await fetch("/api/verify", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + jwt },
        body: JSON.stringify(verifyBody)
      });
      var verifyJson = await verified.json().catch(function () { return null; });
      creds = null;
      var proof = verifyJson && verifyJson.data && verifyJson.data.proof_token;
      if (!proof) throw requestError("verify", verified, verifyJson, "安全验证未通过");

      var created = await fetch(TARGET, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + jwt,
          "X-Security-Proof": proof
        },
        body: JSON.stringify({
          name: "VV Code 桌面端",
          scopes: SCOPES,
          expires_at: 0
        })
      });
      var createdJson = await created.json().catch(function () { return null; });
      var token = createdJson && createdJson.data && createdJson.data.token;
      if (!token) throw requestError("create", created, createdJson, "创建访问令牌失败");
      finish(token);
    } catch (error) {
      creating = false;
      creds = null;
      var detail = (error && error.message ? error.message : "未知原因") +
        (error && error.status ? " · HTTP " + error.status : "") +
        (error && error.code ? " · " + error.code : "");
      if (error && error.stage === "verify" && jwt) {
        // 密码没通过校验时停在原地让用户重输，不要直接把人推到手动流程。
        askPassword("自动创建失败：" + detail);
        return;
      }
      hint(
        "自动创建访问令牌没有成功（" + detail +
        "）。请在「访问令牌」里手动创建：勾选 Profile 的查看和 API keys 的查看/创建/查看完整密钥，有效期选永不过期。",
        true
      );
    }
  }

  var originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      var pending = originalFetch.apply(this, arguments);
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        if (method === "POST" && url.indexOf("/api/user/login") !== -1 && url.indexOf("/login/") === -1) {
          var bodyText = init && typeof init.body === "string" ? init.body : null;
          pending.then(function (response) {
            if (!response || !response.ok) return;
            return response.clone().json().then(function (json) {
              try {
                var payload = bodyText ? JSON.parse(bodyText) : null;
                if (payload && typeof payload.password === "string" && payload.password) {
                  creds = { password: payload.password };
                } else if (payload && payload.password_encrypted && payload.encryption_key_id) {
                  creds = {
                    password_encrypted: payload.password_encrypted,
                    encryption_key_id: payload.encryption_key_id
                  };
                }
                var data = json && json.data;
                if (data && typeof data.access_token === "string" && data.access_token) {
                  jwt = data.access_token;
                }
                void autoCreate();
              } catch (error) {}
            }).catch(function () {});
          }).catch(function () {});
        }
        if (method === "POST" && url.indexOf(TARGET) !== -1) {
          pending.then(function (response) {
            if (response && response.ok) {
              response.clone().json().then(inspectCreate).catch(function () {});
            }
          }).catch(function () {});
        }
      } catch (error) {}
      return pending;
    };
  }

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__vvcodeRequest = { method: method, url: String(url) };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var meta = xhr.__vvcodeRequest || {};
    var method = String(meta.method || "GET").toUpperCase();
    var url = String(meta.url || "");
    if (method === "POST" && url.indexOf("/api/user/login") !== -1 && url.indexOf("/login/") === -1) {
      xhr.addEventListener("load", function () {
        try {
          if (xhr.status < 200 || xhr.status >= 300) return;
          var payload = typeof body === "string" ? JSON.parse(body) : null;
          if (payload && typeof payload.password === "string" && payload.password) {
            creds = { password: payload.password };
          } else if (payload && payload.password_encrypted && payload.encryption_key_id) {
            creds = {
              password_encrypted: payload.password_encrypted,
              encryption_key_id: payload.encryption_key_id
            };
          }
          var json = JSON.parse(xhr.responseText);
          var data = json && json.data;
          if (data && typeof data.access_token === "string" && data.access_token) {
            jwt = data.access_token;
          }
          void autoCreate();
        } catch (error) {}
      });
    }
    if (method === "POST" && url.indexOf(TARGET) !== -1) {
      xhr.addEventListener("load", function () {
        try {
          if (xhr.status >= 200 && xhr.status < 300) {
            inspectCreate(JSON.parse(xhr.responseText));
          }
        } catch (error) {}
      });
    }
    return send.apply(this, arguments);
  };

  async function ensureJwt() {
    if (jwt) return true;
    try {
      var response = await fetch("/api/user/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" }
      });
      if (!response.ok) return false;
      var json = await response.json();
      var token = json && json.data && json.data.access_token;
      if (!token) return false;
      jwt = token;
      return true;
    } catch (error) {
      return false;
    }
  }

  function askPassword(notice) {
    clearBar();
    if (!document.body) return;
    var wrapper = document.createElement("div");
    wrapper.id = "vvcode-login-hint";
    wrapper.style.cssText = CARD_STYLE;

    if (notice) {
      var noticeLine = document.createElement("span");
      noticeLine.style.cssText = "color:#fde68a;font-weight:600;max-width:360px";
      noticeLine.textContent = notice;
      wrapper.appendChild(noticeLine);
    }

    var label = document.createElement("span");
    label.style.cssText = "color:#fff;font-weight:600;white-space:nowrap";
    label.textContent = notice ? "重新输入密码" : "自动创建访问令牌：请输入账号密码";

    var input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "current-password";
    input.placeholder = "账号密码";
    input.style.cssText = INPUT_STYLE;

    var confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "自动创建";
    confirm.style.cssText = PRIMARY_BUTTON_STYLE;

    var skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = "手动创建";
    skip.style.cssText = SECONDARY_BUTTON_STYLE;

    confirm.onclick = function () {
      var value = input.value;
      if (!value) {
        input.focus();
        return;
      }
      creds = { password: value };
      wrapper.remove();
      void autoCreate();
    };
    input.onkeydown = function (event) {
      if (event.key === "Enter") confirm.click();
    };
    skip.onclick = function () {
      wrapper.remove();
      hint(
        "请在「访问令牌」里手动创建：勾选 Profile 的查看和 API keys 的查看/创建/查看完整密钥，有效期选永不过期。",
        true
      );
    };
    wrapper.appendChild(label);
    wrapper.appendChild(input);
    wrapper.appendChild(confirm);
    wrapper.appendChild(skip);
    document.body.appendChild(wrapper);
    input.focus();
  }

  function onReady() {
    if (finished) return;
    // 登录动作发生在本窗口时密码已经拿到，直接自动创建；否则（会话仍然
    // 有效、或第三方登录）让用户补一次密码，其余步骤仍然自动。
    if (creds) {
      void autoCreate();
      return;
    }
    window.setTimeout(function () {
      if (finished || creating || creds) return;
      void ensureJwt().then(function (ok) {
        if (finished || creating || creds) return;
        if (ok) {
          askPassword();
          return;
        }
        hint(
          "登录后点「创建访问令牌」：勾选 Profile 的“查看”和 API keys 的“查看 / 创建 / 查看完整密钥”，有效期选“永不过期”。完成后本窗口自动关闭。",
          true
        );
      });
    }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();"#;

fn pat_login_script(port: u16) -> String {
    let scopes = DESKTOP_TOKEN_SCOPES
        .iter()
        .map(|scope| format!("\"{scope}\""))
        .collect::<Vec<_>>()
        .join(", ");
    PAT_LOGIN_SCRIPT
        .replace("__PORT__", &port.to_string())
        .replace("__TARGET__", ACCESS_TOKENS_PATH)
        .replace("__SCOPES__", &format!("[{scopes}]"))
}

/// 在应用内打开站点安全设置页完成登录，返回已写入本地会话的摘要。
#[tauri::command]
pub async fn newapi_pat_login_begin(
    app: AppHandle,
    server_url: String,
) -> Result<NewApiSessionSummary, String> {
    let server_url = normalize_server_url(&server_url)?;
    // 上一次登录窗口可能还在销毁过程中，先用 destroy 立刻摘掉，再换一个唯一
    // label 建新窗口，避免 “a webview with label ... already exists”。
    for (label, existing) in app.webview_windows() {
        if label.starts_with(PAT_LOGIN_WINDOW) {
            let _ = existing.destroy();
        }
    }
    let window_label = format!("{PAT_LOGIN_WINDOW}-{}", now_unix());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("无法启动本地登录回调监听: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("无法读取本地登录回调端口: {e}"))?
        .port();
    let login_url = Url::parse(&format!("{server_url}{SECURITY_PAGE_PATH}"))
        .map_err(|e| format!("登录地址无效: {e}"))?;

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        window_label.as_str(),
        tauri::WebviewUrl::External(login_url),
    )
    .title(format!("登录 {}", crate::vvcode::brand::DISPLAY_NAME))
    .inner_size(1024.0, 780.0)
    .center()
    .initialization_script(&pat_login_script(port))
    .build()
    .map_err(|e| format!("无法打开登录窗口: {e}"))?;

    // 用户直接关窗口时没有回调请求，主界面不能一直停在“等待登录完成”。
    let closed = Arc::new(AtomicBool::new(false));
    let closed_flag = closed.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            closed_flag.store(true, Ordering::SeqCst);
        }
    });

    let token = match tokio::time::timeout(
        Duration::from_secs(PAT_LOGIN_TTL_SECONDS),
        receive_pat_login_token(listener, &app, window_label.as_str(), &closed),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("登录窗口等待超时，请重新登录".to_string()),
    };
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.destroy();
    }
    focus_main_window(&app);

    let session = session_from_access_token(&server_url, &token?).await?;
    save_session(&session)?;
    Ok(NewApiSessionSummary::from(&session))
}

async fn receive_pat_login_token(
    listener: TcpListener,
    app: &AppHandle,
    window_label: &str,
    closed: &AtomicBool,
) -> Result<String, String> {
    loop {
        let accepted = tokio::time::timeout(Duration::from_secs(1), listener.accept()).await;
        let (mut stream, peer) = match accepted {
            Ok(Ok(pair)) => pair,
            Ok(Err(error)) => return Err(format!("等待登录结果失败: {error}")),
            Err(_) => {
                // 用户关掉登录窗口后不再空等，直接结束本次登录。
                if closed.load(Ordering::SeqCst)
                    || app.get_webview_window(window_label).is_none()
                {
                    return Err("登录窗口已关闭，登录未完成".to_string());
                }
                continue;
            }
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let target = match tokio::time::timeout(
            LOOPBACK_CONNECTION_TIMEOUT,
            read_loopback_target(&mut stream),
        )
        .await
        {
            Ok(Ok(target)) => target,
            Ok(Err(error)) => {
                log::warn!("忽略无效的登录回调连接: {error}");
                continue;
            }
            Err(_) => continue,
        };
        if closed.load(Ordering::SeqCst) {
            return Err("登录窗口已关闭，登录未完成".to_string());
        }
        let Some(token) = parse_pat_login_target(&target) else {
            let message = format!(
                "此本地地址仅用于接收 {} 登录结果。",
                crate::vvcode::brand::DISPLAY_NAME
            );
            write_loopback_page(&mut stream, "404 Not Found", "页面不存在", &message).await;
            continue;
        };
        write_loopback_page(
            &mut stream,
            "200 OK",
            "登录信息已返回",
            "可以关闭此窗口，应用正在完成登录。",
        )
        .await;
        return Ok(token);
    }
}

fn parse_pat_login_target(target: &str) -> Option<String> {
    let (path, query) = target.split_once('?')?;
    if path != PAT_TOKEN_CALLBACK_PATH {
        return None;
    }
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "t")
        .map(|(_, value)| value.trim().to_string())
        .filter(|token| !token.is_empty())
}

/// 用刚拿到的访问令牌验证一次并组装本地会话（用户信息取自服务端，不信任
/// 前端传入）。
async fn session_from_access_token(
    server_url: &str,
    access_token: &str,
) -> Result<StoredSession, String> {
    let client = client()?;
    let response = client
        .get(endpoint(server_url, "/api/user/self"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("校验访问令牌失败: {e}"))?;
    let (status, value) = response_json(response).await?;
    if !status.is_success() {
        return Err(response_message(&value, "访问令牌无效，请重新登录"));
    }
    let user = data(&value);
    let user_id = value_i64(user.get("id"));
    let username = value_string(user.get("username"));
    if user_id <= 0 || username.is_empty() {
        return Err("读取账号信息失败，请重新登录".to_string());
    }
    let display_name = value_string(user.get("display_name")).or_else_value(&username);
    Ok(StoredSession {
        server_url: server_url.to_string(),
        access_token: access_token.to_string(),
        token_type: "Bearer".to_string(),
        user_id,
        username,
        display_name,
        role: value_i64(user.get("role")),
        created_at: now_unix(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pat_login_callback() {
        assert_eq!(
            parse_pat_login_target("/vvcode-token?t=nap_abc123").as_deref(),
            Some("nap_abc123")
        );
        // 令牌里的特殊字符会被浏览器编码，解析时要还原。
        assert_eq!(
            parse_pat_login_target("/vvcode-token?t=nap_a%2Bb%3D").as_deref(),
            Some("nap_a+b=")
        );
        assert_eq!(parse_pat_login_target("/oauth/newapi?code=abc"), None);
        assert_eq!(parse_pat_login_target("/vvcode-token?t="), None);
        assert_eq!(parse_pat_login_target("/vvcode-token"), None);
    }

    #[test]
    fn injects_login_callback_port_and_scopes_into_script() {
        let script = pat_login_script(4321);
        assert!(script.contains("var PORT = \"4321\""));
        assert!(script.contains("http://127.0.0.1:\" + PORT"));
        assert!(script.contains(&format!("var TARGET = \"{ACCESS_TOKENS_PATH}\"")));
        for scope in DESKTOP_TOKEN_SCOPES {
            assert!(script.contains(&format!("\"{scope}\"")));
        }
        // 占位符必须全部替换，残留会让注入脚本直接报语法错误。
        assert!(!script.contains("__PORT__"));
        assert!(!script.contains("__TARGET__"));
        assert!(!script.contains("__SCOPES__"));
    }

    #[test]
    fn managed_token_name_uses_a_suffix_for_a_replacement_key() {
        assert_eq!(
            managed_token_name("daily-codex-pro", Some(2)).unwrap(),
            "desktop-daily-codex-pro-2"
        );
    }

    #[test]
    fn managed_token_name_truncates_only_suffixed_candidates() {
        let group_id = "a".repeat(42);
        assert_eq!(
            managed_token_name(&group_id, None).unwrap(),
            format!("desktop-{group_id}")
        );

        let replacement = managed_token_name(&group_id, Some(2)).unwrap();
        assert_eq!(replacement.len(), MANAGED_TOKEN_NAME_MAX_LEN);
        assert!(replacement.ends_with("-2"));
    }

    #[test]
    fn managed_token_rank_recognizes_only_managed_suffixes() {
        let base = "desktop-daily";

        assert_eq!(managed_token_rank(base, base), Some(0));
        assert_eq!(managed_token_rank("desktop-daily-2", base), Some(2));
        assert_eq!(managed_token_rank("desktop-daily-1", base), None);
        assert_eq!(managed_token_rank("desktop-daily-backup", base), None);
        assert_eq!(managed_token_rank("desktop-daily-pro-2", base), None);
    }

    #[test]
    fn parses_group_models_without_empty_or_duplicate_items() {
        let value = serde_json::json!({
            "success": true,
            "data": ["model-b", " ", "model-a", "model-b"]
        });
        assert_eq!(
            group_models_from_value(&value).unwrap(),
            vec!["model-b", "model-a"]
        );
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
    fn builds_encoded_desktop_group_paths() {
        assert_eq!(
            desktop_groups_path("claude-code"),
            "/api/desktop/groups?app=claude-code"
        );
        assert_eq!(
            desktop_groups_path("custom app"),
            "/api/desktop/groups?app=custom+app"
        );
    }

    #[test]
    fn falls_back_only_when_the_desktop_groups_endpoint_is_unavailable() {
        assert!(should_fallback_to_user_groups(StatusCode::NOT_FOUND));
        assert!(should_fallback_to_user_groups(StatusCode::NOT_IMPLEMENTED));
        assert!(!should_fallback_to_user_groups(StatusCode::UNAUTHORIZED));
        assert!(!should_fallback_to_user_groups(StatusCode::FORBIDDEN));
        assert!(!should_fallback_to_user_groups(
            StatusCode::TOO_MANY_REQUESTS
        ));
    }

    #[test]
    fn parses_standard_user_groups_response() {
        let value = serde_json::json!({
            "success": true,
            "data": {
                "daily": { "desc": "日常开发", "ratio": 1 },
                "pro": { "name": "专业组", "description": "高性能", "ratio": "2" }
            }
        });

        let groups = groups_from_value(&value, "https://api.example.com").unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].id, "daily");
        assert_eq!(groups[0].name, "daily");
        assert_eq!(groups[0].description, "日常开发");
        assert_eq!(groups[0].ratio, "1");
        assert_eq!(groups[0].base_url, "https://api.example.com");
        assert!(groups[0].api_key.is_empty());
        assert_eq!(groups[1].name, "专业组");
    }

    #[test]
    fn accepts_enriched_user_group_arrays() {
        let value = serde_json::json!({
            "data": [
                {
                    "id": "coding",
                    "name": "编程组",
                    "ratio": "1.5",
                    "baseUrl": "https://coding.example.com",
                    "apiProvider": "openai",
                    "isDefault": true
                }
            ]
        });

        let groups = groups_from_value(&value, "https://api.example.com").unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "coding");
        assert_eq!(groups[0].base_url, "https://coding.example.com");
        assert_eq!(groups[0].api_provider, "openai");
        assert!(groups[0].is_default);
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
}
