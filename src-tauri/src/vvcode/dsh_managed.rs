//! VV Code 托管供应商（managed provider）写入 DeepSeek Harness。
//!
//! 思路借鉴 Magpie（MIT）`internal/agent/dsh.go` 的 DeepSeek Harness 集成
//! （profiles 布局、home 层覆盖语义、version-1 凭据 refs、
//! `agent-default-model` 联动、输出预算），未复制其代码。文件写入沿用上游
//! `dsh_config` 的 `<file>.lock` 协议与原子写，锁顺序与上游一致：
//! credentials 锁 → 补丁文件锁。
//!
//! 安全模型：
//! - 所有权只能通过本模块的持久化记录（journal，存于应用数据目录，0600）
//!   认领，记录绑定 `DSH_HOME` 根、文件路径、接管时的原值与本模块最后
//!   写入的值。现场内容与记录不符视为手动修改，apply 拒绝覆盖、release
//!   不动并保留记录。
//! - home 层（`$DSH_HOME/cordis.patch.yml`）存在 `llm-pi-ai` /
//!   `agent-default-model` 条目（无论归属）时，apply 整次拒绝、零写入：
//!   home 会遮盖全部 profile，任何写入都不生效，也不自动镜像扩大影响。
//! - 同名 provider 键与凭据引用不能凭 ID 认领：初次应用遇到即冲突。
//! - 回滚只恢复仍是本事务产物的文件；写前在锁内重读并核对基线。
//! - 事务边界为「全部文件写完 → 数据库提交」；进程在途中崩溃时可能留下
//!   已写入的文件与未提交的数据库（本模块不做 WAL/前滚恢复，下次操作以
//!   journal 与现场值判定并报告漂移）。
//! - 状态与错误信息不包含任何密钥明文。

use crate::config::{atomic_write_private, get_app_config_dir};
use crate::dsh_config::{self, FileLock};
use crate::error::AppError;
use crate::provider::Provider;
use crate::store::AppState;
use crate::vvcode::brand::MANAGED_PROVIDER_ID;
use serde::Serialize;
use serde_json::{json, Value};
use serde_yaml::{Mapping, Value as Yaml};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 条目 id 行尾的所有权标记（代码兼容标识，不随展示品牌变化）。仅用于
/// 展示与漂移提示；认领与覆盖授权一律以 journal 为准。
const MANAGED_MARK: &str = "# vvcode-managed";
/// 自定义模型供应商所在的 dsh 插件行与插件名。
const PI_ROW: &str = "llm-pi-ai";
const PI_PLUGIN: &str = "@deepseek-ai/dsh-llm-pi-ai";
/// 新会话默认模型所在的条目 id。
const DEFAULT_MODEL_ROW: &str = "agent-default-model";
/// dsh 为新 profile 生成的补丁模板（Desktop 0.2.x PROFILE_PATCH_TEMPLATE）。
const PROFILE_TEMPLATE: &str = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n";
/// compaction-basic 的默认 headroomTokens：dsh 在请求 maxTokens 之外保留的
/// 上下文预算（见 Magpie dsh.go dshHeadroom）。
const COMPACT_HEADROOM_TOKENS: i64 = 65_536;
/// home 层补丁的 journal 键与相对路径。
const HOME_KEY: &str = "cordis.patch.yml";

fn managed_key_ref() -> String {
    format!(
        "CC_SWITCH_DSH_{}",
        MANAGED_PROVIDER_ID.replace('-', "_").to_ascii_uppercase()
    )
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 托管状态（前端消费，camelCase；不含任何密钥）。
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DshManagedStatus {
    pub(crate) managed: bool,
    pub(crate) profile_names: Vec<String>,
    pub(crate) conflicts: Vec<String>,
    pub(crate) warnings: Vec<String>,
    /// 官方 DeepSeek Harness Desktop 是否已安装（未装 CLI 也可托管：
    /// apply 会按 dsh 模板初始化 desktop profile）。
    pub(crate) desktop_available: bool,
}

// ---------------------------------------------------------------------------
// 所有权 journal
// ---------------------------------------------------------------------------

/// 一行（`llm-pi-ai` / `agent-default-model`）的接管记录。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
struct RowJournal {
    /// 接管时的用户条目原文（`None` = 当时该行不存在）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original: Option<String>,
    /// 本模块最后一次写入的条目文本。
    last: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct FileJournal {
    #[serde(
        default,
        rename = "llm-pi-ai",
        skip_serializing_if = "Option::is_none"
    )]
    pi_row: Option<RowJournal>,
    #[serde(
        default,
        rename = "agent-default-model",
        skip_serializing_if = "Option::is_none"
    )]
    default_model: Option<RowJournal>,
}

/// 凭据引用的接管记录：只保存值的哈希，不保存明文。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CredentialJournal {
    last_hash: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct Journal {
    #[serde(default)]
    version: u32,
    /// 记录绑定的 DeepSeek Harness 根目录（规范化绝对路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    /// 键为相对 root 的稳定路径（`profiles/web/cordis.patch.yml` 等）。
    #[serde(default)]
    rows: BTreeMap<String, FileJournal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential: Option<CredentialJournal>,
}

impl Journal {
    fn managed_rows(&self) -> impl Iterator<Item = (&String, &RowJournal)> {
        self.rows
            .iter()
            .flat_map(|(path, file)| file.pi_row.iter().map(move |row| (path, row)).chain(
                file.default_model
                    .iter()
                    .map(move |row| (path, row)),
            ))
    }
}

// ---------------------------------------------------------------------------
// 路径与安全预检
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct DshPaths {
    root: PathBuf,
}

impl DshPaths {
    fn live() -> Self {
        Self {
            root: dsh_config::data_dir(),
        }
    }
    fn home_patch(&self) -> PathBuf {
        self.root.join("cordis.patch.yml")
    }
    fn credentials(&self) -> PathBuf {
        self.root.join(".credentials.yaml")
    }
    fn legacy_config(&self) -> PathBuf {
        self.root.join("config.yaml")
    }
    fn desktop_profile(&self) -> PathBuf {
        self.root
            .join("profiles")
            .join("desktop")
            .join("cordis.patch.yml")
    }
    /// 相对 root 的稳定路径键（journal 与状态用）。
    fn relative_key(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }
    /// 记录绑定用的规范化根路径（root 不存在时规范化其最近的祖先）。
    fn canonical_root(&self) -> PathBuf {
        canonical_path(&self.root)
    }
    /// `profiles/*/cordis.patch.yml`，web 排最前，其余按名称排序。
    fn profile_files(&self) -> Vec<(String, PathBuf)> {
        let Ok(entries) = fs::read_dir(self.root.join("profiles")) else {
            return vec![];
        };
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.starts_with('.'))
            .filter(|name| {
                self.root
                    .join("profiles")
                    .join(name)
                    .join("cordis.patch.yml")
                    .is_file()
            })
            .collect();
        names.sort();
        names.sort_by_key(|name| name != "web");
        names
            .into_iter()
            .map(|name| {
                (
                    name.clone(),
                    self.root.join("profiles").join(name).join("cordis.patch.yml"),
                )
            })
            .collect()
    }
}

fn read_text(path: &Path) -> Result<String, AppError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(AppError::io(path, error)),
    }
}

/// 规范化路径：路径不存在时规范化其最近的存在祖先再拼回余下部分。
fn canonical_path(root: &Path) -> PathBuf {
    let mut current = root.to_path_buf();
    loop {
        if let Ok(resolved) = current.canonicalize() {
            return if current == root {
                resolved
            } else {
                resolved.join(root.strip_prefix(&current).unwrap_or(root))
            };
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => return root.to_path_buf(),
        }
    }
}

/// 拒绝符号链接：root 自身与涉及的每个路径的每级组件都不得是符号链接。
fn reject_symlinks(root: &Path, paths: &[PathBuf]) -> Result<(), AppError> {
    let is_symlink = |path: &Path| {
        fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
    };
    if is_symlink(root) {
        return Err(AppError::InvalidInput(format!(
            "DeepSeek Harness 根目录 {} 是符号链接，已拒绝写入",
            root.display()
        )));
    }
    for path in paths {
        if is_symlink(path) {
            return Err(AppError::InvalidInput(format!(
                "DeepSeek Harness 路径 {} 是符号链接，已拒绝写入",
                path.display()
            )));
        }
        if path.starts_with(root) {
            // root 内部的中间目录逐级检查，防止链接把写入导向 root 之外。
            let mut dir = path.parent();
            while let Some(current) = dir {
                if current == root {
                    break;
                }
                if is_symlink(current) {
                    return Err(AppError::InvalidInput(format!(
                        "DeepSeek Harness 路径包含符号链接（{}），已拒绝写入",
                        current.display()
                    )));
                }
                dir = current.parent();
            }
        }
        // root 之外的路径（如应用配置目录中的 journal）只检查自身：系统级
        // 布局的符号链接（macOS 的 /var → /private/var）不在此威胁模型内。
    }
    Ok(())
}

/// 托管端点必须是 HTTPS，或仅回环地址上的明文 HTTP（本地网关）。
fn validate_managed_base_url(base_url: &str) -> Result<(), AppError> {
    let parsed = url::Url::parse(base_url)
        .map_err(|_| AppError::InvalidInput("无效的 baseURL".into()))?;
    let loopback = || match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        _ => false,
    };
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if loopback() => Ok(()),
        "http" => Err(AppError::InvalidInput(
            "baseURL 必须使用 HTTPS（本地回环地址可用 HTTP）".into(),
        )),
        _ => Err(AppError::InvalidInput(
            "baseURL 必须是 HTTP(S) 地址".into(),
        )),
    }
}

fn desktop_app_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        return roots
            .iter()
            .any(|root| root.join("DeepSeek Harness.app").is_dir());
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("LOCALAPPDATA")
            .map(|local| {
                PathBuf::from(local)
                    .join("Programs")
                    .join("DeepSeek Harness")
                    .join("DeepSeek Harness.exe")
                    .is_file()
            })
            .unwrap_or(false);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

// ---------------------------------------------------------------------------
// 补丁列表的行级扫描与渲染
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct EntrySpan {
    id: String,
    ours: bool,
    start: usize,
    end: usize,
}

fn entry_id_and_mark(line: &str) -> Option<(String, bool)> {
    let rest = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("  "))?
        .trim_start();
    let rest = rest.strip_prefix("id:")?;
    let (value, comment) = match rest.find('#') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let id = value.trim().trim_matches(|c| c == '\'' || c == '"');
    if id.is_empty() || id.chars().any(char::is_whitespace) {
        return None;
    }
    Some((id.to_string(), comment.trim() == MANAGED_MARK))
}

fn is_doc_start(line: &str) -> bool {
    let rest = match line.strip_prefix("---") {
        Some(rest) => rest,
        None => return false,
    };
    let rest = rest.trim();
    rest.is_empty() || rest.starts_with('#')
}

fn scan_entries(text: &str) -> Result<(String, Vec<EntrySpan>), AppError> {
    let mut spans: Vec<EntrySpan> = vec![];
    let mut head_end: Option<usize> = None;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let starts_item = line.starts_with("- ") || trimmed == "-";
        if starts_item {
            if head_end.is_none() {
                head_end = Some(offset);
            } else if let Some(last) = spans.last_mut() {
                last.end = offset;
            }
            let mut span = EntrySpan {
                id: String::new(),
                ours: false,
                start: offset,
                end: text.len(),
            };
            if let Some((id, ours)) = entry_id_and_mark(line) {
                span.id = id;
                span.ours = ours;
            }
            spans.push(span);
        } else if spans.is_empty() {
            if !trimmed.is_empty()
                && !trimmed.starts_with('#')
                && trimmed != "[]"
                && !is_doc_start(line)
            {
                return Err(AppError::Config(
                    "DeepSeek Harness 配置不是可编辑的补丁列表".into(),
                ));
            }
        } else {
            if !trimmed.is_empty()
                && !trimmed.starts_with('#')
                && !line.starts_with(' ')
                && !line.starts_with('\t')
            {
                return Err(AppError::Config(
                    "DeepSeek Harness 配置不是可编辑的补丁列表".into(),
                ));
            }
            if spans.last().is_some_and(|span| span.id.is_empty()) {
                if let Some((id, ours)) = entry_id_and_mark(line) {
                    if let Some(last) = spans.last_mut() {
                        last.id = id;
                        last.ours = ours;
                    }
                }
            }
        }
        offset += line.len();
    }
    let head_end = head_end.unwrap_or(text.len());
    let head = text[..head_end]
        .split_inclusive('\n')
        .filter(|line| line.trim() != "[]")
        .collect::<String>();
    Ok((head, spans))
}

fn parse_entry(text: &str, span: &EntrySpan) -> Result<Mapping, AppError> {
    let raw = &text[span.start..span.end];
    let value: Yaml = serde_yaml::from_str(raw)
        .map_err(|_| AppError::Config(format!("DeepSeek Harness 条目 '{}' 无法解析", span.id)))?;
    match value {
        Yaml::Sequence(sequence) => match sequence.into_iter().next() {
            Some(Yaml::Mapping(mapping)) => Ok(mapping),
            _ => Err(AppError::Config(format!(
                "DeepSeek Harness 条目 '{}' 不是对象",
                span.id
            ))),
        },
        _ => Err(AppError::Config(format!(
            "DeepSeek Harness 条目 '{}' 不是对象",
            span.id
        ))),
    }
}

fn yaml_str(value: impl Into<String>) -> Yaml {
    Yaml::String(value.into())
}

fn mapping_get<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Yaml> {
    mapping.get(Yaml::from(key))
}

fn mapping_insert(mapping: &mut Mapping, key: &str, value: Yaml) {
    mapping.insert(Yaml::from(key), value);
}

fn json_to_yaml(value: &Value) -> Yaml {
    serde_yaml::to_value(value).unwrap_or(Yaml::Null)
}

fn render_entry(mapping: &Mapping, mark: bool) -> Result<String, AppError> {
    let text = serde_yaml::to_string(&Yaml::Sequence(vec![Yaml::Mapping(mapping.clone())]))
        .map_err(|error| AppError::Config(error.to_string()))?;
    if !mark {
        return Ok(text);
    }
    let (first, rest) = match text.find('\n') {
        Some(index) => (&text[..index], &text[index + 1..]),
        None => (text.as_str(), ""),
    };
    let mut out = String::with_capacity(text.len() + MANAGED_MARK.len() + 1);
    out.push_str(first.trim_end_matches('\n'));
    out.push(' ');
    out.push_str(MANAGED_MARK);
    out.push('\n');
    out.push_str(rest);
    Ok(out)
}

fn entry_uses_yaml_tags(text: &str, span: &EntrySpan) -> bool {
    text[span.start..span.end]
        .lines()
        .any(crate::omp_config::has_yaml_reference_tokens)
}

fn find_unique<'a>(spans: &'a [EntrySpan], id: &str) -> Result<Option<&'a EntrySpan>, AppError> {
    let matches: Vec<&EntrySpan> = spans.iter().filter(|span| span.id == id).collect();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0])),
        _ => Err(AppError::Config(format!(
            "补丁列表中存在多个 '{id}' 条目"
        ))),
    }
}

// ---------------------------------------------------------------------------
// 编辑器格式 → dsh 原生 provider 配置
// ---------------------------------------------------------------------------

fn budgeted_output(context: Option<i64>, output: i64) -> i64 {
    let Some(context) = context.filter(|value| *value > 0) else {
        return output;
    };
    if output <= 0 {
        return output;
    }
    let room = (context / 4)
        .max(context / 2 - COMPACT_HEADROOM_TOKENS)
        .max(1);
    output.min(room)
}

fn native_model(id: &str, model: &Value) -> Yaml {
    let mut native = Mapping::new();
    mapping_insert(&mut native, "id", yaml_str(id));
    let name = model
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(id);
    mapping_insert(&mut native, "name", yaml_str(name));
    let context = model
        .pointer("/limit/context")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0);
    let output = model
        .pointer("/limit/output")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0);
    if let Some(context) = context {
        mapping_insert(&mut native, "contextWindow", Yaml::Number(context.into()));
    }
    if let Some(output) = output {
        mapping_insert(
            &mut native,
            "maxTokens",
            Yaml::Number(budgeted_output(context, output).into()),
        );
    }
    if let Some(input) = model
        .pointer("/modalities/input")
        .filter(|value| value.is_array())
    {
        mapping_insert(&mut native, "input", json_to_yaml(input));
    }
    if model.get("reasoningEfforts").is_some_and(|value| !value.is_null()) {
        mapping_insert(
            &mut native,
            "reasoningEfforts",
            json_to_yaml(model.get("reasoningEfforts").unwrap()),
        );
    } else if model.get("reasoning") == Some(&Value::Bool(false)) {
        mapping_insert(&mut native, "reasoningEfforts", Yaml::Bool(false));
    } else if model.get("reasoning") == Some(&Value::Bool(true)) {
        mapping_insert(
            &mut native,
            "reasoningEfforts",
            json_to_yaml(&json!({"off": null, "low": "low", "medium": "medium", "high": "high"})),
        );
    }
    for (key, value) in model.as_object().into_iter().flatten() {
        if matches!(
            key.as_str(),
            "name" | "limit" | "modalities" | "reasoning" | "reasoningEfforts" | "id"
        ) {
            continue;
        }
        mapping_insert(&mut native, key, json_to_yaml(value));
    }
    Yaml::Mapping(native)
}

/// 编辑器格式（上游 Dsh 供应商格式）→ `llm-pi-ai` providers 下的原生键。
/// `defaultModel` 必须已剥离，不会进入原生配置。
fn managed_native_provider(
    display_name: &str,
    settings: &Value,
    key_ref: &str,
) -> Result<Yaml, AppError> {
    let mut provider = Mapping::new();
    mapping_insert(&mut provider, "displayName", yaml_str(display_name));
    mapping_insert(
        &mut provider,
        "api",
        json_to_yaml(settings.get("api").unwrap_or(&Value::Null)),
    );
    mapping_insert(
        &mut provider,
        "baseURL",
        json_to_yaml(settings.pointer("/options/baseURL").unwrap_or(&Value::Null)),
    );
    mapping_insert(&mut provider, "apiKeyEnv", yaml_str(key_ref));
    if let Some(headers) = settings
        .pointer("/options/headers")
        .filter(|value| value.is_object())
    {
        mapping_insert(&mut provider, "headers", json_to_yaml(headers));
    }
    let models = settings
        .get("models")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::InvalidInput("至少需要一个 DeepSeek Harness 模型".into()))?;
    let native_models: Vec<Yaml> = models
        .iter()
        .map(|(id, model)| native_model(id, model))
        .collect();
    mapping_insert(&mut provider, "models", Yaml::Sequence(native_models));
    Ok(Yaml::Mapping(provider))
}

/// 提取默认模型：显式 `defaultModel` 优先（必须存在于模型表），否则首个模型。
fn extract_default_model(settings: &Value) -> Result<String, AppError> {
    let models = settings
        .get("models")
        .and_then(Value::as_object)
        .filter(|models| !models.is_empty())
        .ok_or_else(|| AppError::InvalidInput("至少需要一个 DeepSeek Harness 模型".into()))?;
    if let Some(default) = settings.get("defaultModel").filter(|value| !value.is_null()) {
        let default = default
            .as_str()
            .ok_or_else(|| AppError::InvalidInput("defaultModel 必须是模型 id 字符串".into()))?;
        if !models.contains_key(default) {
            return Err(AppError::InvalidInput(format!(
                "defaultModel '{default}' 不在模型列表中"
            )));
        }
        return Ok(default.to_string());
    }
    Ok(models.keys().next().cloned().expect("models 已验证非空"))
}

// ---------------------------------------------------------------------------
// 事务写入
// ---------------------------------------------------------------------------

enum PlanKind {
    Credentials,
    Patch,
    Journal,
}

struct WritePlan {
    kind: PlanKind,
    path: PathBuf,
    next: Option<Vec<u8>>,
    /// 规划时的现场字节（None = 当时不存在）；写入前在锁内重读核对。
    base: Option<Vec<u8>>,
}

/// 按上游锁顺序执行（credentials → 补丁文件 → journal），写前重读，
/// 失败或提交失败时回滚——仅恢复仍是本事务产物的文件。
fn commit_plans(
    mut plans: Vec<WritePlan>,
    commit: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    plans.sort_by_key(|plan| match plan.kind {
        PlanKind::Credentials => 0,
        PlanKind::Patch => 1,
        PlanKind::Journal => 2,
    });
    let mut written: Vec<(PathBuf, Option<Vec<u8>>, Option<Vec<u8>>)> = vec![];
    for plan in &plans {
        let attempt = (|| -> Result<(), AppError> {
            // 先建私有目录再取锁：FileLock::acquire 也会建父目录（默认权限），
            // 顺序反了会把新建 profile 目录留在 0755。
            if plan.next.is_some() {
                if let Some(parent) = plan.path.parent() {
                    ensure_private_parent(parent)?;
                }
            }
            let _guard = FileLock::acquire(&plan.path)?;
            let current = match fs::read(&plan.path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(AppError::io(&plan.path, error)),
            };
            if current != plan.base {
                return Err(AppError::Conflict(format!(
                    "{} 在规划后被其他程序修改，请重试",
                    plan.path.display()
                )));
            }
            match &plan.next {
                Some(bytes) => {
                    atomic_write_private(&plan.path, bytes)?;
                }
                None => {
                    if current.is_some() {
                        fs::remove_file(&plan.path)
                            .map_err(|error| AppError::io(&plan.path, error))?;
                    }
                }
            }
            written.push((plan.path.clone(), current, plan.next.clone()));
            Ok(())
        })();
        if let Err(error) = attempt {
            rollback(&written);
            return Err(error);
        }
    }
    if let Err(error) = commit() {
        rollback(&written);
        return Err(error);
    }
    Ok(())
}

fn rollback(written: &[(PathBuf, Option<Vec<u8>>, Option<Vec<u8>>)]) {
    for (path, previous, wrote) in written.iter().rev() {
        let result = (|| -> Result<(), AppError> {
            // 必须真正持锁才能写；拿不到锁就放弃该文件的恢复并留痕。
            let _guard = FileLock::acquire(path)?;
            let current = fs::read(path).ok();
            if current.as_deref() != wrote.as_deref() {
                // 已被其他来源改写：保留现状，不丢失外部编辑。
                return Ok(());
            }
            match previous {
                Some(bytes) => atomic_write_private(path, bytes),
                None => fs::remove_file(path)
                    .or_else(|error| {
                        if error.kind() == std::io::ErrorKind::NotFound {
                            Ok(())
                        } else {
                            Err(error)
                        }
                    })
                    .map_err(|error| AppError::io(path, error)),
            }
        })();
        if let Err(error) = result {
            log::warn!(
                "回滚 DeepSeek Harness 托管写入 {} 失败: {error}",
                path.display()
            );
        }
    }
}

fn ensure_private_parent(parent: &Path) -> Result<(), AppError> {
    if parent.exists() {
        return Ok(());
    }
    fs::create_dir_all(parent).map_err(|error| AppError::io(parent, error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// journal 读写
// ---------------------------------------------------------------------------

fn journal_path() -> PathBuf {
    get_app_config_dir().join("dsh-managed-journal.json")
}

/// 读取所有权 journal。fail-closed：只有文件不存在视为初次（空记录）；
/// 权限/IO 错误、损坏 JSON、未知版本一律明确拒绝，避免丢所有权后误认领。
fn load_journal(path: &Path) -> Result<Journal, AppError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Journal::default())
        }
        Err(error) => return Err(AppError::io(path, error)),
    };
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| {
        AppError::Config(format!(
            "托管记录 {} 无法解析；请手动检查后重试",
            path.display()
        ))
    })?;
    let has_content = !journal.rows.is_empty() || journal.credential.is_some();
    if has_content && journal.version != 1 {
        return Err(AppError::Config(format!(
            "托管记录版本 {} 不受支持；请升级应用或手动清理 {}",
            journal.version,
            path.display()
        )));
    }
    Ok(journal)
}

fn render_journal(journal: &Journal) -> Result<Vec<u8>, AppError> {
    serde_json::to_vec_pretty(journal)
        .map_err(|error| AppError::Config(format!("序列化托管记录失败: {error}")))
}

/// 校验 journal 的 root 绑定；有内容时必须是 version 1 且绑定当前根目录。
/// 绑定其他根目录时明确拒绝（不静默丢弃记录）。
fn journal_for_root(journal: Journal, root: &Path) -> Result<Journal, AppError> {
    if journal.rows.is_empty() && journal.credential.is_none() {
        return Ok(Journal::default());
    }
    if journal.version != 1 {
        return Err(AppError::Config(format!(
            "托管记录版本 {} 不受支持；请升级应用或手动清理",
            journal.version
        )));
    }
    let canonical = canonical_path(root).to_string_lossy().to_string();
    match journal.root.as_deref() {
        Some(recorded) if recorded == canonical => Ok(journal),
        Some(recorded) => Err(AppError::Conflict(format!(
            "托管记录绑定于其他 DeepSeek Harness 目录（{recorded}）；请先在那边解除托管，或手动清理 {}",
            journal_path().display()
        ))),
        None => Err(AppError::Conflict(
            "托管记录缺少根目录绑定，无法确认所有权；请手动清理后重新应用".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// 单文件规划
// ---------------------------------------------------------------------------

enum ProfileChange {
    Unchanged,
    Rewritten { next: String, base: Option<Vec<u8>> },
    Blocked(String),
}

/// 渲染期望的 `llm-pi-ai` 条目：保留现场条目中用户的 provider 键、name 与
/// config 其余字段，写入/更新托管路由。
fn render_pi_entry(text: &str, span: Option<&EntrySpan>, native: &Yaml) -> Result<String, AppError> {
    let mut mapping = match span {
        Some(span) => parse_entry(text, span)?,
        None => Mapping::new(),
    };
    if mapping_get(&mapping, "id").is_none() {
        mapping_insert(&mut mapping, "id", yaml_str(PI_ROW));
    }
    if mapping_get(&mapping, "name").is_none() {
        mapping_insert(&mut mapping, "name", yaml_str(PI_PLUGIN));
    }
    let mut config = match mapping_get(&mapping, "config") {
        Some(Yaml::Mapping(config)) => config.clone(),
        _ => Mapping::new(),
    };
    let mut providers = match config.get(Yaml::from("providers")) {
        Some(Yaml::Mapping(providers)) => providers.clone(),
        _ => Mapping::new(),
    };
    providers.insert(Yaml::from(MANAGED_PROVIDER_ID), native.clone());
    config.insert(Yaml::from("providers"), Yaml::Mapping(providers));
    mapping_insert(&mut mapping, "config", Yaml::Mapping(config));
    render_entry(&mapping, true)
}

fn render_default_entry(default_model: &str) -> Result<String, AppError> {
    let mut config = Mapping::new();
    mapping_insert(&mut config, "provider", yaml_str(MANAGED_PROVIDER_ID));
    mapping_insert(&mut config, "model", yaml_str(default_model));
    let mut mapping = Mapping::new();
    mapping_insert(&mut mapping, "id", yaml_str(DEFAULT_MODEL_ROW));
    mapping_insert(&mut mapping, "config", Yaml::Mapping(config));
    render_entry(&mapping, true)
}

/// 单文件（一个 profile 的补丁）的应用规划。所有权授权完全以 journal 为准：
/// - 有槽且现场 == last → 允许更新，last 前移；
/// - 有槽但现场 != last（含被删除）→ 手动修改，阻止；
/// - 无槽且现场无条目/无同名键 → 接管并记录 original/last；
/// - 无槽但现场有条目（含我们的标记或同名 provider 键）→ 不能凭 ID 认领，阻止。
fn plan_profile_apply(
    text: &str,
    native: &Yaml,
    default_model: &str,
    file_journal: &mut FileJournal,
) -> Result<ProfileChange, AppError> {
    let (head, spans) = scan_entries(text)?;
    let pi_span = find_unique(&spans, PI_ROW)?;
    let default_span = find_unique(&spans, DEFAULT_MODEL_ROW)?;

    let span_text = |span: Option<&EntrySpan>| span.map(|span| &text[span.start..span.end]);

    // llm-pi-ai 行
    let pi_next: Result<Option<String>, String> = match &file_journal.pi_row {
        Some(journal) => {
            let current = span_text(pi_span);
            if current != Some(journal.last.as_str()) {
                Err("llm-pi-ai 条目已被手动修改或移除；如需继续托管，请先在 DeepSeek Harness 中恢复，或解除托管后重新应用".into())
            } else {
                Ok(Some(render_pi_entry(text, pi_span, native)?))
            }
        }
        None => match pi_span {
            Some(span) => {
                if span.ours {
                    Err("llm-pi-ai 条目带托管标记但无所有权记录（记录可能已丢失）；请先解除托管或手动清理后重试".into())
                } else if providers_contain_managed_key(text, span)? {
                    Err(format!("llm-pi-ai 条目中已存在同名 provider 键 '{MANAGED_PROVIDER_ID}'，不能凭 ID 认领；请先在 DeepSeek Harness 中处理"))
                } else if entry_uses_yaml_tags(text, span) {
                    Err("llm-pi-ai 条目使用了 YAML 标签或锚点，无法安全重写；请先在 DeepSeek Harness 中处理".into())
                } else {
                    file_journal.pi_row = Some(RowJournal {
                        original: span_text(pi_span).map(str::to_string),
                        last: String::new(),
                    });
                    Ok(Some(render_pi_entry(text, pi_span, native)?))
                }
            }
            None => {
                file_journal.pi_row = Some(RowJournal {
                    original: None,
                    last: String::new(),
                });
                Ok(Some(render_pi_entry(text, None, native)?))
            }
        },
    };

    // agent-default-model 行
    let default_next: Result<Option<String>, String> = match &file_journal.default_model {
        Some(journal) => {
            let current = span_text(default_span);
            if current != Some(journal.last.as_str()) {
                Err("agent-default-model 条目已被手动修改或移除；如需继续托管，请先在 DeepSeek Harness 中恢复，或解除托管后重新应用".into())
            } else {
                Ok(Some(render_default_entry(default_model)?))
            }
        }
        None => match default_span {
            Some(span) => {
                if span.ours {
                    Err("agent-default-model 条目带托管标记但无所有权记录（记录可能已丢失）；请先解除托管或手动清理后重试".into())
                } else if entry_uses_yaml_tags(text, span) {
                    Err("agent-default-model 条目使用了 YAML 标签或锚点，无法安全重写；请先在 DeepSeek Harness 中处理".into())
                } else {
                    file_journal.default_model = Some(RowJournal {
                        original: span_text(default_span).map(str::to_string),
                        last: String::new(),
                    });
                    Ok(Some(render_default_entry(default_model)?))
                }
            }
            None => {
                file_journal.default_model = Some(RowJournal {
                    original: None,
                    last: String::new(),
                });
                Ok(Some(render_default_entry(default_model)?))
            }
        },
    };

    let pi_next = match pi_next {
        Ok(next) => next,
        Err(message) => return Ok(ProfileChange::Blocked(message)),
    };
    let default_next = match default_next {
        Ok(next) => next,
        Err(message) => return Ok(ProfileChange::Blocked(message)),
    };
    if pi_next.is_none() && default_next.is_none() {
        return Ok(ProfileChange::Unchanged);
    }

    let pi_replacement = pi_span.map(|span| {
        (
            span.start,
            span.end,
            pi_next.clone().unwrap_or_default(),
        )
    });
    let default_replacement = default_span.map(|span| {
        (
            span.start,
            span.end,
            default_next.clone().unwrap_or_default(),
        )
    });
    let appends: Vec<String> = [
        (pi_span.is_none(), pi_next.clone()),
        (default_span.is_none(), default_next.clone()),
    ]
    .into_iter()
    .filter_map(|(missing, next)| if missing { next } else { None })
    .collect();

    let next = rebuild(text, &head, &spans, pi_replacement, default_replacement, appends)?;
    if next == text {
        // journal 槽位可能已初始化（original 记录），即使文本未变也要落盘。
        return Ok(ProfileChange::Rewritten {
            next,
            base: Some(text.as_bytes().to_vec()),
        });
    }
    dsh_config::entries(&next)?;
    if let Some(journal) = &mut file_journal.pi_row {
        if journal.last.is_empty() {
            journal.last = pi_next.unwrap_or_default();
        } else {
            journal.last = pi_next.unwrap_or(journal.last.clone());
        }
    }
    if let Some(journal) = &mut file_journal.default_model {
        if journal.last.is_empty() {
            journal.last = default_next.unwrap_or_default();
        } else {
            journal.last = default_next.unwrap_or(journal.last.clone());
        }
    }
    Ok(ProfileChange::Rewritten {
        next,
        base: Some(text.as_bytes().to_vec()),
    })
}

fn providers_contain_managed_key(text: &str, span: &EntrySpan) -> Result<bool, AppError> {
    Ok(parse_entry(text, span)?
        .get(Yaml::from("config"))
        .and_then(|config| config.as_mapping())
        .and_then(|config| config.get(Yaml::from("providers")))
        .and_then(|providers| providers.as_mapping().cloned())
        .is_some_and(|providers| providers.contains_key(Yaml::from(MANAGED_PROVIDER_ID))))
}

fn entry_is_bare_skeleton(mapping: &Mapping) -> bool {
    let config_empty = match mapping_get(mapping, "config") {
        Some(Yaml::Mapping(config)) => config.iter().all(|(key, value)| {
            key.as_str() == Some("providers") && matches!(value, Yaml::Mapping(m) if m.is_empty())
        }),
        _ => true,
    };
    config_empty
        && mapping
            .iter()
            .all(|(key, _)| matches!(key.as_str(), Some("id") | Some("name") | Some("config")))
}

fn ensure_trailing_newline(text: &str) -> String {
    if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

/// 用替换区间与追加条目重建补丁文本；未涉及的条目按原字节保留。
/// 替换内容为空串表示删除该条目。
fn rebuild(
    text: &str,
    head: &str,
    spans: &[EntrySpan],
    pi_replacement: Option<(usize, usize, String)>,
    default_replacement: Option<(usize, usize, String)>,
    appends: Vec<String>,
) -> Result<String, AppError> {
    let replacements = [pi_replacement, default_replacement];
    let removed_all = !spans.is_empty()
        && spans.iter().all(|span| {
            replacements.iter().flatten().any(|(start, _, next)| {
                *start == span.start && next.is_empty()
            })
        })
        && appends.is_empty();
    let mut out = String::new();
    out.push_str(head);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    let mut cursor = spans.first().map(|span| span.start).unwrap_or(text.len());
    for span in spans {
        out.push_str(&text[cursor..span.start]);
        let replacement = replacements
            .iter()
            .flatten()
            .find(|(start, _, _)| *start == span.start);
        match replacement {
            Some((_, _, next)) => out.push_str(next),
            None => out.push_str(&text[span.start..span.end]),
        }
        cursor = span.end;
    }
    out.push_str(&text[cursor.min(text.len())..]);
    for append in appends {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&append);
    }
    if removed_all {
        out.push_str("[]\n");
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 核心：应用 / 解除 / 状态
// ---------------------------------------------------------------------------

fn target_profiles(
    paths: &DshPaths,
    desktop_installed: bool,
) -> Result<Vec<(String, PathBuf)>, AppError> {
    let mut targets = paths.profile_files();
    if !targets.iter().any(|(name, _)| name == "desktop")
        && desktop_installed
        && !paths.desktop_profile().exists()
    {
        targets.push(("desktop".to_string(), paths.desktop_profile()));
    }
    if targets.is_empty() {
        if paths.legacy_config().exists() {
            return Err(AppError::InvalidInput(
                "检测到旧版 DeepSeek Harness 布局（config.yaml）。托管仅支持 0.1.5 及以上的 profiles 布局，请先升级并运行一次 dsh".into(),
            ));
        }
        return Err(AppError::InvalidInput(
            "未找到 DeepSeek Harness 配置。请先运行一次 dsh（生成 profiles），或安装 DeepSeek Harness Desktop 后重试".into(),
        ));
    }
    Ok(targets)
}

#[allow(clippy::too_many_arguments)]
fn apply_core(
    paths: &DshPaths,
    display_name: &str,
    settings: &Value,
    default_model: &str,
    desktop_installed: bool,
    journal_file: &Path,
    commit: impl FnOnce() -> Result<(), AppError>,
) -> Result<DshManagedStatus, AppError> {
    dsh_config::validate_provider(MANAGED_PROVIDER_ID, settings)?;
    let base_url = settings
        .pointer("/options/baseURL")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_managed_base_url(base_url)?;
    let api_key = settings
        .pointer("/options/apiKey")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            AppError::InvalidInput("托管供应商需要通过 options.apiKey 提供站点密钥".into())
        })?;
    let key_ref = managed_key_ref();
    let native = managed_native_provider(display_name, settings, &key_ref)?;
    let targets = target_profiles(paths, desktop_installed)?;

    // home 层预检：任何 llm-pi-ai / agent-default-model 条目都会遮盖全部
    // profile，整次拒绝、零写入（不自动镜像）。解析失败/重复条目同样拒绝。
    if paths.home_patch().exists() {
        let text = read_text(&paths.home_patch())?;
        if !text.trim().is_empty() {
            let (.., spans) = scan_entries(&text)?;
            let occupied: Vec<&str> = [
                find_unique(&spans, PI_ROW)?,
                find_unique(&spans, DEFAULT_MODEL_ROW)?,
            ]
            .into_iter()
            .flatten()
            .map(|span| span.id.as_str())
            .collect();
            if !occupied.is_empty() {
                return Err(AppError::Conflict(format!(
                    "home 层（~/.dsh/cordis.patch.yml）已存在 {} 条目，会遮盖全部 profile 的托管写入；请先在 DeepSeek Harness 中处理后重试",
                    occupied.join(" / ")
                )));
            }
        }
    }

    let mut symlink_paths: Vec<PathBuf> = targets.iter().map(|(_, path)| path.clone()).collect();
    symlink_paths.push(paths.credentials());
    if paths.home_patch().exists() {
        symlink_paths.push(paths.home_patch());
    }
    symlink_paths.push(journal_file.to_path_buf());
    reject_symlinks(&paths.root, &symlink_paths)?;

    let mut journal = journal_for_root(load_journal(journal_file)?, &paths.root)?;
    if journal.root.is_none() {
        journal.version = 1;
        journal.root = Some(paths.canonical_root().to_string_lossy().to_string());
    }
    let mut plans: Vec<WritePlan> = vec![];
    let mut conflicts: Vec<String> = vec![];

    for (name, path) in &targets {
        let text = if path.exists() {
            read_text(path)?
        } else {
            PROFILE_TEMPLATE.to_string()
        };
        let key = paths.relative_key(path);
        let slot = journal.rows.entry(key).or_default();
        match plan_profile_apply(&text, &native, default_model, slot)? {
            ProfileChange::Rewritten { next, base } => plans.push(WritePlan {
                kind: PlanKind::Patch,
                path: path.clone(),
                next: Some(next.into_bytes()),
                // base 以磁盘现状为准：规划文本可能是内存模板（文件尚不存在），
                // commit 在锁内重读对比的就是磁盘字节。
                base: if path.exists() { base } else { None },
            }),
            ProfileChange::Unchanged => {}
            ProfileChange::Blocked(message) => {
                conflicts.push(format!("profile '{name}'：{message}"));
            }
        }
    }

    // 凭据：version-1 文档校验失败在此明确拒绝（不自动迁移）。同名引用与
    // 手改值都不能凭 ID 认领/覆盖，冲突时整次拒绝、零写入。
    let credentials = paths.credentials();
    let document = dsh_config::credential_document(&credentials)?;
    let stored = document
        .get(Yaml::from("refs"))
        .and_then(|refs| refs.get(Yaml::from(key_ref.as_str())))
        .and_then(Yaml::as_str)
        .map(str::to_string);
    let key_hash = sha256_hex(api_key);
    match &journal.credential {
        Some(record) => {
            let current_matches = stored
                .as_deref()
                .is_some_and(|value| sha256_hex(value) == record.last_hash);
            if !current_matches {
                return Err(AppError::Conflict(format!(
                    "DeepSeek Harness 凭据中的 {key_ref} 已被手动修改或移除；如需继续托管请先在 DeepSeek Harness 中恢复或清理"
                )));
            }
            if key_hash != record.last_hash {
                let yaml = upsert_credential_ref(document, &key_ref, api_key)?;
                plans.push(WritePlan {
                    kind: PlanKind::Credentials,
                    path: credentials.clone(),
                    next: Some(yaml.into_bytes()),
                    base: read_bytes_or_none(&credentials)?,
                });
                journal.credential = Some(CredentialJournal {
                    last_hash: key_hash,
                });
            }
        }
        None => {
            if stored.is_some() {
                return Err(AppError::Conflict(format!(
                    "DeepSeek Harness 凭据中已存在同名引用 {key_ref}，不能凭 ID 认领；请先在 DeepSeek Harness 中处理"
                )));
            }
            let yaml = upsert_credential_ref(document, &key_ref, api_key)?;
            plans.push(WritePlan {
                kind: PlanKind::Credentials,
                path: credentials.clone(),
                next: Some(yaml.into_bytes()),
                base: read_bytes_or_none(&credentials)?,
            });
            journal.credential = Some(CredentialJournal {
                last_hash: key_hash,
            });
        }
    }

    let journal_after = render_journal(&journal)?;
    let journal_base = match fs::read(journal_file) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(AppError::io(journal_file, error)),
    };
    if journal_after != journal_base.clone().unwrap_or_default() {
        plans.push(WritePlan {
            kind: PlanKind::Journal,
            path: journal_file.to_path_buf(),
            next: Some(journal_after),
            base: journal_base,
        });
    }

    commit_plans(plans, commit)?;
    // 规划阶段的 Blocked（同名键/手改/标签等）不会体现在提交后的现场比对里，
    // 必须并入返回状态，否则调用方看不到本轮哪些 profile 没有写成。
    let mut status = status_core(paths, Some(settings), &journal, desktop_installed);
    let site_conflicts = std::mem::take(&mut status.conflicts);
    status.conflicts = conflicts.into_iter().chain(site_conflicts).collect();
    Ok(status)
}

fn upsert_credential_ref(
    document: Yaml,
    key_ref: &str,
    api_key: &str,
) -> Result<String, AppError> {
    let mut document = document;
    let mut document_mapping = document
        .as_mapping_mut()
        .ok_or_else(|| AppError::Config("DeepSeek Harness 凭据文档格式错误".into()))?
        .clone();
    let refs = document_mapping
        .get_mut(Yaml::from("refs"))
        .and_then(Yaml::as_mapping_mut)
        .ok_or_else(|| AppError::Config("DeepSeek Harness 凭据文档缺少 refs 映射".into()))?;
    refs.insert(Yaml::from(key_ref), Yaml::String(api_key.to_string()));
    document = Yaml::Mapping(document_mapping);
    serde_yaml::to_string(&document).map_err(|error| AppError::Config(error.to_string()))
}

/// 解除托管：仅恢复现场仍等于 journal 记录值（未被手改）的行；手改行不动、
/// 记录保留并最终报错。无记录的托管标记条目按骨架清理（移除托管键/条目），
/// 用户自有的 provider 键与条目一律保留。凭据引用从不删除。
fn release_core(
    paths: &DshPaths,
    journal_file: &Path,
    commit: impl FnOnce() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut journal = journal_for_root(load_journal(journal_file)?, &paths.root)?;
    let mut plans: Vec<WritePlan> = vec![];
    let mut conflicts: Vec<String> = vec![];

    let mut layers: Vec<(String, PathBuf)> = paths.profile_files();
    if paths.home_patch().exists() {
        layers.push((HOME_KEY.to_string(), paths.home_patch()));
    }
    for (name, path) in layers {
        let Ok(text) = read_text(&path) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let key = paths.relative_key(&path);
        let slot = journal.rows.get_mut(&key);
        match plan_profile_release(&text, slot, &mut conflicts, &name)? {
            ProfileChange::Rewritten { next, base } => plans.push(WritePlan {
                kind: PlanKind::Patch,
                path,
                next: Some(next.into_bytes()),
                base,
            }),
            ProfileChange::Unchanged => {}
            ProfileChange::Blocked(_) => unreachable!("release 不产生 Blocked"),
        }
    }

    let journal_after = render_journal(&journal)?;
    let journal_before_bytes = read_bytes_or_none(journal_file)?;
    if journal_after != journal_before_bytes.clone().unwrap_or_default() {
        plans.push(WritePlan {
            kind: PlanKind::Journal,
            path: journal_file.to_path_buf(),
            next: Some(journal_after),
            base: journal_before_bytes,
        });
    }

    commit_plans(plans, commit)?;
    if !conflicts.is_empty() {
        return Err(AppError::Message(format!(
            "部分条目已被手动修改，未恢复（所有权记录已保留）：{}",
            conflicts.join("；")
        )));
    }
    Ok(())
}

fn plan_profile_release(
    text: &str,
    mut slot: Option<&mut FileJournal>,
    conflicts: &mut Vec<String>,
    name: &str,
) -> Result<ProfileChange, AppError> {
    let (head, spans) = scan_entries(text)?;
    let pi_span = find_unique(&spans, PI_ROW)?;
    let default_span = find_unique(&spans, DEFAULT_MODEL_ROW)?;
    let span_text = |span: Option<&EntrySpan>| span.map(|span| &text[span.start..span.end]);

    let mut pi_replacement: Option<(usize, usize, String)> = None;
    let mut default_replacement: Option<(usize, usize, String)> = None;

    let pi_record = slot.as_ref().and_then(|slot| slot.pi_row.as_ref());
    match (pi_span, pi_record) {
        (Some(span), Some(record)) => {
            if span_text(Some(span)) == Some(record.last.as_str()) {
                pi_replacement = Some(release_replacement(
                    text,
                    span,
                    record.original.as_deref(),
                ));
                if let Some(slot) = slot.as_mut() {
                    slot.pi_row = None;
                }
            } else {
                conflicts.push(format!(
                    "profile '{name}' 的 llm-pi-ai 条目已被手动修改"
                ));
            }
        }
        (Some(span), None) => {
            if span.ours {
                // 无记录的托管痕迹：按骨架清理，保留用户内容。
                let mapping = parse_entry(text, span)?;
                match strip_managed_route(&mapping)? {
                    None => pi_replacement = Some((span.start, span.end, String::new())),
                    Some(mapping) => {
                        pi_replacement =
                            Some((span.start, span.end, render_entry(&mapping, false)?))
                    }
                }
            }
        }
        _ => {}
    }

    let default_record = slot.as_ref().and_then(|slot| slot.default_model.as_ref());
    match (default_span, default_record) {
        (Some(span), Some(record)) => {
            if span_text(Some(span)) == Some(record.last.as_str()) {
                default_replacement = Some(release_replacement(
                    text,
                    span,
                    record.original.as_deref(),
                ));
                if let Some(slot) = slot.as_mut() {
                    slot.default_model = None;
                }
            } else {
                let mapping = parse_entry(text, span)?;
                let provider = default_model_provider(&mapping);
                if provider == MANAGED_PROVIDER_ID {
                    conflicts.push(format!(
                        "profile '{name}' 的 agent-default-model 条目已被手动修改"
                    ));
                } else {
                    // 用户在 dsh 里改选的默认模型：内容保留，仅摘除标记。
                    default_replacement =
                        Some((span.start, span.end, render_entry(&mapping, false)?));
                }
            }
        }
        (Some(span), None) => {
            if span.ours {
                let mapping = parse_entry(text, span)?;
                if default_model_provider(&mapping) == MANAGED_PROVIDER_ID {
                    default_replacement = Some((span.start, span.end, String::new()));
                } else {
                    default_replacement =
                        Some((span.start, span.end, render_entry(&mapping, false)?));
                }
            }
        }
        _ => {}
    }

    if pi_replacement.is_none() && default_replacement.is_none() {
        return Ok(ProfileChange::Unchanged);
    }
    let next = rebuild(text, &head, &spans, pi_replacement, default_replacement, vec![])?;
    if next == text {
        return Ok(ProfileChange::Unchanged);
    }
    dsh_config::entries(&next)?;
    Ok(ProfileChange::Rewritten {
        next,
        base: Some(text.as_bytes().to_vec()),
    })
}

/// agent-default-model 条目当前指向的 provider（读不到视为空）。
fn default_model_provider(mapping: &Mapping) -> &str {
    mapping
        .get(Yaml::from("config"))
        .and_then(|config| config.as_mapping())
        .and_then(|config| config.get(Yaml::from("provider")))
        .and_then(Yaml::as_str)
        .unwrap_or_default()
}

fn release_replacement(
    _text: &str,
    span: &EntrySpan,
    original: Option<&str>,
) -> (usize, usize, String) {
    match original {
        Some(saved) => (span.start, span.end, ensure_trailing_newline(saved)),
        None => (span.start, span.end, String::new()),
    }
}

/// 移除托管路由键；providers 仍有用户键时返回去键后的条目（去标记交由
/// 调用方渲染），否则返回 `None` 表示骨架可整体删除。
fn strip_managed_route(mapping: &Mapping) -> Result<Option<Mapping>, AppError> {
    let mut mapping = mapping.clone();
    let mut config = match mapping_get(&mapping, "config") {
        Some(Yaml::Mapping(config)) => config.clone(),
        _ => return Ok(Some(mapping)),
    };
    let mut providers = match config.get(Yaml::from("providers")) {
        Some(Yaml::Mapping(providers)) => providers.clone(),
        _ => return Ok(Some(mapping)),
    };
    providers.remove(Yaml::from(MANAGED_PROVIDER_ID));
    if providers.is_empty() {
        config.remove(Yaml::from("providers"));
        if config.is_empty() {
            mapping.remove(Yaml::from("config"));
            if entry_is_bare_skeleton(&mapping) || mapping.len() <= 2 {
                return Ok(None);
            }
            return Ok(Some(mapping));
        }
    }
    config.insert(Yaml::from("providers"), Yaml::Mapping(providers));
    mapping.insert(Yaml::from("config"), Yaml::Mapping(config));
    Ok(Some(mapping))
}

/// 原生路由与编辑器期望的关键字段比对（不含展示名与密钥明文）。
fn route_matches_expected(route: &Yaml, expected: &Yaml) -> bool {
    let model_fingerprint = |value: &Yaml| -> Vec<(String, Option<i64>, Option<i64>)> {
        value
            .get(Yaml::from("models"))
            .and_then(Yaml::as_sequence)
            .map(|models| {
                models
                    .iter()
                    .map(|model| {
                        (
                            model
                                .get(Yaml::from("id"))
                                .and_then(Yaml::as_str)
                                .unwrap_or("")
                                .to_string(),
                            model
                                .get(Yaml::from("contextWindow"))
                                .and_then(Yaml::as_i64),
                            model.get(Yaml::from("maxTokens")).and_then(Yaml::as_i64),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    route.get(Yaml::from("api")) == expected.get(Yaml::from("api"))
        && route.get(Yaml::from("baseURL")) == expected.get(Yaml::from("baseURL"))
        && route.get(Yaml::from("apiKeyEnv")) == expected.get(Yaml::from("apiKeyEnv"))
        && model_fingerprint(route) == model_fingerprint(expected)
}

/// 状态核心：以 journal 为所有权事实源，明示漂移，不含密钥。
/// `desktop_installed` 由调用方传入（生产环境为 `desktop_app_installed()`）。
fn status_core(
    paths: &DshPaths,
    expected: Option<&Value>,
    journal: &Journal,
    desktop_installed: bool,
) -> DshManagedStatus {
    let mut status = DshManagedStatus {
        desktop_available: desktop_installed,
        ..DshManagedStatus::default()
    };
    let key_ref = managed_key_ref();
    let expected_native = expected
        .map(|settings| managed_native_provider("", settings, &key_ref))
        .and_then(Result::ok);

    // home 层：任何同 ID 条目（含我方旧痕迹）都是遮盖冲突；无法解析时同样
    // 明示，不做静默判定。
    if paths.home_patch().exists() {
        match read_text(&paths.home_patch()) {
            Ok(text) if !text.trim().is_empty() => {
                match scan_entries(&text).and_then(|(.., spans)| {
                    Ok([
                        find_unique(&spans, PI_ROW)?,
                        find_unique(&spans, DEFAULT_MODEL_ROW)?,
                    ]
                    .into_iter()
                    .flatten()
                    .map(|span: &EntrySpan| span.id.clone())
                    .collect::<Vec<String>>())
                }) {
                    Ok(occupied) if !occupied.is_empty() => {
                        status.conflicts.push(format!(
                            "home 层（~/.dsh/cordis.patch.yml）存在 {} 条目，遮盖全部 profile 的托管配置",
                            occupied.join(" / ")
                        ));
                    }
                    Ok(_) => {}
                    Err(_) => status
                        .warnings
                        .push("home 层（~/.dsh/cordis.patch.yml）无法解析，请手动检查".into()),
                }
            }
            Ok(_) => {}
            Err(_) => status
                .conflicts
                .push("home 层（~/.dsh/cordis.patch.yml）无法读取，无法确认是否遮盖托管配置".into()),
        }
    }

    for (name, path) in paths.profile_files() {
        let key = paths.relative_key(&path);
        let slot = journal.rows.get(&key);
        let Ok(text) = read_text(&path) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let spans = match scan_entries(&text) {
            Ok((.., spans)) => spans,
            Err(_) => {
                status
                    .warnings
                    .push(format!("profile '{name}' 的补丁列表无法解析，请手动检查"));
                continue;
            }
        };
        let pi_span = match find_unique(&spans, PI_ROW) {
            Ok(span) => span,
            Err(_) => {
                status
                    .warnings
                    .push(format!("profile '{name}' 存在重复条目，请手动检查"));
                continue;
            }
        };
        let default_span = match find_unique(&spans, DEFAULT_MODEL_ROW) {
            Ok(span) => span,
            Err(_) => {
                status
                    .warnings
                    .push(format!("profile '{name}' 存在重复条目，请手动检查"));
                continue;
            }
        };

        match slot.and_then(|slot| slot.pi_row.as_ref()) {
            Some(record) => {
                let current = pi_span.map(|span| &text[span.start..span.end]);
                if current == Some(record.last.as_str()) {
                    status.profile_names.push(name.clone());
                    if let (Some(expected), Some(span)) = (expected_native.as_ref(), pi_span) {
                        let route = parse_entry(&text, span).ok().and_then(|mapping| {
                            mapping
                                .get(Yaml::from("config"))
                                .and_then(|config| config.as_mapping())
                                .and_then(|config| config.get(Yaml::from("providers")))
                                .and_then(|providers| providers.as_mapping())
                                .and_then(|providers| {
                                    providers.get(Yaml::from(MANAGED_PROVIDER_ID)).cloned()
                                })
                        });
                        match route {
                            None => status.conflicts.push(format!(
                                "profile '{name}' 的托管供应商条目缺失，请重新应用"
                            )),
                            Some(route) if !route_matches_expected(&route, expected) => {
                                status.warnings.push(format!(
                                    "profile '{name}' 的供应商设置已更新，重新应用可同步"
                                ));
                            }
                            Some(_) => {}
                        }
                    }
                } else {
                    status.conflicts.push(format!(
                        "profile '{name}' 的 llm-pi-ai 条目已被手动修改；如需继续托管请先恢复或解除后重新应用"
                    ));
                }
            }
            None => {
                // 无记录：现场不应有我们的痕迹。
                if let Some(span) = pi_span {
                    let claimed = match providers_contain_managed_key(&text, span) {
                        Ok(contains) => span.ours || contains,
                        Err(_) => true, // 无法判定时按可疑处理并明示
                    };
                    if claimed {
                        status.conflicts.push(format!(
                            "profile '{name}' 存在无所有权记录的托管痕迹；请手动清理或重新登记"
                        ));
                    }
                }
            }
        }

        match slot.and_then(|slot| slot.default_model.as_ref()) {
            Some(record) => {
                let current = default_span.map(|span| &text[span.start..span.end]);
                if current != Some(record.last.as_str()) {
                    status.conflicts.push(format!(
                        "profile '{name}' 的 agent-default-model 条目已被手动修改；如需继续托管请先恢复或解除后重新应用"
                    ));
                }
            }
            None => {
                if let Some(span) = default_span.filter(|span| span.ours) {
                    let provider = parse_entry(&text, span)
                        .ok()
                        .and_then(|mapping| {
                            mapping
                                .get(Yaml::from("config"))
                                .and_then(|config| config.as_mapping())
                                .and_then(|config| config.get(Yaml::from("provider")))
                                .and_then(Yaml::as_str)
                                .map(str::to_string)
                        })
                        .unwrap_or_default();
                    if provider == MANAGED_PROVIDER_ID {
                        status.conflicts.push(format!(
                            "profile '{name}' 存在无所有权记录的托管默认模型条目；请手动清理"
                        ));
                    }
                }
            }
        }
    }

    if paths.legacy_config().exists() {
        status.warnings.push(
            "检测到旧版 DeepSeek Harness 布局（config.yaml）；托管仅写入 0.1.5+ 的 profiles 布局".into(),
        );
    }

    match dsh_config::credential_document(&paths.credentials()) {
        Ok(document) => {
            let stored = document
                .get(Yaml::from("refs"))
                .and_then(|refs| refs.get(Yaml::from(key_ref.as_str())))
                .and_then(Yaml::as_str);
            match &journal.credential {
                Some(record) => match stored {
                    Some(value) if sha256_hex(value) == record.last_hash => {
                        if let Some(expected_key) = expected
                            .and_then(|settings| settings.pointer("/options/apiKey"))
                            .and_then(Value::as_str)
                        {
                            if sha256_hex(expected_key) != record.last_hash {
                                status.warnings.push(
                                    "站点密钥已更新，重新应用可同步到 DeepSeek Harness 凭据".into(),
                                );
                            }
                        }
                    }
                    _ => status.conflicts.push(format!(
                        "DeepSeek Harness 凭据中的 {key_ref} 已被手动修改或移除；如需继续托管请先恢复或清理"
                    )),
                },
                None => {
                    if stored.is_some() {
                        status.conflicts.push(format!(
                            "DeepSeek Harness 凭据中存在未登记的同名引用 {key_ref}，不能凭 ID 认领"
                        ));
                    }
                }
            }
        }
        Err(_) => status.warnings.push(
            "DeepSeek Harness 凭据文档版本不受支持，请在 DeepSeek Harness 中完成迁移后重试".into(),
        ),
    }

    status.managed = !status.profile_names.is_empty();
    status
}

// ---------------------------------------------------------------------------
// AppState 组合与 Tauri 命令
// ---------------------------------------------------------------------------

/// 读取文件字节；不存在返回 None，其他错误传播（不吞权限/IO 错误）。
fn read_bytes_or_none(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}

/// 校验并应用托管供应商：写入全部目标 profile、登记所有权记录、写入凭据
/// 引用，并在同一事务边界中保存数据库镜像。`defaultModel` 是前端附加字段，
/// 落盘前剥离，不会进入原生配置。
pub(crate) fn apply_managed(
    state: &AppState,
    provider: Provider,
) -> Result<DshManagedStatus, AppError> {
    if provider.id != MANAGED_PROVIDER_ID {
        return Err(AppError::InvalidInput(format!(
            "托管供应商 id 必须是 '{MANAGED_PROVIDER_ID}'"
        )));
    }
    if !provider.settings_config.is_object() {
        return Err(AppError::InvalidInput("settingsConfig 必须是对象".into()));
    }
    // defaultModel 是前端附加字段：数据库编辑器配置原样保留（重开页面不丢
    // 用户选择），原生配置由白名单派生，defaultModel 不会落入 dsh 文件。
    let default_model = extract_default_model(&provider.settings_config)?;
    let display_name = provider
        .settings_config
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .or(Some(provider.name.as_str()))
        .unwrap_or(MANAGED_PROVIDER_ID)
        .to_string();
    let settings = provider.settings_config.clone();
    let db = state.db.clone();
    apply_core(
        &DshPaths::live(),
        &display_name,
        &settings,
        &default_model,
        desktop_app_installed(),
        &journal_path(),
        move || db.save_provider("dsh", &provider).map_err(Into::into),
    )
}

/// 解除托管：恢复被接管的用户条目（不覆盖后续手改，手改槽位保留记录），
/// 移除本模块写入的条目，并删除数据库镜像。凭据引用不删除。
pub(crate) fn release_managed(state: &AppState) -> Result<(), AppError> {
    let db = state.db.clone();
    release_core(&DshPaths::live(), &journal_path(), move || {
        let _ = db.delete_provider("dsh", MANAGED_PROVIDER_ID)?;
        Ok(())
    })
}

pub(crate) fn managed_status(state: &AppState) -> Result<DshManagedStatus, AppError> {
    let expected = state
        .db
        .get_provider_by_id(MANAGED_PROVIDER_ID, "dsh")?
        .map(|provider| provider.settings_config);
    let paths = DshPaths::live();
    let journal = match load_journal(&journal_path()).and_then(|journal| {
        journal_for_root(journal, &paths.root)
    }) {
        Ok(journal) => journal,
        Err(error) => {
            // fail-closed：记录不可读时不能当作无记录，明示冲突。
            let mut status = DshManagedStatus::default();
            status.conflicts.push(error.to_string());
            return Ok(status);
        }
    };
    Ok(status_core(&paths, expected.as_ref(), &journal, desktop_app_installed()))
}

/// 应用托管供应商配置（含数据库保存；前端无需再调用 provider 命令）。
#[tauri::command]
pub async fn vvcode_dsh_apply_managed(
    app_handle: tauri::AppHandle,
    provider: Provider,
) -> Result<DshManagedStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<AppState>()
            .ok_or_else(|| "应用状态不可用".to_string())?;
        apply_managed(state.inner(), provider).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("应用托管配置任务执行失败: {error}"))?
}

/// 查询托管状态（camelCase，不含密钥）。
#[tauri::command]
pub async fn vvcode_dsh_get_managed_status(
    app_handle: tauri::AppHandle,
) -> Result<DshManagedStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<AppState>()
            .ok_or_else(|| "应用状态不可用".to_string())?;
        managed_status(state.inner()).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("查询托管状态任务执行失败: {error}"))?
}

// ---------------------------------------------------------------------------
// 测试：仅使用临时目录，不读取真实用户配置与凭据
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dsh: tempfile::TempDir,
        _app: tempfile::TempDir,
        paths: DshPaths,
        journal_file: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dsh = tempfile::tempdir().unwrap();
            let app = tempfile::tempdir().unwrap();
            Self {
                paths: DshPaths {
                    root: dsh.path().to_path_buf(),
                },
                journal_file: app.path().join("dsh-managed-journal.json"),
                _dsh: dsh,
                _app: app,
            }
        }

        fn write_profile(&self, name: &str, text: &str) {
            let path = self
                .paths
                .root
                .join("profiles")
                .join(name)
                .join("cordis.patch.yml");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
        }

        fn profile_text(&self, name: &str) -> String {
            read_text(
                &self
                    .paths
                    .root
                    .join("profiles")
                    .join(name)
                    .join("cordis.patch.yml"),
            )
            .unwrap()
        }

        fn apply(&self, settings: &Value) -> Result<DshManagedStatus, AppError> {
            apply_core(
                &self.paths,
                settings.get("name").and_then(Value::as_str).unwrap_or(""),
                settings,
                &extract_default_model(settings).unwrap(),
                false,
                &self.journal_file,
                || Ok(()),
            )
        }

        fn apply_ok(&self, settings: &Value) -> DshManagedStatus {
            self.apply(settings)
                .expect("apply 应成功")
        }

        fn status(&self, settings: &Value) -> DshManagedStatus {
            let journal = journal_for_root(load_journal(&self.journal_file).unwrap(), &self.paths.root).unwrap();
            status_core(&self.paths, Some(settings), &journal, false)
        }

        fn journal(&self) -> Journal {
            journal_for_root(load_journal(&self.journal_file).unwrap(), &self.paths.root).unwrap()
        }
    }

    fn settings() -> Value {
        json!({
            "name": "VV Code",
            "api": "openai-responses",
            "options": {
                "baseURL": "https://api.vvcode.top/v1",
                "apiKey": "test-managed-key"
            },
            "models": {
                "model-a": {"name": "Model A", "limit": {"context": 128000, "output": 8192}},
                "model-b": {"name": "Model B", "limit": {"context": 100000, "output": 60000}}
            }
        })
    }

    #[test]
    fn multi_profile_apply_preserves_user_entries_and_writes_private_credentials() {
        let fx = Fixture::new();
        fx.write_profile(
            "web",
            "# native comment\n- id: other\n  name: my-plugin\n  config: {value: keep}\n",
        );
        fx.write_profile("headless", "# headless\n[]\n");
        let status = fx.apply_ok(&settings());
        assert_eq!(status.profile_names, ["web", "headless"]);
        assert!(status.conflicts.is_empty());
        for name in ["web", "headless"] {
            let text = fx.profile_text(name);
            if name == "web" {
                assert!(text.starts_with("# native comment\n"));
                assert!(text.contains("- id: other\n  name: my-plugin\n  config: {value: keep}\n"));
            }
            assert!(text.contains(&format!("- id: {PI_ROW} {MANAGED_MARK}")));
            assert!(text.contains(&format!("- id: {DEFAULT_MODEL_ROW} {MANAGED_MARK}")));
            assert!(text.contains(&format!("    {MANAGED_PROVIDER_ID}:")));
            assert!(!text.contains("test-managed-key"));
        }
        let credentials = fx.paths.credentials();
        let text = fs::read_to_string(&credentials).unwrap();
        assert!(text.contains(&managed_key_ref()));
        assert!(text.contains("version: 1"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&credentials).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // journal 绑定 root 并记录两行。
        let journal = fx.journal();
        assert_eq!(
            journal.root.as_deref(),
            Some(fx.paths.canonical_root().to_string_lossy().as_ref())
        );
        assert_eq!(journal.rows.len(), 2);
        assert!(journal.credential.is_some());
    }

    #[test]
    fn desktop_profile_created_from_template_when_app_installed() {
        let fx = Fixture::new();
        let result = apply_core(
            &fx.paths,
            "VV Code",
            &settings(),
            &extract_default_model(&settings()).unwrap(),
            true,
            &fx.journal_file,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(result.profile_names, ["desktop"]);
        let text = fx.profile_text("desktop");
        assert!(text.starts_with("# Your patch layer"));
        assert!(text.contains(MANAGED_MARK));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = fx.paths.root.join("profiles").join("desktop");
            let mode = fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        // 未安装 desktop 且无任何 profile：明确失败，不制造目录。
        let fx2 = Fixture::new();
        let error = apply_core(
            &fx2.paths,
            "VV Code",
            &settings(),
            "model-a",
            false,
            &fx2.journal_file,
            || Ok(()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("未找到 DeepSeek Harness 配置"));
        assert!(!fx2.paths.root.join("profiles").exists());
    }

    #[test]
    fn legacy_layout_is_rejected_without_touching_it() {
        let fx = Fixture::new();
        fs::write(fx.paths.legacy_config(), "[]\n").unwrap();
        let error = apply_core(
            &fx.paths,
            "VV Code",
            &settings(),
            "model-a",
            false,
            &fx.journal_file,
            || Ok(()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("旧版"));
        assert!(!fx.paths.root.join("profiles").exists());
        assert_eq!(fs::read_to_string(fx.paths.legacy_config()).unwrap(), "[]\n");
    }

    #[test]
    fn home_layer_shadowing_rejects_the_whole_apply_with_zero_writes() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        let home = fx.paths.home_patch();
        fs::write(
            &home,
            "- id: llm-pi-ai\n  config:\n    providers: {custom: {api: openai-completions}}\n",
        )
        .unwrap();
        let error = fx.apply(&settings()).unwrap_err();
        assert!(error.to_string().contains("home 层"));
        // 零写入：profile 原样、无凭据、无 journal、home 原样。
        assert_eq!(fx.profile_text("web"), PROFILE_TEMPLATE);
        assert_eq!(
            fs::read_to_string(&home).unwrap(),
            "- id: llm-pi-ai\n  config:\n    providers: {custom: {api: openai-completions}}\n"
        );
        assert!(!fx.paths.credentials().exists());
        assert!(!fx.journal_file.exists());
        // 我方旧痕迹的 home 条目同样拒绝（不镜像、不清理）。
        fs::write(
            &home,
            &format!("- id: {PI_ROW} {MANAGED_MARK}\n  config:\n    providers: {{}}\n"),
        )
        .unwrap();
        assert!(fx.apply(&settings()).is_err());
        assert!(!fx.paths.credentials().exists());
    }

    #[test]
    fn first_apply_never_claims_existing_same_id_provider_key() {
        let fx = Fixture::new();
        fx.write_profile(
            "web",
            format!(
                "- id: {PI_ROW}\n  config:\n    providers:\n      {MANAGED_PROVIDER_ID}: {{displayName: 别人家, api: openai-completions}}\n"
            )
            .as_str(),
        );
        fx.write_profile("headless", PROFILE_TEMPLATE);
        let status = fx.apply_ok(&settings());
        assert_eq!(status.profile_names, ["headless"]);
        assert!(status
            .conflicts
            .iter()
            .any(|conflict| conflict.contains("同名 provider 键")));
        assert!(fx.profile_text("web").contains("别人家"));
        // 凭据合法写入（无同名冲突）。
        assert!(fx.paths.credentials().exists());
    }

    #[test]
    fn first_apply_never_claims_existing_credential_reference() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fs::write(
            fx.paths.credentials(),
            format!("version: 1\nrefs: {{{}: someone-else}}\n", managed_key_ref()),
        )
        .unwrap();
        let error = fx.apply(&settings()).unwrap_err();
        assert!(error.to_string().contains("不能凭 ID 认领"));
        assert_eq!(fx.profile_text("web"), PROFILE_TEMPLATE);
        assert!(
            fs::read_to_string(fx.paths.credentials())
                .unwrap()
                .contains("someone-else")
        );
        assert!(!fx.journal_file.exists());
        // 错误消息不包含双方密钥值。
        assert!(!error.to_string().contains("someone-else"));
        assert!(!error.to_string().contains("test-managed-key"));
    }

    #[test]
    fn hand_edited_credential_blocks_reapply_without_overwrite() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        // 手改凭据值。
        let credentials = fx.paths.credentials();
        fs::write(
            &credentials,
            format!("version: 1\nrefs: {{{}: hand-edited}}\n", managed_key_ref()),
        )
        .unwrap();
        let error = fx.apply(&settings()).unwrap_err();
        assert!(error.to_string().contains("已被手动修改"));
        assert!(fs::read_to_string(&credentials).unwrap().contains("hand-edited"));
        // 状态明示冲突且不泄露值。
        let status = fx.status(&settings());
        assert!(status
            .conflicts
            .iter()
            .any(|conflict| conflict.contains(managed_key_ref().as_str())));
        assert!(!serde_json::to_string(&status).unwrap().contains("hand-edited"));
    }

    #[test]
    fn hand_edited_rows_block_reapply_and_keep_user_bytes() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.write_profile("headless", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        // 手改 web 的默认模型行（保留标记也算手改）。
        let mut web = fx.profile_text("web");
        web = web.replace("    model: model-a", "    model: user-pick");
        fx.write_profile("web", &web);
        let status = fx.apply_ok(&settings());
        // web 仍留有托管 provider 行（默认模型行被手改），状态如实列出并报冲突。
        assert_eq!(status.profile_names, ["web", "headless"]);
        assert!(status
            .conflicts
            .iter()
            .any(|conflict| conflict.contains("web") && conflict.contains("agent-default-model")));
        assert!(fx.profile_text("web").contains("user-pick"));
        // 删除我方条目同样视为手改。
        let headless = fx
            .profile_text("headless")
            .replace(&format!("- id: {DEFAULT_MODEL_ROW} {MANAGED_MARK}\n  config:\n    provider: {MANAGED_PROVIDER_ID}\n    model: model-a\n"), "");
        fx.write_profile("headless", &headless);
        let status = fx.apply_ok(&settings());
        assert!(status.conflicts.iter().any(|conflict| conflict.contains("headless")));
    }

    #[test]
    fn reapply_with_matching_journal_updates_and_stays_idempotent() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        let first = fx.profile_text("web");
        let credentials_first = fs::read(fx.paths.credentials()).unwrap();
        let journal_first = fs::read(&fx.journal_file).unwrap();
        let status = fx.apply_ok(&settings());
        assert!(status.conflicts.is_empty());
        assert_eq!(fx.profile_text("web"), first);
        assert_eq!(fs::read(fx.paths.credentials()).unwrap(), credentials_first);
        assert_eq!(fs::read(&fx.journal_file).unwrap(), journal_first);
        // 更新模型表（journal 匹配 → 允许前移 last）。
        let mut updated = settings();
        updated["models"]["model-c"] = json!({"name": "Model C", "limit": {"context": 64000, "output": 4096}});
        fx.apply_ok(&updated);
        let text = fx.profile_text("web");
        assert!(text.contains("model-c"));
        let status = fx.status(&updated);
        assert!(status.conflicts.is_empty());
        // 旧期望 → 状态提示同步（warning 而非 conflict）。
        let status = fx.status(&settings());
        assert!(status.conflicts.is_empty());
        assert!(status
            .warnings
            .iter()
            .any(|warning| warning.contains("重新应用可同步")));
    }

    #[test]
    fn commit_failure_rolls_back_all_writes() {
        let fx = Fixture::new();
        fx.write_profile("web", "# keep\n[]\n");
        let settings = settings();
        let result = apply_core(
            &fx.paths,
            "VV Code",
            &settings,
            &extract_default_model(&settings).unwrap(),
            false,
            &fx.journal_file,
            || Err(AppError::Database("injected".into())),
        );
        assert!(result.is_err());
        assert_eq!(fx.profile_text("web"), "# keep\n[]\n");
        assert!(!fx.paths.credentials().exists());
        assert!(!fx.journal_file.exists());
    }

    #[test]
    fn concurrent_modification_between_plan_and_write_is_rejected() {
        let fx = Fixture::new();
        fx.write_profile("web", "# keep\n[]\n");
        let plan = WritePlan {
            kind: PlanKind::Patch,
            path: fx.paths.root.join("profiles").join("web").join("cordis.patch.yml"),
            next: Some(b"- id: x\n".to_vec()),
            base: Some(b"# keep\n[]\n".to_vec()),
        };
        // plan 与写入之间被外部改写。
        fx.write_profile("web", "# external edit\n[]\n");
        let error = commit_plans(vec![plan], || Ok(())).unwrap_err();
        assert!(error.to_string().contains("规划后被其他程序修改"));
        assert_eq!(fx.profile_text("web"), "# external edit\n[]\n");
    }

    #[test]
    fn rollback_keeps_external_edits_made_after_our_write() {
        let fx = Fixture::new();
        fx.write_profile("web", "# original\n[]\n");
        let written = vec![(
            fx.paths.root.join("profiles").join("web").join("cordis.patch.yml"),
            Some(b"# original\n[]\n".to_vec()),
            Some(b"# ours\n- id: x\n".to_vec()),
        )];
        // 我们写入后、回滚前被外部改写。
        fx.write_profile("web", "# external\n[]\n");
        rollback(&written);
        assert_eq!(fx.profile_text("web"), "# external\n[]\n");
    }

    #[test]
    fn default_model_explicit_first_and_validated() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        let mut explicit = settings();
        explicit["defaultModel"] = json!("model-b");
        fx.apply_ok(&explicit);
        assert!(fx.profile_text("web").contains("    model: model-b"));
        assert!(!fx.profile_text("web").contains("defaultModel"));

        let fx2 = Fixture::new();
        fx2.write_profile("web", PROFILE_TEMPLATE);
        fx2.apply_ok(&settings());
        assert!(fx2.profile_text("web").contains("    model: model-a"));

        let mut missing = settings();
        missing["defaultModel"] = json!("nope");
        assert!(extract_default_model(&missing)
            .unwrap_err()
            .to_string()
            .contains("不在模型列表中"));
    }

    #[test]
    fn output_budget_caps_max_tokens_by_context() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        let text = fx.profile_text("web");
        // model-a: ctx=128000 out=8192 → room=max(32000, -1536)=32000 → 8192 不变。
        assert!(text.contains("        maxTokens: 8192"));
        // model-b: ctx=100000 out=60000 → room=25000。
        assert!(text.contains("        maxTokens: 25000"));
        assert_eq!(budgeted_output(None, 5000), 5000);
        assert_eq!(budgeted_output(Some(200000), 60000), 50000);
    }

    #[test]
    fn release_restores_user_entries_via_journal() {
        let fx = Fixture::new();
        fx.write_profile(
            "web",
            "- id: agent-default-model\n  config: {provider: deepseek-official, model: deepseek-chat}\n- id: other\n  name: keep\n",
        );
        fx.apply_ok(&settings());
        assert!(fx.profile_text("web").contains(MANAGED_MARK));
        release_core(&fx.paths, &fx.journal_file, || Ok(())).unwrap();
        let restored = fx.profile_text("web");
        assert!(
            restored.contains(
                "- id: agent-default-model\n  config: {provider: deepseek-official, model: deepseek-chat}"
            ),
            "用户原条目应恢复: {restored}"
        );
        assert!(restored.contains("- id: other\n  name: keep"));
        assert!(!restored.contains(MANAGED_MARK));
        // 解除后 journal 清空行槽位，凭据槽保留（凭据不删）。
        let journal = fx.journal();
        assert!(journal.rows.values().all(|file| file.pi_row.is_none() && file.default_model.is_none()));
        assert!(journal.credential.is_some());
        assert!(fx.paths.credentials().exists());
    }

    #[test]
    fn release_preserves_hand_edits_and_keeps_ownership_records() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        // 手改我方默认模型行。
        let mut web = fx.profile_text("web");
        web = web.replace("    model: model-a", "    model: user-model");
        fx.write_profile("web", &web);
        let error = release_core(&fx.paths, &fx.journal_file, || Ok(())).unwrap_err();
        assert!(error.to_string().contains("手动修改"));
        assert!(fx.profile_text("web").contains("user-model"));
        // 所有权记录保留：恢复原值后可成功解除。
        let journal_before = fs::read(&fx.journal_file).unwrap();
        assert_eq!(fs::read(&fx.journal_file).unwrap(), journal_before);
        let mut restored = fx.profile_text("web");
        restored = restored.replace("    model: user-model", "    model: model-a");
        fx.write_profile("web", &restored);
        release_core(&fx.paths, &fx.journal_file, || Ok(())).unwrap();
        assert!(!fx.profile_text("web").contains(MANAGED_MARK));
    }

    #[test]
    fn release_cleans_unowned_marked_skeleton_and_user_keys_survive() {
        let fx = Fixture::new();
        // 用户自有键 + 我们格式的标记条目，但 journal 丢失。
        fx.write_profile(
            "web",
            format!(
                "- id: {PI_ROW} {MANAGED_MARK}\n  config:\n    providers:\n      mine: {{displayName: Mine, api: openai-completions}}\n      {MANAGED_PROVIDER_ID}: {{displayName: X, api: openai-responses}}\n"
            )
            .as_str(),
        );
        release_core(&fx.paths, &fx.journal_file, || Ok(())).unwrap();
        let released = fx.profile_text("web");
        assert!(released.contains("mine:"), "用户键保留: {released}");
        assert!(!released.contains(MANAGED_PROVIDER_ID));
        assert!(!released.contains(MANAGED_MARK));
        // 我方默认模型条目（无记录、指向我方）→ 整条移除。
        fx.write_profile(
            "web",
            format!("- id: {DEFAULT_MODEL_ROW} {MANAGED_MARK}\n  config: {{provider: {MANAGED_PROVIDER_ID}, model: m}}\n")
                .as_str(),
        );
        release_core(&fx.paths, &fx.journal_file, || Ok(())).unwrap();
        // 该文件本就没有模板注释头，清空后保持合法空序列，不虚构模板内容。
        assert_eq!(fx.profile_text("web"), "[]\n");
    }

    #[test]
    fn release_keeps_user_picked_default_model_content() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        // 用户在 dsh /model 改选（条目内容变化，journal 不再匹配）。
        let mut web = fx.profile_text("web");
        web = web.replace(
            &format!("    provider: {MANAGED_PROVIDER_ID}"),
            "    provider: deepseek-official",
        );
        fx.write_profile("web", &web);
        release_core(&fx.paths, &fx.journal_file, || Ok(())).unwrap();
        let released = fx.profile_text("web");
        assert!(released.contains("provider: deepseek-official"));
        assert!(!released.contains(MANAGED_MARK));
    }

    #[test]
    fn release_restores_empty_sequence_for_created_entries() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        release_core(&fx.paths, &fx.journal_file, || Ok(())).unwrap();
        assert_eq!(fx.profile_text("web"), PROFILE_TEMPLATE);
        let parsed: Yaml = serde_yaml::from_str(&fx.profile_text("web")).unwrap();
        assert!(matches!(parsed, Yaml::Sequence(ref sequence) if sequence.is_empty()));
    }

    #[test]
    fn status_reports_drift_missing_rows_and_unowned_traces() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        let expected = settings();
        fx.apply_ok(&expected);
        assert!(fx.status(&expected).conflicts.is_empty());

        // 删除我方 provider 行 → 手改冲突（按扫描区间删除，不依赖渲染格式）。
        let mut web = fx.profile_text("web");
        let (.., spans) = scan_entries(&web).unwrap();
        let span = spans.iter().find(|span| span.id == PI_ROW).unwrap();
        let managed_row = web[span.start..span.end].to_string();
        web = format!("{}{}", &web[..span.start], &web[span.end..]);
        fx.write_profile("web", &web);
        let status = fx.status(&expected);
        assert!(status
            .conflicts
            .iter()
            .any(|conflict| conflict.contains("llm-pi-ai")));

        // 无 journal 的现场痕迹 → 冲突。
        let fx2 = Fixture::new();
        fx2.write_profile("web", &managed_row);
        let status = status_core(
            &fx2.paths,
            Some(&expected),
            &Journal::default(),
            false,
        );
        assert!(status
            .conflicts
            .iter()
            .any(|conflict| conflict.contains("无所有权记录")));
    }

    #[test]
    fn https_and_loopback_validation() {
        validate_managed_base_url("https://api.vvcode.top/v1").unwrap();
        validate_managed_base_url("http://127.0.0.1:3000/v1").unwrap();
        validate_managed_base_url("http://localhost:3000").unwrap();
        validate_managed_base_url("http://[::1]:3000").unwrap();
        assert!(validate_managed_base_url("http://192.168.1.5/v1").is_err());
        assert!(validate_managed_base_url("ftp://example.com").is_err());
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        let mut insecure = settings();
        insecure["options"]["baseURL"] = json!("http://192.168.1.5/v1");
        let error = apply_core(
            &fx.paths,
            "VV Code",
            &insecure,
            &extract_default_model(&insecure).unwrap(),
            false,
            &fx.journal_file,
            || Ok(()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("HTTPS"));
        assert_eq!(fx.profile_text("web"), PROFILE_TEMPLATE);
    }

    #[test]
    fn symlinked_targets_are_rejected() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        // 把 credentials 变成指向外部的符号链接。
        let outside = fx._app.path().join("outside.yaml");
        fs::write(&outside, "version: 1\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, fx.paths.credentials()).unwrap();
        let error = fx.apply(&settings()).unwrap_err();
        assert!(error.to_string().contains("符号链接"));
        #[cfg(unix)]
        assert_eq!(
            fs::read_to_string(fx.paths.credentials()).unwrap(),
            "version: 1\n"
        );
    }

    #[test]
    fn journal_bound_to_a_different_root_is_refused() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        // 同一 journal 换根目录（模拟 DSH_HOME 切换）→ 明确拒绝。
        let other = Fixture::new();
        other.write_profile("web", PROFILE_TEMPLATE);
        fs::copy(&fx.journal_file, &other.journal_file).unwrap();
        let error = other.apply(&settings()).unwrap_err();
        assert!(error.to_string().contains("其他 DeepSeek Harness 目录"));
    }

    #[test]
    fn tags_block_only_the_affected_profile() {
        let fx = Fixture::new();
        fx.write_profile(
            "web",
            "- id: llm-pi-ai\n  config:\n    providers:\n      native: {apiKey: !!js process.env.K}\n",
        );
        fx.write_profile("headless", PROFILE_TEMPLATE);
        let status = fx.apply_ok(&settings());
        assert_eq!(status.profile_names, ["headless"]);
        assert!(status
            .conflicts
            .iter()
            .any(|conflict| conflict.contains("web") && conflict.contains("YAML 标签")));
        assert!(fx.profile_text("web").contains("!!js process.env.K"));
    }

    #[test]
    fn credentials_version_guard_rejects_unsupported_layout() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fs::write(fx.paths.credentials(), "version: 2\nrefs: {}\n").unwrap();
        let error = fx.apply(&settings()).unwrap_err();
        assert!(error.to_string().contains("Unsupported"));
        assert_eq!(
            fs::read_to_string(fx.paths.credentials()).unwrap(),
            "version: 2\nrefs: {}\n"
        );
    }

    #[test]
    fn status_and_errors_never_leak_the_api_key() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        let expected = settings();
        fx.apply_ok(&expected);
        let status = fx.status(&expected);
        assert!(!serde_json::to_string(&status).unwrap().contains("test-managed-key"));
        // journal 里只存哈希。
        let journal_text = fs::read_to_string(&fx.journal_file).unwrap();
        assert!(!journal_text.contains("test-managed-key"));
        assert!(journal_text.contains("last_hash"));
    }

    #[test]
    fn unreadable_or_corrupt_journal_refuses_instead_of_fail_open() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        let web_after_apply = fx.profile_text("web");
        // 损坏的 journal：apply/release 都拒绝零写入，status 明示冲突。
        fs::write(&fx.journal_file, "{ not json").unwrap();
        assert!(fx.apply(&settings()).is_err());
        assert_eq!(fx.profile_text("web"), web_after_apply);
        assert!(release_core(&fx.paths, &fx.journal_file, || Ok(())).is_err());
        assert_eq!(fx.profile_text("web"), web_after_apply);
        let journal = load_journal(&fx.journal_file);
        assert!(journal.is_err());
        // 未知版本同样拒绝。
        fs::write(
            &fx.journal_file,
            serde_json::to_string(&json!({
                "version": 99,
                "root": fx.paths.canonical_root().to_string_lossy(),
                "rows": {"profiles/web/cordis.patch.yml": {"llm-pi-ai": {"last": "x"}}}
            }))
            .unwrap(),
        )
        .unwrap();
        let error = fx.apply(&settings()).unwrap_err();
        assert!(error.to_string().contains("99"));
        #[cfg(unix)]
        {
            // 无读权限：明确失败，不当作空记录。
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&fx.journal_file).unwrap().permissions();
            fs::set_permissions(&fx.journal_file, fs::Permissions::from_mode(0o000)).unwrap();
            let error = fx.apply(&settings()).unwrap_err();
            assert!(error.to_string().contains("拒绝") || error.to_string().contains("denied") || !error.to_string().is_empty());
            assert_eq!(fx.profile_text("web"), web_after_apply);
            fs::set_permissions(&fx.journal_file, fs::Permissions::from_mode(mode.mode())).unwrap();
        }
    }

    #[test]
    fn scan_entries_parses_ids_marks_and_head() {
        let text = "# note\n---\n- id: a # vvcode-managed\n  config: {x: 1}\n- id: b\n";
        let (head, spans) = scan_entries(text).unwrap();
        assert!(head.contains("# note"));
        assert!(head.contains("---"));
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].id, "a");
        assert!(spans[0].ours);
        assert_eq!(spans[1].id, "b");
        assert!(!spans[1].ours);
        assert_eq!(
            &text[spans[0].start..spans[0].end],
            "- id: a # vvcode-managed\n  config: {x: 1}\n"
        );
        assert!(scan_entries("not: a-list\n").is_err());
        assert!(scan_entries("- id: a\nbad top level\n").is_err());
    }

    #[test]
    fn lock_order_puts_credentials_before_patches() {
        let fx = Fixture::new();
        fx.write_profile("web", PROFILE_TEMPLATE);
        fx.apply_ok(&settings());
        // profile 补丁的锁被占用时，更新应报错而不是绕过或死等。
        let lock = fx
            .paths
            .root
            .join("profiles/web/cordis.patch.yml.lock");
        fs::write(&lock, "0").unwrap();
        let mut updated = settings();
        updated["models"]["model-c"] =
            json!({"name": "Model C", "limit": {"context": 64000, "output": 4096}});
        let before = fx.profile_text("web");
        let error = fx.apply(&updated).unwrap_err();
        assert!(!error.to_string().is_empty());
        assert_eq!(fx.profile_text("web"), before);
        fs::remove_file(&lock).unwrap();
        fx.apply_ok(&updated);
        assert!(fx.profile_text("web").contains("model-c"));
    }
}
