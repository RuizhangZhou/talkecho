import { afterEach, describe, expect, it, vi } from "vitest";
import { CoalescingTaskQueue, RequestFailure } from "./request-resilience";
import {
  OrderedTaskPool,
  splitMeetingText,
  estimateMeetingDrainMs,
} from "./meeting-pipeline";
import { estimateTextTokens } from "./context-budget";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(() => vi.useRealTimers());

describe("meeting pipeline", () => {
  it("commits out-of-order STT completions in capture order with at most two requests", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximum = 0;
    const committed: number[] = [];
    const pool = new OrderedTaskPool<number, number>(
      async (id) => {
        maximum = Math.max(maximum, ++active);
        await sleep(id === 0 ? 10_000 : 1_000);
        --active;
        return id;
      },
      (_id, result) => committed.push(result),
      () => {},
      () => Date.now(),
    );
    const work = [0, 1, 2, 3].map((id) => pool.enqueue(id));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(committed).toEqual([]);
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(committed).toEqual([0, 1, 2, 3]);
    expect(maximum).toBe(2);
    expect(pool.snapshot.totalItems).toBe(0);
  });

  it("does not stall later results after a failed or cancelled segment", async () => {
    vi.useFakeTimers();
    const committed: number[] = [];
    const pool = new OrderedTaskPool<number, number>(
      async (id) => {
        await sleep(100);
        if (id === 0) throw new RequestFailure("timeout", { kind: "timeout" });
        return id;
      },
      (_id, result) => committed.push(result),
      () => {},
      () => Date.now(),
    );
    const outcomes = [0, 1, 2].map((id) =>
      pool.enqueue(id).catch((error) => error.kind),
    );
    pool.cancelPending();
    await vi.runAllTimersAsync();
    expect(await Promise.all(outcomes)).toEqual([
      "timeout",
      undefined,
      "cancelled",
    ]);
    await Promise.all([pool.enqueue(3), vi.runAllTimersAsync()]);
    expect(committed).toEqual([1, 3]);
  });

  it("splits oversized multilingual utterances without losing whitespace or characters", () => {
    const original =
      "  speaker: 数据库迁移与延迟🙂。\n".repeat(150) + " longword".repeat(100);
    const pieces = splitMeetingText(original, 392);
    expect(pieces.join("")).toBe(original);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => estimateTextTokens(piece) <= 392)).toBe(
      true,
    );
  });

  it("bounds each translated batch while retaining the rest in one pending buffer", async () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    const queue = new CoalescingTaskQueue<number>(
      async (items) => {
        batches.push(items);
        await sleep(100);
      },
      undefined,
      40,
      { maxBatchItems: 8, maxBatchWeight: 400, itemWeight: () => 80 },
    );
    const work = Array.from({ length: 31 }, (_, id) => queue.enqueue(id));
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(batches.flat()).toEqual(Array.from({ length: 31 }, (_, id) => id));
    expect(Math.max(...batches.map((batch) => batch.length))).toBe(5);
    expect(queue.depth).toBe(0);
  });

  it("accounts for overlap rather than adding both full stage durations", () => {
    const audio = {
      activeItems: 2,
      pendingItems: 0,
      totalItems: 2,
      averageItemDurationMs: 6_000,
      estimatedBacklogMs: 6_000,
      oldestAgeMs: 0,
    };
    const text = {
      ...audio,
      totalItems: 1,
      averageItemDurationMs: 40,
      estimatedBacklogMs: 12_000,
    };
    expect(estimateMeetingDrainMs(audio, text)).toBe(18_400);
    // Previous estimate: 6,000 + 12,000 + 2 * 8,000 = 34,000 ms.
  });
});

interface Audio {
  id: number;
  capturedAt: number;
  pcm: Float32Array;
}
interface Transcript {
  id: number;
  capturedAt: number;
  text: string;
}

async function simulateMeeting(
  improved: boolean,
  durationMs = 30 * 60_000,
  translationPerItemMs = 2_000,
) {
  const start = Date.now();
  // Reuse generated 16 kHz PCM; timing tests model file-STT service, not ASR accuracy.
  const pcm = Float32Array.from(
    { length: 16_000 },
    (_, index) => Math.sin(index * 0.1) * 0.1,
  );
  const commits: number[] = [];
  const translated: number[] = [];
  const delays: number[] = [];
  const errors: string[] = [];
  let largestRequest = 0;
  let maximumBacklog = 0;
  const pending: Promise<unknown>[] = [];
  const ai = new CoalescingTaskQueue<Transcript>(
    async (items) => {
      largestRequest = Math.max(largestRequest, items.length);
      const responseTime = 2_000 + translationPerItemMs * items.length;
      await sleep(Math.min(responseTime, 60_000));
      if (responseTime > 60_000)
        throw new RequestFailure("translation timeout", { kind: "timeout" });
      for (const item of items) {
        translated.push(item.id);
        delays.push(Date.now() - item.capturedAt);
      }
    },
    () => {
      maximumBacklog = Math.max(maximumBacklog, ai.depth);
    },
    improved ? 40 : 8_000,
    improved
      ? {
          maxBatchItems: 8,
          maxBatchWeight: 400,
          itemWeight: () => 80,
          batchOverheadMs: 1_500,
        }
      : {},
  );
  const transcribe = async (audio: Audio): Promise<Transcript> => {
    await sleep(6_000);
    return {
      id: audio.id,
      capturedAt: audio.capturedAt,
      text: `Synthetic meeting utterance ${audio.id}`,
    };
  };
  const commit = (audio: Audio, result: Transcript) => {
    commits.push(audio.id); // Stored before translation, even if translation fails.
    pending.push(ai.enqueue(result).catch((error) => errors.push(error.kind)));
  };
  const modern = new OrderedTaskPool(
    transcribe,
    commit,
    () => {},
    (audio) => audio.capturedAt,
  );
  const legacy = new CoalescingTaskQueue<Audio>(async (items) => {
    const transcripts: Transcript[] = [];
    for (const item of items) {
      transcripts.push(await transcribe(item));
      commits.push(item.id);
    }
    pending.push(
      ai.enqueueBatch(transcripts).catch((error) => errors.push(error.kind)),
    );
  });
  const count = durationMs / 4_000;
  for (let id = 0; id < count; id++) {
    setTimeout(() => {
      const audio = { id, pcm, capturedAt: Date.now() };
      pending.push(
        (improved ? modern.enqueue(audio) : legacy.enqueue(audio)).catch(
          (error) => errors.push(error.kind),
        ),
      );
    }, id * 4_000);
  }
  await vi.advanceTimersByTimeAsync(durationMs);
  const atMeetingEnd = improved
    ? modern.snapshot.totalItems + ai.depth
    : legacy.depth + ai.depth;
  await vi.runAllTimersAsync();
  await Promise.all(pending);
  delays.sort((a, b) => a - b);
  return {
    commits,
    translated,
    errors,
    largestRequest,
    maximumBacklog,
    atMeetingEnd,
    p95Seconds: delays[Math.floor(delays.length * 0.95)] / 1_000,
    maxSeconds: Math.max(...delays) / 1_000,
    drainSeconds: (Date.now() - start - durationMs) / 1_000,
  };
}

describe("sustained meeting simulation", () => {
  it("reproduces the legacy backlog/timeout and drains a 30-minute meeting with bounded ordered work", async () => {
    vi.useFakeTimers();
    const before = await simulateMeeting(false);
    const after = await simulateMeeting(true);
    const expected = Array.from({ length: 450 }, (_, id) => id);
    expect(before.commits).toEqual(expected);
    expect(before.errors).toContain("timeout");
    expect(before.atMeetingEnd).toBeGreaterThan(100);
    expect(after.commits).toEqual(expected);
    expect(after.translated).toEqual(expected);
    expect(after.errors).toEqual([]);
    expect(after.largestRequest).toBeLessThanOrEqual(5);
    expect(after.p95Seconds).toBeLessThan(15);
    console.info(
      "30-minute synthetic meeting:",
      JSON.stringify({
        before: {
          p95: before.p95Seconds,
          maxBatch: before.largestRequest,
          queuedAtEnd: before.atMeetingEnd,
          drain: before.drainSeconds,
          errors: before.errors.length,
        },
        after: {
          p95: after.p95Seconds,
          maxBatch: after.largestRequest,
          queuedAtEnd: after.atMeetingEnd,
          drain: after.drainSeconds,
          errors: after.errors.length,
        },
      }),
    );
  });

  it("keeps payloads bounded even when translation is slower than sustained speech", async () => {
    vi.useFakeTimers();
    const result = await simulateMeeting(true, 120_000, 6_000);
    expect(result.atMeetingEnd).toBeGreaterThan(5);
    expect(result.largestRequest).toBeLessThanOrEqual(5);
    expect(result.errors).toEqual([]);
    expect(result.translated).toEqual(
      Array.from({ length: 30 }, (_, id) => id),
    );
  });
});
