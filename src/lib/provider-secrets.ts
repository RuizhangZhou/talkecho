import { STORAGE_KEYS } from "@/config";
import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "./storage/helper";

export type ProviderKind = "ai" | "stt";

const MIGRATED_STORAGE_KEYS = [
  STORAGE_KEYS.CUSTOM_AI_PROVIDERS,
  STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS,
  STORAGE_KEYS.SELECTED_AI_PROVIDER,
  STORAGE_KEYS.SELECTED_STT_PROVIDER,
  STORAGE_KEYS.SELECTED_DICTATION_STT_PROVIDER,
  STORAGE_KEYS.AI_PROVIDER_VARIABLES_BY_ID,
  STORAGE_KEYS.STT_PROVIDER_VARIABLES_BY_ID,
] as const;

export const providerSecretRef = (
  kind: ProviderKind,
  providerId: string
): string => {
  const normalized = [...providerId]
    .map((character) =>
      /[A-Za-z0-9._-]/.test(character) ? character : "_"
    )
    .join("");
  return `provider:${kind}:${normalized}`;
};

export const isSecretVariableKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return (
    [
      "api_key",
      "apikey",
      "access_token",
      "auth_token",
      "authorization",
      "password",
      "secret",
      "token",
    ].includes(normalized) ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_access_token") ||
    normalized.endsWith("_auth_token") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_secret")
  );
};

export const stripSecretVariables = (
  variables: Record<string, string> | undefined
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables || {}).filter(
      ([key]) => !isSecretVariableKey(key)
    )
  );

export const validateProviderCredentialTemplate = (
  curl: string
): string | null => {
  const credentialHeader =
    /(?:authorization|proxy-authorization|[a-z0-9-]*(?:key|token|secret|password)[a-z0-9-]*)\s*:\s*([^"'\\\r\n]+)/gi;
  for (const match of curl.matchAll(credentialHeader)) {
    if (!match[1]?.includes("{{API_KEY}}")) {
      return "Credential headers must use {{API_KEY}}. Enter the real key in the separate API Key field after saving the provider.";
    }
  }

  const credentialQuery =
    /[?&](?:api_key|apikey|access_token|token|key)=([^&\s"'\\]+)/gi;
  for (const match of curl.matchAll(credentialQuery)) {
    if (!match[1]?.includes("{{API_KEY}}")) {
      return "Credential query parameters must use {{API_KEY}}. Enter the real key in the separate API Key field after saving the provider.";
    }
  }
  const credentialBody =
    /["']?(?:api_key|apikey|access_token|auth_token|token|secret|password)["']?\s*[:=]\s*["']?([^\s,"'}\\]+)/gi;
  for (const match of curl.matchAll(credentialBody)) {
    if (!match[1]?.includes("{{API_KEY}}")) {
      return "Credential fields must use {{API_KEY}}. Enter the real key in the separate API Key field after saving the provider.";
    }
  }
  return null;
};

export const setProviderSecret = (secretRef: string, value: string) =>
  invoke<void>("set_secret", { secretRef, value });

export const deleteProviderSecret = (secretRef: string) =>
  invoke<void>("delete_secret", { secretRef });

export const hasProviderSecret = (secretRef: string) =>
  invoke<boolean>("has_secret", { secretRef });

export const migrateLegacyProviderSecrets = async (): Promise<void> => {
  const values: Record<string, string> = {};
  for (const key of MIGRATED_STORAGE_KEYS) {
    const value = safeLocalStorage.getItem(key);
    if (value !== null) values[key] = value;
  }
  if (Object.keys(values).length === 0) return;

  const result = await invoke<{ values: Record<string, string> }>(
    "migrate_provider_secrets",
    { input: { values } }
  );
  for (const [key, value] of Object.entries(result.values)) {
    safeLocalStorage.setItem(key, value);
  }
};
