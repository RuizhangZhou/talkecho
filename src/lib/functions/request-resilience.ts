export type RequestFailureKind =
  | "cancelled"
  | "timeout"
  | "network"
  | "rate_limit"
  | "provider"
  | "authentication"
  | "context_limit"
  | "invalid_request"
  | "malformed_response"
  | "queue_full"
  | "unknown";

export class RequestFailure extends Error {
  readonly kind: RequestFailureKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      kind: RequestFailureKind;
      status?: number;
      retryable?: boolean;
      details?: string;
      retryAfterMs?: number;
      cause?: unknown;
    }
  ) {
    super(message);
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    this.name = "RequestFailure";
    this.kind = options.kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const CONTEXT_LIMIT_PATTERN =
  /(context[_ -]?(window|length)|maximum context|too many tokens|token limit|prompt is too long|input.*too long)/i;
const RATE_LIMIT_PATTERN = /(rate.?limit|too many requests|quota exceeded)/i;
const TRANSIENT_PATTERN =
  /(timed? ?out|timeout|connection (reset|closed|refused)|network|temporarily unavailable|socket|econn|fetch failed)/i;

export function classifyHttpFailure(
  status: number,
  statusText: string,
  body = "",
  retryAfterHeader?: string | null
): RequestFailure {
  const details = body.trim();
  const combined = `${statusText} ${details}`.trim();

  if (CONTEXT_LIMIT_PATTERN.test(combined)) {
    return new RequestFailure(
      "The request exceeded the model context window. Reduce or summarize the conversation history.",
      { kind: "context_limit", status, details }
    );
  }
  if (status === 401 || status === 403) {
    return new RequestFailure(
      `Provider authentication failed (${status}). Check the API key and permissions.`,
      { kind: "authentication", status, details }
    );
  }
  if (status === 408) {
    return new RequestFailure("The provider timed out before responding.", {
      kind: "timeout",
      status,
      retryable: true,
      details,
    });
  }
  if (status === 429 || RATE_LIMIT_PATTERN.test(combined)) {
    const retryAfterSeconds = Number(retryAfterHeader);
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds * 1000)
      : undefined;
    return new RequestFailure(
      "The provider rate limit was reached. TalkEcho will retry briefly.",
      {
        kind: "rate_limit",
        status,
        retryable: true,
        details,
        retryAfterMs,
      }
    );
  }
  if (status >= 500) {
    return new RequestFailure(
      `The provider is temporarily unavailable (${status}).`,
      { kind: "provider", status, retryable: true, details }
    );
  }
  if (status >= 400) {
    return new RequestFailure(
      `The provider rejected the request (${status}${statusText ? ` ${statusText}` : ""}).`,
      { kind: "invalid_request", status, details }
    );
  }
  return new RequestFailure("The provider request failed.", {
    kind: "provider",
    status,
    details,
  });
}

export function normalizeRequestFailure(
  error: unknown,
  options: { timedOut?: boolean; cancelled?: boolean } = {}
): RequestFailure {
  if (error instanceof RequestFailure) return error;

  if (options.timedOut) {
    return new RequestFailure("The request timed out.", {
      kind: "timeout",
      retryable: true,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const isAbort =
    options.cancelled ||
    (error instanceof Error && error.name === "AbortError") ||
    /aborted|cancelled/i.test(message);
  if (isAbort) {
    return new RequestFailure("The request was cancelled.", {
      kind: "cancelled",
      cause: error,
    });
  }
  if (CONTEXT_LIMIT_PATTERN.test(message)) {
    return new RequestFailure(
      "The request exceeded the model context window. Reduce or summarize the conversation history.",
      { kind: "context_limit", cause: error, details: message }
    );
  }
  if (RATE_LIMIT_PATTERN.test(message)) {
    return new RequestFailure(
      "The provider rate limit was reached. TalkEcho will retry briefly.",
      { kind: "rate_limit", retryable: true, cause: error, details: message }
    );
  }
  if (TRANSIENT_PATTERN.test(message)) {
    return new RequestFailure(`Network request failed: ${message}`, {
      kind: "network",
      retryable: true,
      cause: error,
    });
  }
  return new RequestFailure(message || "Unknown request failure", {
    kind: "unknown",
    cause: error,
  });
}

export function formatRequestFailure(error: unknown): string {
  const failure = normalizeRequestFailure(error);
  if (failure.details && failure.kind === "invalid_request") {
    const conciseDetails = failure.details.replace(/\s+/g, " ").slice(0, 500);
    return `${failure.message} ${conciseDetails}`;
  }
  return failure.message;
}

interface LinkedAbortContext {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
}

export function createLinkedAbortContext(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): LinkedAbortContext {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function delayWithSignal(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new RequestFailure("The request was cancelled.", {
      kind: "cancelled",
    });
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new RequestFailure("The request was cancelled.", { kind: "cancelled" })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal) {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      setTimeout(cleanup, delayMs);
    }
  });
}

export async function runWithRetry<T>(
  operation: (context: { attempt: number; signal: AbortSignal }) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    maxRetries: number;
    baseDelayMs?: number;
    jitterMs?: number;
    onRetry?: (failure: RequestFailure, nextAttempt: number) => void;
  }
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500;

  for (let attempt = 0; ; attempt += 1) {
    const abortContext = createLinkedAbortContext(options.signal, options.timeoutMs);
    let onAttemptAbort: (() => void) | undefined;
    try {
      const operationPromise = operation({ attempt, signal: abortContext.signal });
      const abortPromise = new Promise<never>((_, reject) => {
        onAttemptAbort = () =>
          reject(new DOMException("Request aborted", "AbortError"));
        abortContext.signal.addEventListener("abort", onAttemptAbort, {
          once: true,
        });
      });
      return await Promise.race([operationPromise, abortPromise]);
    } catch (error) {
      const failure = normalizeRequestFailure(error, {
        timedOut: abortContext.didTimeout(),
        cancelled: options.signal?.aborted,
      });
      const shouldRetry = failure.retryable && attempt < options.maxRetries;
      if (!shouldRetry) throw failure;

      const nextAttempt = attempt + 1;
      options.onRetry?.(failure, nextAttempt);
      const jitter = Math.floor(Math.random() * (options.jitterMs ?? 150));
      const backoffMs = baseDelayMs * 2 ** attempt + jitter;
      await delayWithSignal(
        failure.retryAfterMs ?? backoffMs,
        options.signal
      );
    } finally {
      if (onAttemptAbort) {
        abortContext.signal.removeEventListener("abort", onAttemptAbort);
      }
      abortContext.cleanup();
    }
  }
}

export class QueueFullError extends RequestFailure {
  constructor(capacity: number) {
    super(
      `Meeting processing queue is full (${capacity}). The provider is not keeping up with incoming speech.`,
      { kind: "queue_full" }
    );
    this.name = "QueueFullError";
  }
}

interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class SerialTaskQueue {
  private readonly tasks: QueuedTask<unknown>[] = [];
  private active = false;

  constructor(
    private readonly capacity: number,
    private readonly onDepthChange?: (depth: number) => void
  ) {}

  get depth(): number {
    return this.tasks.length + (this.active ? 1 : 0);
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.depth >= this.capacity) {
      return Promise.reject(new QueueFullError(this.capacity));
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.tasks.push({ run, resolve, reject } as QueuedTask<unknown>);
    });
    this.emitDepth();
    void this.drain();
    return promise;
  }

  cancelPending(reason = "Meeting processing stopped"): void {
    const failure = new RequestFailure(reason, { kind: "cancelled" });
    for (const task of this.tasks.splice(0)) task.reject(failure);
    this.emitDepth();
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    const task = this.tasks.shift();
    if (!task) return;

    this.active = true;
    this.emitDepth();
    try {
      task.resolve(await task.run());
    } catch (error) {
      task.reject(error);
    } finally {
      this.active = false;
      this.emitDepth();
      void this.drain();
    }
  }

  private emitDepth(): void {
    this.onDepthChange?.(this.depth);
  }
}
