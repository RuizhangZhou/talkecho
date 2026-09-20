import { Channel, invoke } from "@tauri-apps/api/core";

export type ProviderRequestBody =
  | { kind: "text"; content: string }
  | { kind: "binary"; base64: string; mimeType: string }
  | {
      kind: "multipart";
      fields: Record<string, string>;
      fileField: string;
      fileName: string;
      mimeType: string;
      fileBase64: string;
    };

export interface ProviderHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: ProviderRequestBody;
  secretRef?: string;
  timeoutMs?: number;
}

export interface ProviderHttpResponse {
  status: number;
  statusText: string;
  body: string;
  retryAfter?: string;
}

export const sendProviderRequest = (request: ProviderHttpRequest) =>
  invoke<ProviderHttpResponse>("provider_http_request", { request });

export const streamProviderRequest = (
  request: ProviderHttpRequest,
  onChunk: (chunk: string) => void
) => {
  const channel = new Channel<string>();
  channel.onmessage = onChunk;
  return invoke<ProviderHttpResponse>("provider_stream_request", {
    request,
    onChunk: channel,
  });
};
