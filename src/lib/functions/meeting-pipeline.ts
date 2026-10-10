import { CoalescingQueueSnapshot, RequestFailure } from "./request-resilience";
import { estimateTextTokens } from "./context-budget";

// Small enough to keep translation latency predictable, including CJK output.
export const MEETING_TRANSLATION_BATCH_TOKENS = 400;
export const MEETING_REFERENCE_TOKENS = 400;

/** Split without discarding or duplicating any characters. Prefer word/line boundaries. */
export function splitMeetingText(
  text: string,
  limit = MEETING_TRANSLATION_BATCH_TOKENS,
): string[] {
  if (!Number.isFinite(limit) || limit < 1)
    throw new RangeError("Token limit must be positive");
  const pieces: string[] = [];
  let piece = "";
  let weight = 0;
  for (const word of text.match(/\S+\s*|\s+/gu) ?? []) {
    if (piece && estimateTextTokens(piece + word) > limit) {
      pieces.push(piece);
      piece = "";
      weight = 0;
    }
    for (const character of word) {
      const cost =
        /\s/u.test(character) || character.codePointAt(0)! <= 0x7f ? 0.25 : 1;
      if (piece && Math.ceil(weight + cost) > limit) {
        pieces.push(piece);
        piece = "";
        weight = 0;
      }
      piece += character;
      weight += cost;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

interface Entry<T, R> {
  id: number;
  item: T;
  startedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  result?: R;
  error?: unknown;
  failed?: boolean;
}

/** Bounded parallel STT, with results committed in capture order. One waiting buffer. */
export class OrderedTaskPool<T, R> {
  private pending: Entry<T, R>[] = [];
  private active = new Map<number, Entry<T, R>>();
  private completed = new Map<number, Entry<T, R>>();
  private nextId = 0;
  private nextCommit = 0;
  private averageMs = 3_000;

  constructor(
    private readonly run: (item: T) => Promise<R>,
    private readonly commit: (item: T, result: R) => void,
    private readonly onSnapshot: () => void,
    private readonly timestamp: (item: T) => number,
    private readonly concurrency = 2,
  ) {}

  get snapshot(): CoalescingQueueSnapshot {
    const slots = [...this.active.values()].map((entry) =>
      Math.max(1_000, this.averageMs - (Date.now() - entry.startedAt)),
    );
    while (slots.length < this.concurrency) slots.push(0);
    for (const _entry of this.pending) {
      slots.sort((a, b) => a - b);
      slots[0] += this.averageMs;
    }
    const entries = [
      ...this.active.values(),
      ...this.pending,
      ...this.completed.values(),
    ];
    return {
      activeItems: this.active.size + this.completed.size,
      pendingItems: this.pending.length,
      totalItems: entries.length,
      averageItemDurationMs: this.averageMs,
      estimatedBacklogMs: entries.length ? Math.max(...slots) : 0,
      oldestAgeMs: Math.max(
        0,
        ...entries.map((entry) => Date.now() - this.timestamp(entry.item)),
      ),
    };
  }

  enqueue(item: T): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        id: this.nextId++,
        item,
        startedAt: 0,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  cancelPending(reason = "Meeting processing stopped"): void {
    for (const entry of this.pending.splice(0)) {
      entry.failed = true;
      entry.error = new RequestFailure(reason, { kind: "cancelled" });
      this.completed.set(entry.id, entry);
      entry.reject(entry.error);
    }
    this.flush();
    this.onSnapshot();
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length) {
      const entry = this.pending.shift()!;
      entry.startedAt = Date.now();
      this.active.set(entry.id, entry);
      void this.execute(entry);
    }
    this.onSnapshot();
  }

  private async execute(entry: Entry<T, R>): Promise<void> {
    try {
      entry.result = await this.run(entry.item);
      this.averageMs =
        this.averageMs * 0.75 + (Date.now() - entry.startedAt) * 0.25;
    } catch (error) {
      entry.error = error;
      entry.failed = true;
    } finally {
      this.active.delete(entry.id);
      this.completed.set(entry.id, entry);
      this.flush();
      this.pump();
    }
  }

  private flush(): void {
    while (this.completed.has(this.nextCommit)) {
      const entry = this.completed.get(this.nextCommit)!;
      this.completed.delete(this.nextCommit++);
      try {
        if (entry.failed) entry.reject(entry.error);
        else {
          this.commit(entry.item, entry.result as R);
          entry.resolve();
        }
      } catch (error) {
        entry.reject(error);
      }
    }
  }
}

/** Approximate drain time for known work; STT and translation overlap. */
export function estimateMeetingDrainMs(
  audio: CoalescingQueueSnapshot,
  text: CoalescingQueueSnapshot,
  expectedTranscriptTokens = 80,
): number {
  const futureTranslation =
    audio.totalItems * expectedTranscriptTokens * text.averageItemDurationMs;
  return audio.totalItems
    ? Math.max(
        text.estimatedBacklogMs + futureTranslation,
        audio.estimatedBacklogMs +
          expectedTranscriptTokens * text.averageItemDurationMs,
      )
    : text.estimatedBacklogMs;
}
