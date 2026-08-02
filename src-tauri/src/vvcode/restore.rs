//! Restore commands owned by the VV Code managed-provider workflow.

use std::str::FromStr;

use tauri::Manager;

use crate::app_config::AppType;
use crate::error::AppError;
use crate::services::ProviderService;
use crate::store::AppState;

const MANAGED_PROVIDER_ID: &str = "vv-code-managed";

fn official_seed_id(app_type: &AppType) -> Option<&'static str> {
    match app_type {
        AppType::Claude => Some(crate::database::CLAUDE_OFFICIAL_PROVIDER_ID),
        AppType::ClaudeDesktop => Some(crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID),
        AppType::Codex => Some(crate::database::CODEX_OFFICIAL_PROVIDER_ID),
        AppType::Gemini => Some(crate::database::GEMINI_OFFICIAL_PROVIDER_ID),
        _ => None,
    }
}

fn clear_managed_openclaw_defaults(
    defaults: &mut crate::openclaw_config::OpenClawAgentsDefaults,
) -> bool {
    let prefix = format!("{MANAGED_PROVIDER_ID}/");
    let mut changed = false;

    if let Some(catalog) = defaults.models.as_mut() {
        let previous_len = catalog.len();
        catalog.retain(|model_ref, _| !model_ref.starts_with(&prefix));
        changed |= catalog.len() != previous_len;
        if catalog.is_empty() {
            defaults.models = None;
        }
    }

    if let Some(model) = defaults.model.as_mut() {
        if model.primary.starts_with(&prefix) {
            let mut remaining = model
                .fallbacks
                .iter()
                .filter(|model_ref| !model_ref.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                defaults.model = None;
            } else {
                model.primary = remaining.remove(0);
                model.fallbacks = remaining;
            }
            changed = true;
        } else {
            let previous_len = model.fallbacks.len();
            model
                .fallbacks
                .retain(|model_ref| !model_ref.starts_with(&prefix));
            changed |= model.fallbacks.len() != previous_len;
        }
    }

    changed
}

fn clear_managed_hermes_model(model: &mut crate::hermes_config::HermesModelConfig) -> bool {
    if model.provider.as_deref() != Some(MANAGED_PROVIDER_ID) {
        return false;
    }

    model.provider = None;
    model.default = None;
    true
}

fn restore_openclaw_defaults(state: &AppState) -> Result<(), AppError> {
    let previous_defaults = crate::openclaw_config::get_agents_defaults()?;
    let mut cleaned_defaults = previous_defaults.clone();
    let defaults_changed = cleaned_defaults
        .as_mut()
        .is_some_and(clear_managed_openclaw_defaults);

    if let Some(defaults) = cleaned_defaults.as_ref().filter(|_| defaults_changed) {
        crate::openclaw_config::set_agents_defaults(defaults)?;
    }

    if let Err(error) =
        ProviderService::remove_from_live_config(state, AppType::OpenClaw, MANAGED_PROVIDER_ID)
    {
        if let Some(defaults) = previous_defaults.as_ref().filter(|_| defaults_changed) {
            if let Err(rollback_error) = crate::openclaw_config::set_agents_defaults(defaults) {
                log::warn!(
                    "恢复 OpenClaw 默认配置失败后回滚 agents.defaults 也失败: {rollback_error}"
                );
            }
        }
        return Err(error);
    }

    Ok(())
}

fn restore_hermes_defaults(state: &AppState) -> Result<(), AppError> {
    let previous_model = crate::hermes_config::get_model_config()?;
    let mut cleaned_model = previous_model.clone();
    let model_changed = cleaned_model
        .as_mut()
        .is_some_and(clear_managed_hermes_model);

    if let Some(model) = cleaned_model.as_ref().filter(|_| model_changed) {
        crate::hermes_config::set_model_config(model)?;
    }

    if let Err(error) =
        ProviderService::remove_from_live_config(state, AppType::Hermes, MANAGED_PROVIDER_ID)
    {
        if let Some(model) = previous_model.as_ref().filter(|_| model_changed) {
            if let Err(rollback_error) = crate::hermes_config::set_model_config(model) {
                log::warn!("恢复 Hermes 默认配置失败后回滚 model 配置也失败: {rollback_error}");
            }
        }
        return Err(error);
    }

    Ok(())
}

fn restore_official_configuration_internal(
    state: &AppState,
    app_type: AppType,
) -> Result<(), AppError> {
    if let Some(seed_id) = official_seed_id(&app_type) {
        state
            .db
            .ensure_official_seed_by_id(seed_id, app_type.clone())?;
        ProviderService::switch(state, app_type, seed_id)?;
        return Ok(());
    }

    match app_type {
        AppType::OpenClaw => restore_openclaw_defaults(state),
        AppType::Hermes => restore_hermes_defaults(state),
        _ => Err(AppError::Message(
            "当前应用不支持恢复官方默认配置".to_string(),
        )),
    }
}

/// Restore the selected tool to its vendor/native configuration.
#[tauri::command]
pub async fn restore_official_configuration(
    app_handle: tauri::AppHandle,
    app: String,
) -> Result<(), String> {
    let app_type = AppType::from_str(&app).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<AppState>()
            .ok_or_else(|| "应用状态不可用".to_string())?;
        restore_official_configuration_internal(state.inner(), app_type).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("恢复官方默认配置任务执行失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn claude_desktop_uses_its_independent_official_seed() {
        assert_eq!(
            official_seed_id(&AppType::ClaudeDesktop),
            Some(crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID)
        );
        assert_ne!(
            official_seed_id(&AppType::ClaudeDesktop),
            official_seed_id(&AppType::Claude)
        );
    }

    #[test]
    fn openclaw_cleanup_promotes_non_managed_fallback_and_prunes_catalog() {
        let mut defaults = crate::openclaw_config::OpenClawAgentsDefaults {
            model: Some(crate::openclaw_config::OpenClawDefaultModel {
                primary: "vv-code-managed/model-a".to_string(),
                fallbacks: vec![
                    "vv-code-managed/model-b".to_string(),
                    "native/model-c".to_string(),
                ],
                extra: HashMap::new(),
            }),
            models: Some(HashMap::from([
                (
                    "vv-code-managed/model-a".to_string(),
                    crate::openclaw_config::OpenClawModelCatalogEntry {
                        alias: Some("Managed".to_string()),
                        extra: HashMap::new(),
                    },
                ),
                (
                    "native/model-c".to_string(),
                    crate::openclaw_config::OpenClawModelCatalogEntry {
                        alias: Some("Native".to_string()),
                        extra: HashMap::new(),
                    },
                ),
            ])),
            extra: HashMap::new(),
        };

        assert!(clear_managed_openclaw_defaults(&mut defaults));
        let model = defaults.model.expect("remaining native model");
        assert_eq!(model.primary, "native/model-c");
        assert!(model.fallbacks.is_empty());
        let catalog = defaults.models.expect("remaining native catalog");
        assert_eq!(catalog.len(), 1);
        assert!(catalog.contains_key("native/model-c"));
    }

    #[test]
    fn hermes_cleanup_only_clears_the_managed_selection() {
        let mut managed = crate::hermes_config::HermesModelConfig {
            default: Some("model-a".to_string()),
            provider: Some(MANAGED_PROVIDER_ID.to_string()),
            context_length: Some(131_072),
            ..Default::default()
        };
        assert!(clear_managed_hermes_model(&mut managed));
        assert_eq!(managed.default, None);
        assert_eq!(managed.provider, None);
        assert_eq!(managed.context_length, Some(131_072));

        let mut native = crate::hermes_config::HermesModelConfig {
            default: Some("model-b".to_string()),
            provider: Some("native".to_string()),
            ..Default::default()
        };
        assert!(!clear_managed_hermes_model(&mut native));
        assert_eq!(native.provider.as_deref(), Some("native"));
    }
}
