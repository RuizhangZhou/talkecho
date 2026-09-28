import { describe, expect, it, vi } from "vitest";
import {
  classifyHttpFailure,
  CoalescingTaskQueue,
  RequestFailure,
  runWithRetry,
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

describe("CoalescingTaskQueue", () => {
  it("keeps one pending batch and appends newer work in FIFO order", async () => {
    let release!: () => void;
    const batches: number[][] = [];
    const queue = new CoalescingTaskQueue<number>(async (items) => {
      batches.push(items);
      if (items[0] === 1) {
        await new Promise<void>((resolve) => (release = resolve));
      }
    });

    const first = queue.enqueue(1);
    const pendingBatch = queue.enqueueBatch([2, 3]);

    expect(queue.snapshot).toMatchObject({
      activeItems: 1,
      pendingItems: 2,
      totalItems: 3,
    });
    release();
    await Promise.all([first, pendingBatch]);

    expect(batches).toEqual([[1], [2, 3]]);
    expect(queue.depth).toBe(0);
  });

  it("promotes the pending batch after an active batch fails", async () => {
    let release!: () => void;
    const batches: number[][] = [];
    const queue = new CoalescingTaskQueue<number>(async (items) => {
      batches.push(items);
      if (items[0] === 1) {
        await new Promise<void>((resolve) => (release = resolve));
        throw new Error("expected failure");
      }
    });

    const active = queue.enqueue(1);
    const pending = queue.enqueueBatch([2, 3]);
    release();

    await expect(active).rejects.toThrow("expected failure");
    await expect(pending).resolves.toBeUndefined();
    expect(batches).toEqual([[1], [2, 3]]);
  });

  it("cancels every item in the single pending batch", async () => {
    let release!: () => void;
    const queue = new CoalescingTaskQueue<number>(async (items) => {
      if (items[0] === 1) {
        await new Promise<void>((resolve) => (release = resolve));
      }
    });

    const active = queue.enqueue(1);
    const waitingA = queue.enqueue(2);
    const waitingB = queue.enqueue(3);
    queue.cancelPending();

    await expect(waitingA).rejects.toMatchObject({ kind: "cancelled" });
    await expect(waitingB).rejects.toMatchObject({ kind: "cancelled" });
    release();
    await active;
    expect(queue.depth).toBe(0);
  });
});
