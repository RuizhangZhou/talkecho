use crate::secrets;
use base64::{engine::general_purpose, Engine as _};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, RETRY_AFTER};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use tauri::ipc::Channel;

const API_KEY_PLACEHOLDER: &str = "{{API_KEY}}";

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderRequestBody {
    Text {
        content: String,
    },
    Binary {
        base64: String,
        mime_type: String,
    },
    Multipart {
        fields: HashMap<String, String>,
        file_field: String,
        file_name: String,
        mime_type: String,
        file_base64: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHttpRequest {
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<ProviderRequestBody>,
    secret_ref: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHttpResponse {
    status: u16,
    status_text: String,
    body: String,
    retry_after: Option<String>,
}

fn is_credential_header(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized == "authorization"
        || normalized == "proxy-authorization"
        || normalized.contains("api-key")
        || normalized.contains("apikey")
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.ends_with("-key")
}

fn validate_unresolved_request(request: &ProviderHttpRequest) -> Result<(), String> {
    let parsed_url =
        reqwest::Url::parse(&request.url).map_err(|_| "Provider URL is invalid".to_string())?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("Provider URL must use HTTP or HTTPS".to_string());
    }
    if !parsed_url.username().is_empty() || parsed_url.password().is_some() {
        return Err("Provider URL must not contain embedded credentials".to_string());
    }
    for (key, value) in parsed_url.query_pairs() {
        if is_credential_name(&key) && !value.contains(API_KEY_PLACEHOLDER) {
            return Err(
                "Credential query parameters must use {{API_KEY}} instead of a plaintext value"
                    .to_string(),
            );
        }
    }
    for (name, value) in &request.headers {
        if is_credential_header(name) && !value.contains(API_KEY_PLACEHOLDER) {
            return Err(
                "Credential headers must use {{API_KEY}} instead of a plaintext value".to_string(),
            );
        }
    }
    if let Some(body) = &request.body {
        validate_body_credentials(body)?;
    }
    Ok(())
}

fn is_credential_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase().replace('-', "_");
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
            | "key"
    ) || normalized.ends_with("_api_key")
        || normalized.ends_with("_access_token")
        || normalized.ends_with("_auth_token")
        || normalized.ends_with("_password")
        || normalized.ends_with("_secret")
}

fn validate_json_credentials(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if is_credential_name(key) {
                    let safe = value
                        .as_str()
                        .is_some_and(|item| item.contains(API_KEY_PLACEHOLDER));
                    if !safe {
                        return Err(
                            "Credential request fields must use {{API_KEY}} instead of a plaintext value"
                                .to_string(),
                        );
                    }
                }
                validate_json_credentials(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_json_credentials(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_body_credentials(body: &ProviderRequestBody) -> Result<(), String> {
    match body {
        ProviderRequestBody::Text { content } => {
            if let Ok(value) = serde_json::from_str::<Value>(content) {
                validate_json_credentials(&value)?;
            }
        }
        ProviderRequestBody::Multipart { fields, .. } => {
            for (key, value) in fields {
                if is_credential_name(key) && !value.contains(API_KEY_PLACEHOLDER) {
                    return Err(
                        "Credential multipart fields must use {{API_KEY}} instead of a plaintext value"
                            .to_string(),
                    );
                }
            }
        }
        ProviderRequestBody::Binary { .. } => {}
    }
    Ok(())
}

fn body_contains_placeholder(body: &ProviderRequestBody) -> bool {
    match body {
        ProviderRequestBody::Text { content } => content.contains(API_KEY_PLACEHOLDER),
        ProviderRequestBody::Binary { .. } => false,
        ProviderRequestBody::Multipart { fields, .. } => fields
            .values()
            .any(|value| value.contains(API_KEY_PLACEHOLDER)),
    }
}

fn request_needs_secret(request: &ProviderHttpRequest) -> bool {
    request.url.contains(API_KEY_PLACEHOLDER)
        || request
            .headers
            .values()
            .any(|value| value.contains(API_KEY_PLACEHOLDER))
        || request.body.as_ref().is_some_and(body_contains_placeholder)
}

fn resolve(value: String, secret: Option<&str>) -> Result<String, String> {
    if !value.contains(API_KEY_PLACEHOLDER) {
        return Ok(value);
    }
    let secret = secret.ok_or_else(|| "The provider credential is not configured".to_string())?;
    Ok(value.replace(API_KEY_PLACEHOLDER, secret))
}

fn safe_request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "Provider request timed out".to_string()
    } else if error.is_connect() {
        "Could not connect to the provider".to_string()
    } else {
        "Provider request failed".to_string()
    }
}

async fn build_request(
    mut request: ProviderHttpRequest,
) -> Result<(reqwest::RequestBuilder, Option<String>), String> {
    validate_unresolved_request(&request)?;
    let secret = if request_needs_secret(&request) {
        let reference = request
            .secret_ref
            .take()
            .ok_or_else(|| "The provider credential is not configured".to_string())?;
        Some(secrets::resolve_secret_for_request(reference).await?)
    } else {
        None
    };
    let secret_value = secret.as_deref();

    let url = resolve(request.url, secret_value)?;
    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|_| "Provider HTTP method is invalid".to_string())?;
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "Provider request contains an invalid header name".to_string())?;
        let value = resolve(value, secret_value)?;
        let value = HeaderValue::from_str(&value)
            .map_err(|_| "Provider request contains an invalid header value".to_string())?;
        headers.insert(name, value);
    }

    let timeout = request.timeout_ms.unwrap_or(90_000).clamp(1_000, 300_000);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_millis(timeout))
        .build()
        .map_err(|_| "Failed to initialize the provider HTTP client".to_string())?;
    let mut builder = client.request(method, &url).headers(headers);

    if let Some(body) = request.body {
        builder = match body {
            ProviderRequestBody::Text { content } => builder.body(resolve(content, secret_value)?),
            ProviderRequestBody::Binary { base64, mime_type } => {
                let bytes = general_purpose::STANDARD
                    .decode(base64)
                    .map_err(|_| "Provider binary request body is invalid".to_string())?;
                builder.header("Content-Type", mime_type).body(bytes)
            }
            ProviderRequestBody::Multipart {
                fields,
                file_field,
                file_name,
                mime_type,
                file_base64,
            } => {
                let bytes = general_purpose::STANDARD
                    .decode(file_base64)
                    .map_err(|_| "Provider multipart file is invalid".to_string())?;
                let file = Part::bytes(bytes)
                    .file_name(file_name)
                    .mime_str(&mime_type)
                    .map_err(|_| "Provider multipart MIME type is invalid".to_string())?;
                let mut form = Form::new().part(file_field, file);
                for (name, value) in fields {
                    form = form.text(name, resolve(value, secret_value)?);
                }
                builder.multipart(form)
            }
        };
    }

    Ok((builder, secret))
}

fn redact(mut body: String, secret: Option<&str>) -> String {
    if let Some(secret) = secret {
        if !secret.is_empty() {
            body = body.replace(secret, "[REDACTED]");
        }
    }
    body
}

async fn response_metadata(
    response: reqwest::Response,
    secret: Option<&str>,
) -> Result<ProviderHttpResponse, String> {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response
        .text()
        .await
        .map_err(|_| "Failed to read the provider response".to_string())?;
    Ok(ProviderHttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        body: redact(body, secret),
        retry_after,
    })
}

#[tauri::command]
pub async fn provider_http_request(
    request: ProviderHttpRequest,
) -> Result<ProviderHttpResponse, String> {
    let (builder, secret) = build_request(request).await?;
    let response = builder
        .send()
        .await
        .map_err(|error| safe_request_error(&error))?;
    response_metadata(response, secret.as_deref()).await
}

#[tauri::command]
pub async fn provider_stream_request(
    request: ProviderHttpRequest,
    on_chunk: Channel<String>,
) -> Result<ProviderHttpResponse, String> {
    let (builder, secret) = build_request(request).await?;
    let mut response = builder
        .send()
        .await
        .map_err(|error| safe_request_error(&error))?;
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if !status.is_success() {
        return response_metadata(response, secret.as_deref()).await;
    }

    // Hold each response line in Rust until it is complete. Besides preserving
    // UTF-8 across network chunk boundaries, this lets us redact a provider
    // response that unexpectedly echoes the credential before anything is sent
    // to the WebView.
    let mut pending = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Failed to read the provider response stream".to_string())?
    {
        pending.extend_from_slice(&chunk);
        while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=newline).collect();
            let line = redact(
                String::from_utf8_lossy(&line).into_owned(),
                secret.as_deref(),
            );
            on_chunk
                .send(line)
                .map_err(|_| "Provider response channel closed".to_string())?;
        }
    }
    if !pending.is_empty() {
        let tail = redact(
            String::from_utf8_lossy(&pending).into_owned(),
            secret.as_deref(),
        );
        on_chunk
            .send(tail)
            .map_err(|_| "Provider response channel closed".to_string())?;
    }

    Ok(ProviderHttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        body: String::new(),
        retry_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_plaintext_authorization_headers() {
        let request = ProviderHttpRequest {
            method: "POST".to_string(),
            url: "https://example.test".to_string(),
            headers: HashMap::from([("Authorization".to_string(), "Bearer plaintext".to_string())]),
            body: None,
            secret_ref: None,
            timeout_ms: None,
        };
        assert!(validate_unresolved_request(&request).is_err());
    }

    #[test]
    fn accepts_placeholder_authorization_headers() {
        let request = ProviderHttpRequest {
            method: "POST".to_string(),
            url: "https://example.test?api_key={{API_KEY}}".to_string(),
            headers: HashMap::from([(
                "Authorization".to_string(),
                "Bearer {{API_KEY}}".to_string(),
            )]),
            body: None,
            secret_ref: Some("provider:ai:test".to_string()),
            timeout_ms: None,
        };
        assert!(validate_unresolved_request(&request).is_ok());
        assert!(request_needs_secret(&request));
    }

    #[test]
    fn rejects_plaintext_credentials_in_query_and_json_body() {
        let query_request = ProviderHttpRequest {
            method: "POST".to_string(),
            url: "https://example.test?api_key=plaintext".to_string(),
            headers: HashMap::new(),
            body: None,
            secret_ref: None,
            timeout_ms: None,
        };
        assert!(validate_unresolved_request(&query_request).is_err());

        let body_request = ProviderHttpRequest {
            method: "POST".to_string(),
            url: "https://example.test".to_string(),
            headers: HashMap::new(),
            body: Some(ProviderRequestBody::Text {
                content: r#"{"api_key":"plaintext"}"#.to_string(),
            }),
            secret_ref: None,
            timeout_ms: None,
        };
        assert!(validate_unresolved_request(&body_request).is_err());
    }
}
