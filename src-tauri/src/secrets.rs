use keyring::{Entry, Error as KeyringError};
use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const SERVICE: &str = "com.talkecho.desktop.provider-secrets";
const API_KEY_PLACEHOLDER: &str = "{{API_KEY}}";

static INLINE_SECRET_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r#"(?i)(authorization\s*:\s*(?:bearer|token|basic)\s+)([^\s\"'\\]+)"#)
            .expect("authorization regex is valid"),
        Regex::new(r#"(?i)((?:x-api-key|api-key|apikey)\s*:\s*)([^\s\"'\\]+)"#)
            .expect("API key header regex is valid"),
        Regex::new(
            r#"(?i)((?:[a-z0-9-]*(?:key|token|secret|password)[a-z0-9-]*)\s*:\s*)([^\s\"'\\]+)"#,
        )
        .expect("credential header regex is valid"),
        Regex::new(r#"(?i)([?&](?:api_key|apikey|access_token|token|key)=)([^\s&\"'\\]+)"#)
            .expect("API key query regex is valid"),
        Regex::new(
            r#"(?i)([\"']?(?:api_key|apikey|access_token|auth_token|token|secret|password)[\"']?\s*[:=]\s*[\"']?)([^\s,\"'}\\]+)"#,
        )
        .expect("credential body regex is valid"),
    ]
});

const CUSTOM_AI_PROVIDERS: &str = "curl_custom_ai_providers";
const CUSTOM_STT_PROVIDERS: &str = "curl_custom_speech_providers";
const SELECTED_AI_PROVIDER: &str = "curl_selected_ai_provider";
const SELECTED_STT_PROVIDER: &str = "curl_selected_stt_provider";
const SELECTED_DICTATION_STT_PROVIDER: &str = "curl_selected_dictation_stt_provider";
const AI_VARIABLES_BY_ID: &str = "curl_ai_provider_variables_by_id";
const STT_VARIABLES_BY_ID: &str = "curl_stt_provider_variables_by_id";

trait SecretStore {
    fn set(&self, reference: &str, value: &str) -> Result<(), String>;
    fn get(&self, reference: &str) -> Result<Option<String>, String>;
    fn delete(&self, reference: &str) -> Result<(), String>;
}

struct KeyringStore;

impl KeyringStore {
    fn entry(reference: &str) -> Result<Entry, String> {
        validate_reference(reference)?;
        Entry::new(SERVICE, reference)
            .map_err(|_| "The operating-system credential store is unavailable".to_string())
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, reference: &str, value: &str) -> Result<(), String> {
        Self::entry(reference)?
            .set_password(value)
            .map_err(|_| "Failed to save the credential in the operating-system store".to_string())
    }

    fn get(&self, reference: &str) -> Result<Option<String>, String> {
        match Self::entry(reference)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err("Failed to access the operating-system credential store".to_string()),
        }
    }

    fn delete(&self, reference: &str) -> Result<(), String> {
        match Self::entry(reference)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => {
                Err("Failed to delete the credential from the operating-system store".to_string())
            }
        }
    }
}

fn validate_reference(reference: &str) -> Result<(), String> {
    if reference.is_empty()
        || reference.len() > 255
        || !reference
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '.' | '_' | '-'))
    {
        return Err("Invalid credential reference".to_string());
    }
    Ok(())
}

fn provider_reference(kind: &str, provider_id: &str) -> Result<String, String> {
    if provider_id.trim().is_empty() {
        return Err("Provider ID is missing".to_string());
    }
    let normalized: String = provider_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let reference = format!("provider:{kind}:{normalized}");
    validate_reference(&reference)?;
    Ok(reference)
}

fn is_secret_variable(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    matches!(
        normalized.as_str(),
        "api_key"
            | "apikey"
            | "access_token"
            | "auth_token"
            | "authorization"
            | "password"
            | "secret"
            | "token"
    ) || normalized.ends_with("_api_key")
        || normalized.ends_with("_access_token")
        || normalized.ends_with("_auth_token")
        || normalized.ends_with("_password")
        || normalized.ends_with("_secret")
}

fn looks_like_placeholder(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || (trimmed.starts_with("{{") && trimmed.ends_with("}}"))
        || trimmed.starts_with('$')
        || trimmed.eq_ignore_ascii_case("YOUR_API_KEY")
        || trimmed.eq_ignore_ascii_case("API_KEY")
}

fn rewrite_inline_credentials(curl: &str) -> Result<(String, Option<String>), String> {
    let mut candidates = HashSet::new();
    for pattern in INLINE_SECRET_PATTERNS.iter() {
        for captures in pattern.captures_iter(curl) {
            if let Some(value) = captures.get(2).map(|item| item.as_str()) {
                if !looks_like_placeholder(value) {
                    candidates.insert(value.to_string());
                }
            }
        }
    }

    if candidates.len() > 1 {
        return Err(
            "A provider template contains multiple different credentials; remove them and use {{API_KEY}}"
                .to_string(),
        );
    }
    let Some(secret) = candidates.into_iter().next() else {
        return Ok((curl.to_string(), None));
    };

    let mut rewritten = curl.to_string();
    for pattern in INLINE_SECRET_PATTERNS.iter() {
        rewritten = pattern
            .replace_all(&rewritten, |captures: &Captures<'_>| {
                if captures.get(2).map(|item| item.as_str()) == Some(secret.as_str()) {
                    format!("{}{}", &captures[1], API_KEY_PLACEHOLDER)
                } else {
                    captures[0].to_string()
                }
            })
            .into_owned();
    }
    Ok((rewritten, Some(secret)))
}

fn migrate_custom_providers(
    raw: &str,
    kind: &str,
    store: &dyn SecretStore,
) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|_| "Legacy custom provider data is not valid JSON".to_string())?;
    let providers = value
        .as_array_mut()
        .ok_or_else(|| "Legacy custom provider data is not an array".to_string())?;

    for provider in providers {
        let object = provider
            .as_object_mut()
            .ok_or_else(|| "Legacy custom provider entry is invalid".to_string())?;
        let provider_id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Legacy custom provider ID is missing".to_string())?;
        let reference = provider_reference(kind, provider_id)?;
        let curl = object
            .get("curl")
            .and_then(Value::as_str)
            .ok_or_else(|| "Legacy custom provider cURL is missing".to_string())?;
        let (rewritten, extracted) = rewrite_inline_credentials(curl)?;
        if let Some(secret) = extracted {
            store.set(&reference, &secret)?;
            object.insert("curl".to_string(), Value::String(rewritten));
        }
        if object
            .get("curl")
            .and_then(Value::as_str)
            .is_some_and(|template| template.contains(API_KEY_PLACEHOLDER))
            && store.get(&reference)?.is_some()
        {
            object.insert("secretRef".to_string(), Value::String(reference));
        }
    }
    serde_json::to_string(&value).map_err(|_| "Failed to serialize migrated providers".to_string())
}

fn take_secret_variables(object: &mut serde_json::Map<String, Value>) -> Vec<String> {
    let secret_keys: Vec<String> = object
        .iter()
        .filter(|(key, value)| {
            is_secret_variable(key)
                && value
                    .as_str()
                    .is_some_and(|item| !looks_like_placeholder(item))
        })
        .map(|(key, _)| key.clone())
        .collect();
    secret_keys
        .into_iter()
        .filter_map(|key| {
            object
                .remove(&key)
                .and_then(|value| value.as_str().map(str::to_string))
        })
        .collect()
}

fn store_single_secret(
    store: &dyn SecretStore,
    reference: &str,
    values: Vec<String>,
) -> Result<(), String> {
    let distinct: HashSet<String> = values.into_iter().collect();
    if distinct.len() > 1 {
        return Err("A provider has multiple different credential values".to_string());
    }
    if let Some(secret) = distinct.into_iter().next() {
        store.set(reference, &secret)?;
    }
    Ok(())
}

fn migrate_selected_provider(
    raw: &str,
    kind: &str,
    store: &dyn SecretStore,
) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|_| "Legacy selected provider data is not valid JSON".to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Legacy selected provider data is invalid".to_string())?;
    let provider_id = object
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| "Legacy selected provider ID is missing".to_string())?;
    let reference = provider_reference(kind, provider_id)?;
    let secrets = object
        .get_mut("variables")
        .and_then(Value::as_object_mut)
        .map(take_secret_variables)
        .unwrap_or_default();
    store_single_secret(store, &reference, secrets)?;
    if store.get(&reference)?.is_some() {
        object.insert("secretRef".to_string(), Value::String(reference));
    }
    serde_json::to_string(&value)
        .map_err(|_| "Failed to serialize migrated provider selection".to_string())
}

fn migrate_variable_map(raw: &str, kind: &str, store: &dyn SecretStore) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw)
        .map_err(|_| "Legacy provider variable data is not valid JSON".to_string())?;
    let providers = value
        .as_object_mut()
        .ok_or_else(|| "Legacy provider variable data is invalid".to_string())?;
    for (provider_id, variables) in providers {
        let Some(variables) = variables.as_object_mut() else {
            continue;
        };
        let reference = provider_reference(kind, provider_id)?;
        store_single_secret(store, &reference, take_secret_variables(variables))?;
    }
    serde_json::to_string(&value)
        .map_err(|_| "Failed to serialize migrated provider variables".to_string())
}

fn migrate_values(
    values: HashMap<String, String>,
    store: &dyn SecretStore,
) -> Result<HashMap<String, String>, String> {
    let mut migrated = HashMap::new();
    // Process variable maps and selected providers before templates so every
    // representation can attach the same stable reference regardless of the
    // input HashMap's iteration order.
    for key in [
        AI_VARIABLES_BY_ID,
        STT_VARIABLES_BY_ID,
        SELECTED_AI_PROVIDER,
        SELECTED_STT_PROVIDER,
        SELECTED_DICTATION_STT_PROVIDER,
        CUSTOM_AI_PROVIDERS,
        CUSTOM_STT_PROVIDERS,
    ] {
        let Some(raw) = values.get(key) else {
            continue;
        };
        let value = match key {
            CUSTOM_AI_PROVIDERS => migrate_custom_providers(raw, "ai", store)?,
            CUSTOM_STT_PROVIDERS => migrate_custom_providers(raw, "stt", store)?,
            SELECTED_AI_PROVIDER => migrate_selected_provider(raw, "ai", store)?,
            SELECTED_STT_PROVIDER | SELECTED_DICTATION_STT_PROVIDER => {
                migrate_selected_provider(raw, "stt", store)?
            }
            AI_VARIABLES_BY_ID => migrate_variable_map(raw, "ai", store)?,
            STT_VARIABLES_BY_ID => migrate_variable_map(raw, "stt", store)?,
            _ => continue,
        };
        migrated.insert(key.to_string(), value);
    }
    Ok(migrated)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMigrationInput {
    values: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMigrationOutput {
    values: HashMap<String, String>,
}

#[tauri::command]
pub async fn set_secret(secret_ref: String, value: String) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("Credential value cannot be empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || KeyringStore.set(&secret_ref, &value))
        .await
        .map_err(|_| "Credential operation failed".to_string())?
}

#[tauri::command]
pub async fn delete_secret(secret_ref: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || KeyringStore.delete(&secret_ref))
        .await
        .map_err(|_| "Credential operation failed".to_string())?
}

#[tauri::command]
pub async fn has_secret(secret_ref: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        KeyringStore.get(&secret_ref).map(|value| value.is_some())
    })
    .await
    .map_err(|_| "Credential operation failed".to_string())?
}

#[tauri::command]
pub async fn migrate_provider_secrets(
    input: SecretMigrationInput,
) -> Result<SecretMigrationOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        migrate_values(input.values, &KeyringStore).map(|values| SecretMigrationOutput { values })
    })
    .await
    .map_err(|_| "Credential migration failed".to_string())?
}

pub(crate) async fn resolve_secret_for_request(secret_ref: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        KeyringStore
            .get(&secret_ref)?
            .ok_or_else(|| "The provider credential is not configured".to_string())
    })
    .await
    .map_err(|_| "Credential operation failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn set(&self, reference: &str, value: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(reference.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, reference: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(reference).cloned())
        }

        fn delete(&self, reference: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(reference);
            Ok(())
        }
    }

    #[test]
    fn migrates_inline_and_variable_credentials_without_leaving_plaintext() {
        let store = MemoryStore::default();
        let mut values = HashMap::new();
        values.insert(
            CUSTOM_AI_PROVIDERS.to_string(),
            r#"[{"curl":"curl https://example.test/chat -H \"Authorization: Bearer inline-secret\" -d '{}'","id":"custom-one","isCustom":true},{"curl":"curl https://example.test/body -d '{\"api_key\":\"body-secret\"}'","id":"custom-body","isCustom":true}]"#.to_string(),
        );
        values.insert(
            SELECTED_STT_PROVIDER.to_string(),
            r#"{"provider":"groq","variables":{"api_key":"selected-secret","model":"whisper"}}"#
                .to_string(),
        );
        values.insert(
            STT_VARIABLES_BY_ID.to_string(),
            r#"{"groq":{"api_key":"selected-secret","model":"whisper"}}"#.to_string(),
        );

        let migrated = migrate_values(values, &store).unwrap();
        let serialized = serde_json::to_string(&migrated).unwrap();
        assert!(!serialized.contains("inline-secret"));
        assert!(!serialized.contains("selected-secret"));
        assert!(!serialized.contains("body-secret"));
        assert!(serialized.contains(API_KEY_PLACEHOLDER));
        assert!(serialized.contains("secretRef"));
        assert_eq!(
            store.get("provider:ai:custom-one").unwrap().as_deref(),
            Some("inline-secret")
        );
        assert_eq!(
            store.get("provider:stt:groq").unwrap().as_deref(),
            Some("selected-secret")
        );
        assert_eq!(
            store.get("provider:ai:custom-body").unwrap().as_deref(),
            Some("body-secret")
        );
    }

    #[test]
    fn migration_is_idempotent_and_reentrant() {
        let store = MemoryStore::default();
        let mut values = HashMap::new();
        values.insert(
            SELECTED_AI_PROVIDER.to_string(),
            r#"{"provider":"openai","variables":{"api_key":"once-only","model":"gpt-4o"}}"#
                .to_string(),
        );
        values.insert(
            CUSTOM_AI_PROVIDERS.to_string(),
            r#"[{"curl":"curl https://example.test -H \"Authorization: Bearer once-only\"","id":"openai","isCustom":true}]"#.to_string(),
        );

        let first = migrate_values(values, &store).unwrap();
        let second = migrate_values(first.clone(), &store).unwrap();
        assert_eq!(first, second);
        assert!(!serde_json::to_string(&second).unwrap().contains("once-only"));
        assert!(second[CUSTOM_AI_PROVIDERS].contains(API_KEY_PLACEHOLDER));
        assert_eq!(store.0.lock().unwrap().len(), 1);
        assert_eq!(
            store.get("provider:ai:openai").unwrap().as_deref(),
            Some("once-only")
        );
    }
}
