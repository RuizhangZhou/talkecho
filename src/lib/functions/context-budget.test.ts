import { describe, expect, it } from "vitest";
import {
  buildMeetingReferenceContext,
  estimateTextTokens,
  selectRecentHistory,
  sortMessagesChronologically,
} from "./context-budget";

describe("context budgeting", () => {
  it("uses a conservative multilingual estimate", () => {
    expect(estimateTextTokens("12345678")).toBe(2);
    expect(estimateTextTokens("这是中文")).toBe(4);
  });

  it("keeps the newest messages when the history exceeds the budget", () => {
    const history = [
      { role: "user" as const, content: "old ".repeat(20) },
      { role: "assistant" as const, content: "middle ".repeat(20) },
      { role: "user" as const, content: "newest" },
    ];
    const result = selectRecentHistory(history, 15);

    expect(result.history).toEqual([history[2]]);
    expect(result.omittedMessages).toBe(2);
  });

  it("truncates an oversized newest message instead of keeping older context", () => {
    const history = [
      { role: "user" as const, content: "old" },
      { role: "assistant" as const, content: "newest ".repeat(100) },
    ];
    const result = selectRecentHistory(history, 20);

    expect(result.history).toHaveLength(1);
    expect(result.history[0].role).toBe("assistant");
    expect(String(result.history[0].content)).toContain("Earlier part");
  });

  it("uses raw user utterances only for automatic meeting context", () => {
    const result = buildMeetingReferenceContext(
      [
        { role: "assistant", content: "translated answer" },
        {
          role: "user",
          content: "manual question must not leak into automatic context",
          source: "manual",
        },
        {
          role: "user",
          content: "latest raw utterance",
          source: "system_audio",
        },
        { role: "user", content: "older raw utterance" },
      ],
      100
    );

    expect(result.context).toBe("older raw utterance\nlatest raw utterance");
    expect(result.context).not.toContain("translated answer");
    expect(result.context).not.toContain("manual question");
  });

  it("orders manual history by timestamps instead of reversing message pairs", () => {
    const newestFirstPairs = [
      { role: "user", content: "question 2", timestamp: 30 },
      { role: "assistant", content: "answer 2", timestamp: 31 },
      { role: "user", content: "question 1", timestamp: 10 },
      { role: "assistant", content: "answer 1", timestamp: 11 },
    ];

    expect(
      sortMessagesChronologically(newestFirstPairs).map(({ content }) => content)
    ).toEqual(["question 1", "answer 1", "question 2", "answer 2"]);
  });
});
