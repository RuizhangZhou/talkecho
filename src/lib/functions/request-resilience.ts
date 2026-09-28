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

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * Returns undefined when the header is absent or unparseable, so callers fall
 * back to exponential backoff. Note that `Number(null)` and `Number("")` are
 * both 0, so the null/blank cases must be rejected before coercing - otherwise
 * a rate-limited response with no header would be retried with no delay at all.
 */
export function parseRetryAfterMs(
  retryAfterHeader?: string | null
): number | undefined {
  if (retryAfterHeader == null) return undefined;
  const raw = retryAfterHeader.trim();
  if (!raw) return undefined;

  // delta-seconds form, e.g. "120"
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.max(0, Number(raw) * 1000);
  }

  // HTTP-date form, e.g. "Wed, 21 Oct 2015 07:28:00 GMT"
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return undefined;
}

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
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
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
    maxDelayMs?: number;
    jitterMs?: number;
    onRetry?: (failure: RequestFailure, nextAttempt: number) => void;
  }
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;

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
      // A provider-supplied Retry-After wins over our backoff, but is capped so
      // a large value cannot stall the meeting pipeline indefinitely.
      const delayMs = Math.min(failure.retryAfterMs ?? backoffMs, maxDelayMs);
      await delayWithSignal(delayMs, options.signal);
    } finally {
      if (onAttemptAbort) {
        abortContext.signal.removeEventListener("abort", onAttemptAbort);
      }
      abortContext.cleanup();
    }
  }
}

export interface CoalescingQueueSnapshot {
  activeItems: number;
  pendingItems: number;
  totalItems: number;
  averageItemDurationMs: number;
  estimatedBacklogMs: number;
}

interface CoalescingQueueEntry<T> {
  item: T;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * A serial queue with one mutable pending batch.
 *
 * Work that arrives while a batch is active is appended to the same pending
 * batch instead of allocating another request slot. Once the active batch
 * finishes, the pending batch is promoted atomically. This keeps ordering,
 * avoids a fixed-capacity overflow, and gives the batch runner an opportunity
 * to combine many small meeting segments into one downstream AI request.
 */
export class CoalescingTaskQueue<T> {
  private activeBatch: CoalescingQueueEntry<T>[] | null = null;
  private pendingBatch: CoalescingQueueEntry<T>[] = [];
  private activeStartedAt = 0;
  private averageItemDurationMs: number;

  constructor(
    private readonly runBatch: (items: T[]) => Promise<void>,
    private readonly onSnapshot?: (snapshot: CoalescingQueueSnapshot) => void,
    initialItemDurationMs = 8_000
  ) {
    this.averageItemDurationMs = initialItemDurationMs;
  }

  get depth(): number {
    return (this.activeBatch?.length ?? 0) + this.pendingBatch.length;
  }

  get snapshot(): CoalescingQueueSnapshot {
    const activeItems = this.activeBatch?.length ?? 0;
    const pendingItems = this.pendingBatch.length;
    const elapsedMs = this.activeStartedAt
      ? Math.max(0, Date.now() - this.activeStartedAt)
      : 0;
    const estimatedActiveMs = activeItems * this.averageItemDurationMs;
    const remainingActiveMs = activeItems
      ? Math.max(1_000, estimatedActiveMs - elapsedMs)
      : 0;

    return {
      activeItems,
      pendingItems,
      totalItems: activeItems + pendingItems,
      averageItemDurationMs: this.averageItemDurationMs,
      estimatedBacklogMs:
        remainingActiveMs + pendingItems * this.averageItemDurationMs,
    };
  }

  enqueue(item: T): Promise<void> {
    return this.enqueueBatch([item]);
  }

  enqueueBatch(items: T[]): Promise<void> {
    if (items.length === 0) return Promise.resolve();

    const entries: CoalescingQueueEntry<T>[] = [];
    const promises = items.map(
      (item) =>
        new Promise<void>((resolve, reject) => {
          entries.push({ item, resolve, reject });
        })
    );
    if (this.activeBatch) {
      // There is deliberately only one pending batch. Every newer item
      // rewrites that batch by extending its ordered payload.
      this.pendingBatch.push(...entries);
    } else {
      this.startBatch(entries);
    }
    this.emitSnapshot();
    return Promise.all(promises).then(() => undefined);
  }

  cancelPending(reason = "Meeting processing stopped"): void {
    const failure = new RequestFailure(reason, { kind: "cancelled" });
    for (const entry of this.pendingBatch.splice(0)) entry.reject(failure);
    this.emitSnapshot();
  }

  private startBatch(entries: CoalescingQueueEntry<T>[]): void {
    this.activeBatch = entries;
    this.activeStartedAt = Date.now();
    this.emitSnapshot();
    void this.drain(entries);
  }

  private async drain(entries: CoalescingQueueEntry<T>[]): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.runBatch(entries.map((entry) => entry.item));
      for (const entry of entries) entry.resolve();
    } catch (error) {
      for (const entry of entries) entry.reject(error);
    } finally {
      const observedPerItemMs = Math.max(
        1,
        (Date.now() - startedAt) / Math.max(1, entries.length)
      );
      // Smooth noisy provider timings while still adapting within a meeting.
      this.averageItemDurationMs =
        this.averageItemDurationMs * 0.75 + observedPerItemMs * 0.25;
      this.activeBatch = null;
      this.activeStartedAt = 0;

      const nextBatch = this.pendingBatch.splice(0);
      if (nextBatch.length > 0) this.startBatch(nextBatch);
      else this.emitSnapshot();
    }
  }

  private emitSnapshot(): void {
    this.onSnapshot?.(this.snapshot);
  }
}
