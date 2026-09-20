export interface TYPE_PROVIDER {
  id?: string;
  streaming?: boolean;
  responseContentPath?: string;
  isCustom?: boolean;
  /** Maximum combined input/output context supported by the selected model. */
  contextWindowTokens?: number;
  /** Tokens reserved for the model response when budgeting conversation history. */
  maxOutputTokens?: number;
  /** Opaque reference to an OS credential-store entry. Never contains the secret. */
  secretRef?: string;
  curl: string;
}

export interface ProviderSelection {
  provider: string;
  variables: Record<string, string>;
  /** Opaque reference to an OS credential-store entry. Never contains the secret. */
  secretRef?: string;
}
