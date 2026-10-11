import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  Channel: class<T> {
    onmessage: (value: T) => void = () => {};
  },
}));
vi.mock("./talkecho.api", () => ({ shouldUseTalkEchoAPI: async () => false }));
vi.mock("./common.function", async () => ({
  ...(await vi.importActual("./common.function")),
  blobToBase64: async (blob: Blob) =>
    Buffer.from(await blob.arrayBuffer()).toString("base64"),
}));
vi.mock("@/config", () => ({ MARKDOWN_FORMATTING_INSTRUCTIONS: "" }));
vi.mock("@/lib", async () => ({
  ...(await vi.importActual("../provider-http")),
  getResponseSettings: () => ({}),
  RESPONSE_LENGTHS: [],
  LANGUAGES: [],
  isSecretVariableKey: (key: string) => key === "api_key",
}));

import { fetchAIResponse } from "./ai-response.function";
import { sendProviderRequest } from "../provider-http";
import { meetingFailureLabel } from "../meeting-diagnostics";
import { fetchSTT } from "./stt.function";
import { floatArrayToWav } from "../utils";

let server: Server;
let url: string;
let calls: number;
let maxActive: number;
let uploadedWavBytes: number;
let mode: "stall-once" | "stall" | "429" | "503" | "context";
const nativeRequests = new Map<string, AbortController>();

beforeEach(async () => {
  calls = maxActive = uploadedWavBytes = 0;
  let serverActive = 0;
  server = createServer((request, response) => {
    const call = ++calls;
    maxActive = Math.max(maxActive, ++serverActive);
    response.on("close", () => --serverActive);
    if (request.url === "/stt") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const audio = Buffer.from(JSON.parse(body).audio, "base64");
        if (audio.subarray(0, 4).toString() === "RIFF")
          uploadedWavBytes = audio.length;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ text: "Synthetic meeting speech." }));
      });
      return;
    }
    request.resume();
    if (mode === "stall" || (mode === "stall-once" && call === 1)) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
    } else if (mode === "context") {
      response.writeHead(400);
      response.end("maximum context length exceeded");
    } else if ((mode === "429" || mode === "503") && call === 1) {
      response.writeHead(Number(mode), { "Retry-After": "0.05" });
      response.end("temporary provider failure");
    } else {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"模拟译文"}}]}\n\ndata: [DONE]\n\n',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/translate`;
  // Exercise the real frontend HTTP adapter against a loopback HTTP provider.
  // This bridge models native command semantics; Rust tests verify native socket cancellation separately.
  bridge.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "prepare_provider_request") {
      const id = crypto.randomUUID();
      nativeRequests.set(id, new AbortController());
      return id;
    }
    if (command === "cancel_provider_request") {
      nativeRequests.get(args.requestId)?.abort();
      return;
    }
    if (command === "finish_provider_request") {
      nativeRequests.delete(args.requestId);
      return;
    }
    if (command === "get_meeting_diagnostics_path") return "meeting.log";
    const response = await fetch(args.request.url, {
      method: args.request.method,
      headers: args.request.headers,
      body: args.request.body?.content,
      signal: nativeRequests.get(args.requestId)?.signal,
    });
    let body = "";
    if (command === "provider_stream_request" && response.ok) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        args.onChunk.onmessage(decoder.decode(chunk.value, { stream: true }));
      }
    } else body = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      body,
      retryAfter: response.headers.get("retry-after"),
    };
  });
});

afterEach(async () => {
  for (const controller of nativeRequests.values()) controller.abort();
  nativeRequests.clear();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function translate(
  maxRetries = 1,
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  for await (const chunk of fetchAIResponse({
    provider: {
      id: "loopback",
      streaming: true,
      responseContentPath: "choices[0].message.content",
      curl: `curl '${url}' -H 'Content-Type: application/json' -d '{"model":"synthetic","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":"{{TEXT}}"}],"stream":true}'`,
    },
    selectedProvider: { provider: "loopback", variables: {} },
    systemPrompt: "Translate only the current utterance.",
    userMessage: "Synthetic meeting sentence.",
    inactivityTimeoutMs: 100,
    timeoutMs: 2_000,
    maxRetries,
    signal,
  }))
    text += chunk;
  return text;
}

describe("meeting provider boundary", () => {
  it("uploads generated WAV audio through the production STT request path", async () => {
    const pcm = Float32Array.from(
      { length: 16_000 },
      (_, index) => Math.sin(index * 0.1) * 0.1,
    );
    const audio = floatArrayToWav(pcm, 16_000);
    const endpoint = url.replace("/translate", "/stt");
    const text = await fetchSTT({
      provider: {
        id: "loopback",
        responseContentPath: "text",
        curl: `curl '${endpoint}' -H 'Content-Type: application/json' -d '{"audio":"{{AUDIO}}","model":"synthetic"}'`,
      },
      selectedProvider: { provider: "loopback", variables: {} },
      audio,
      language: "auto",
      timeoutMs: 2_000,
      maxRetries: 0,
    });
    expect(text).toBe("Synthetic meeting speech.");
    expect(uploadedWavBytes).toBe(32_044);
    expect(nativeRequests.size).toBe(0);
  });

  it("reports a stalled STT request as a transcription timeout", async () => {
    mode = "stall";
    const audio = floatArrayToWav(new Float32Array(16_000), 16_000);
    const failure = await fetchSTT({
      provider: {
        id: "loopback",
        responseContentPath: "text",
        curl: `curl '${url}' -H 'Content-Type: application/json' -d '{"audio":"{{AUDIO}}"}'`,
      },
      selectedProvider: { provider: "loopback", variables: {} },
      audio,
      timeoutMs: 100,
      maxRetries: 0,
    }).catch((error) => error);
    expect(failure.kind).toBe("timeout");
    expect(meetingFailureLabel("stt", failure)).toContain(
      "Transcription: timeout",
    );
  });

  it("cancels a stalled stream before retrying; requests do not overlap", async () => {
    mode = "stall-once";
    expect(await translate()).toBe("模拟译文");
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(nativeRequests.size).toBe(0);
  });

  it.each(["429", "503"] as const)("recovers from HTTP %s", async (status) => {
    mode = status;
    expect(await translate()).toBe("模拟译文");
    expect(calls).toBe(2);
  });

  it("reports a stream stall as the red translation timeout with transcript retention", async () => {
    mode = "stall";
    const failure = await translate(0).catch((error) => error);
    expect(failure.kind).toBe("timeout");
    expect(meetingFailureLabel("translation", failure)).toContain(
      "Translation: timeout",
    );
    expect(meetingFailureLabel("translation", failure)).toContain(
      "Transcript retained",
    );
    expect(calls).toBe(1);
  });

  it("does not retry a context-window rejection", async () => {
    mode = "context";
    await expect(translate()).rejects.toMatchObject({ kind: "context_limit" });
    expect(calls).toBe(1);
  });

  it("propagates cancellation of a stalled non-streaming request", async () => {
    mode = "stall";
    const controller = new AbortController();
    const work = sendProviderRequest(
      { method: "POST", url, headers: {} },
      controller.signal,
    );
    const outcome = work.catch((error) => error);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    controller.abort();
    expect((await outcome).name).toBe("AbortError");
    expect(nativeRequests.size).toBe(0);
  });

  it("does not issue HTTP when aborted while native registration is pending", async () => {
    mode = "stall";
    const normal = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation(async (command: string, args: any) => {
      if (command === "prepare_provider_request")
        await new Promise((resolve) => setTimeout(resolve, 20));
      return normal(command, args);
    });
    const controller = new AbortController();
    const outcome = sendProviderRequest(
      { method: "POST", url, headers: {} },
      controller.signal,
    ).catch((error) => error);
    controller.abort();
    expect((await outcome).name).toBe("AbortError");
    expect(calls).toBe(0);
    expect(nativeRequests.size).toBe(0);
  });
});
