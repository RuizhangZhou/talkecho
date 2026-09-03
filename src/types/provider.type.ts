export interface TYPE_PROVIDER {
  id?: string;
  streaming?: boolean;
  responseContentPath?: string;
  isCustom?: boolean;
  /** Maximum combined input/output context supported by the selected model. */
  contextWindowTokens?: number;
  /** Tokens reserved for the model response when budgeting conversation history. */
  maxOutputTokens?: number;
  curl: string;
}
