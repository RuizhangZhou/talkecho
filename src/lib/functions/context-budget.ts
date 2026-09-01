import { Message, TYPE_PROVIDER } from "@/types";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 16_000;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 1_024;
export const DEFAULT_MEETING_CONTEXT_TOKENS = 2_000;

export function estimateTextTokens(text: string): number {
  let asciiCharacters = 0;
  let nonAsciiTokens = 0;

  for (const character of text) {
    if (/\s/u.test(character)) {
      asciiCharacters += 1;
    } else if (character.codePointAt(0)! <= 0x7f) {
      asciiCharacters += 1;
    } else {
      // Conservative for Chinese/Japanese/Korean and safe enough for other
      // multilingual text where a character can be close to one token.
      nonAsciiTokens += 1;
    }
  }

  return Math.max(1, Math.ceil(asciiCharacters / 4) + nonAsciiTokens);
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text || "").join(" ");
}

export function estimateMessageTokens(message: Message): number {
  return 4 + estimateTextTokens(messageText(message));
}

function truncateFromEnd(text: string, tokenBudget: number): string {
  if (estimateTextTokens(text) <= tokenBudget) return text;
  let result = "";
  let estimatedTokens = 0;
  const characters = Array.from(text);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const tokenCost = character.codePointAt(0)! <= 0x7f ? 0.25 : 1;
    if (estimatedTokens + tokenCost > tokenBudget) break;
    result = character + result;
    estimatedTokens += tokenCost;
  }
  return `[Earlier part of this message omitted]\n${result.trimStart()}`;
}

export function getProviderTokenBudget(provider?: TYPE_PROVIDER): {
  contextWindowTokens: number;
  outputReserveTokens: number;
  historyBudgetTokens: number;
} {
  const configuredContextWindow = provider?.contextWindowTokens;
  const configuredOutputReserve = provider?.maxOutputTokens;
  const contextWindowTokens = Math.max(
    2_048,
    Number.isFinite(configuredContextWindow)
      ? configuredContextWindow!
      : DEFAULT_CONTEXT_WINDOW_TOKENS
  );
  const outputReserveTokens = Math.min(
    Math.max(
      256,
      Number.isFinite(configuredOutputReserve)
        ? configuredOutputReserve!
        : DEFAULT_OUTPUT_RESERVE_TOKENS
    ),
    Math.floor(contextWindowTokens / 2)
  );
  const safetyReserve = Math.ceil(contextWindowTokens * 0.1);
  return {
    contextWindowTokens,
    outputReserveTokens,
    historyBudgetTokens: Math.max(
      512,
      contextWindowTokens - outputReserveTokens - safetyReserve
    ),
  };
}

export function selectRecentHistory(
  chronologicalHistory: Message[],
  tokenBudget: number
): {
  history: Message[];
  estimatedTokens: number;
  omittedMessages: number;
} {
  const selected: Message[] = [];
  let estimatedTokens = 0;

  for (let index = chronologicalHistory.length - 1; index >= 0; index -= 1) {
    const message = chronologicalHistory[index];
    const tokens = estimateMessageTokens(message);
    if (selected.length > 0 && estimatedTokens + tokens > tokenBudget) break;
    if (tokens > tokenBudget && selected.length === 0) {
      if (typeof message.content === "string") {
        const truncated = {
          ...message,
          content: truncateFromEnd(message.content, Math.max(1, tokenBudget - 8)),
        };
        selected.unshift(truncated);
        estimatedTokens = estimateMessageTokens(truncated);
      }
      break;
    }
    selected.unshift(message);
    estimatedTokens += tokens;
  }

  return {
    history: selected,
    estimatedTokens,
    omittedMessages: chronologicalHistory.length - selected.length,
  };
}

export function buildMeetingReferenceContext(
  newestFirstMessages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>,
  tokenBudget = DEFAULT_MEETING_CONTEXT_TOKENS
): {
  context: string;
  estimatedTokens: number;
  omittedUtterances: number;
} {
  const utterances = newestFirstMessages.filter(
    (message) => message.role === "user" && Boolean(message.content.trim())
  );
  const selected: string[] = [];
  let estimatedTokens = 0;

  for (const utterance of utterances) {
    const tokens = estimateTextTokens(utterance.content) + 2;
    if (selected.length > 0 && estimatedTokens + tokens > tokenBudget) break;
    if (tokens > tokenBudget && selected.length === 0) continue;
    selected.unshift(utterance.content.trim());
    estimatedTokens += tokens;
  }

  return {
    context: selected.join("\n"),
    estimatedTokens,
    omittedUtterances: utterances.length - selected.length,
  };
}
