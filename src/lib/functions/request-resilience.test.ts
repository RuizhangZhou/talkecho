import { describe, expect, it, vi } from "vitest";
import {
  classifyHttpFailure,
  RequestFailure,
  runWithRetry,
  SerialTaskQueue,
} from "./request-resilience";

describe("request failure classification", () => {
  it("marks rate limits and server errors as retryable", () => {
    const rateLimit = classifyHttpFailure(429, "Too Many Requests", "", "2");
    expect(rateLimit.retryable).toBe(true);
    expect(rateLimit.retryAfterMs).toBe(2000);
    expect(classifyHttpFailure(503, "Unavailable").retryable).toBe(true);
  });

  it("falls back to backoff when Retry-After is absent or unusable", () => {
    // response.headers.get() returns null for a missing header. Number(null) is
    // 0, which would previously produce a zero-delay retry storm.
    expect(
      classifyHttpFailure(429, "Too Many Requests", "", null).retryAfterMs
    ).toBeUndefined();
    expect(
      classifyHttpFailure(429, "Too Many Requests", "", "").retryAfterMs
    ).toBeUndefined();
    expect(
      classifyHttpFailure(429, "Too Many Requests", "", "soon").retryAfterMs
    ).toBeUndefined();
    expect(
      classifyHttpFailure(429, "Too Many Requests").retryAfterMs
    ).toBeUndefined();
  });

  it("understands the HTTP-date form of Retry-After", () => {
    const twoSecondsOut = new Date(Date.now() + 2_000).toUTCString();
    const parsed = classifyHttpFailure(
      429,
      "Too Many Requests",
      "",
      twoSecondsOut
    ).retryAfterMs;
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(2_000);
  });

  it("never retries context-window failures", () => {
    const failure = classifyHttpFailure(
      400,
      "Bad Request",
      "maximum context length exceeded"
    );
    expect(failure.kind).toBe("context_limit");
    expect(failure.retryable).toBe(false);
  });
});

describe("runWithRetry", () => {
  it("retries one transient failure and then succeeds", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new RequestFailure("temporary", {
          kind: "network",
          retryable: true,
        })
      )
      .mockResolvedValue("ok");

    await expect(
      runWithRetry(operation, {
        timeoutMs: 1000,
        maxRetries: 1,
        baseDelayMs: 0,
        jitterMs: 0,
      })
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("turns a stalled operation into a timeout", async () => {
    await expect(
      runWithRetry(() => new Promise(() => {}), {
        timeoutMs: 10,
        maxRetries: 0,
      })
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("SerialTaskQueue", () => {
  it("preserves FIFO order and continues after a failed task", async () => {
    const order: number[] = [];
    const queue = new SerialTaskQueue(4);
    const first = queue.enqueue(async () => {
      order.push(1);
      throw new Error("expected failure");
    });
    const second = queue.enqueue(async () => {
      order.push(2);
      return "second";
    });

    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual([1, 2]);
  });

  it("rejects excess work instead of growing without bounds", async () => {
    let release!: () => void;
    const queue = new SerialTaskQueue(1);
    const active = queue.enqueue(
      () => new Promise<void>((resolve) => (release = resolve))
    );

    await expect(queue.enqueue(async () => undefined)).rejects.toMatchObject({
      kind: "queue_full",
    });
    release();
    await active;
  });

  it("cancels waiting tasks while allowing the active task to unwind", async () => {
    let release!: () => void;
    const queue = new SerialTaskQueue(3);
    const active = queue.enqueue(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const waiting = queue.enqueue(async () => "never runs");

    queue.cancelPending();
    await expect(waiting).rejects.toMatchObject({ kind: "cancelled" });
    release();
    await active;
    expect(queue.depth).toBe(0);
  });
});
