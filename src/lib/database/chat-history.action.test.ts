import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  getDatabase: vi.fn(),
}));

import { getDatabase } from "./config";
import { updateConversation } from "./chat-history.action";

describe("updateConversation", () => {
  const execute = vi.fn();
  const select = vi.fn();

  beforeEach(() => {
    execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
    select.mockReset();
    vi.mocked(getDatabase).mockResolvedValue({ execute, select } as never);
  });

  it("writes only new messages on the common append path", async () => {
    select.mockResolvedValue([
      {
        id: "old-user",
        conversation_id: "conversation-1",
        role: "user",
        content: "existing",
        timestamp: 10,
        attached_files: null,
        source: "system_audio",
      },
    ]);

    await updateConversation({
      id: "conversation-1",
      title: "Meeting",
      createdAt: 1,
      updatedAt: 21,
      messages: [
        {
          id: "new-assistant",
          role: "assistant",
          content: "new answer",
          timestamp: 21,
          source: "system_audio",
        },
        {
          id: "old-user",
          role: "user",
          content: "existing",
          timestamp: 10,
          source: "system_audio",
        },
      ],
    });

    const sqlStatements = execute.mock.calls.map(([sql]) => String(sql));
    expect(
      sqlStatements.filter((sql) => sql.includes("INSERT INTO messages"))
    ).toHaveLength(1);
    expect(
      sqlStatements.some((sql) =>
        sql.includes("DELETE FROM messages WHERE conversation_id")
      )
    ).toBe(false);
  });

  it("removes a specific stale row without rebuilding the whole conversation", async () => {
    select.mockResolvedValue([
      {
        id: "removed-message",
        conversation_id: "conversation-1",
        role: "user",
        content: "remove me",
        timestamp: 10,
        attached_files: null,
        source: null,
      },
    ]);

    await updateConversation({
      id: "conversation-1",
      title: "Meeting",
      createdAt: 1,
      updatedAt: 20,
      messages: [],
    });

    expect(execute).toHaveBeenCalledWith(
      "DELETE FROM messages WHERE id = ? AND conversation_id = ?",
      ["removed-message", "conversation-1"]
    );
  });
});
