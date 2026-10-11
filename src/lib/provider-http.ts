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

async function invokeProvider(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ProviderHttpResponse> {
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  if (!signal) return invoke<ProviderHttpResponse>(command, args);
  // Register before installing the abort listener or issuing HTTP: cancellation
  // cannot race ahead of native registration and silently disappear.
  const requestId = await invoke<string>("prepare_provider_request");
  const cancel = () => {
    void invoke("cancel_provider_request", { requestId }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    const result = await invoke<ProviderHttpResponse>(command, {
      ...args,
      requestId,
    });
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    await invoke("finish_provider_request", { requestId }).catch(() => {});
  }
}

export const sendProviderRequest = (
  request: ProviderHttpRequest,
  signal?: AbortSignal,
) => invokeProvider("provider_http_request", { request }, signal);

export const streamProviderRequest = (
  request: ProviderHttpRequest,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
) => {
  const channel = new Channel<string>();
  channel.onmessage = (chunk) => {
    if (!signal?.aborted) onChunk(chunk);
  };
  return invokeProvider(
    "provider_stream_request",
    {
      request,
      onChunk: channel,
    },
    signal,
  );
};
