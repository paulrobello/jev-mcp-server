/**
 * Level 10, option A: ask_systemone on any content.
 * The general form. The agent passes its own state, paths for code to read, a command for code to run, and its question block. Code assembles one state, validates, and makes one call. The agent never receives the files or the output, only the answers.
 */
import { systemOneClient } from "../../core/client.ts";
import type { Answer, State } from "../../core/types.ts";
import { type Decide, parseQuestions } from "../../decide.ts";

// Re-exported so the ask_systemone extension keeps importing it from the level's surface.
export { parseQuestions };

export interface AskResult {
  answers: Record<string, Answer>;
  usage?: unknown;
  model?: string;
  state_summary?: unknown;
}

/** A JSON string becomes structured state; anything else is sent as the string it is. */
export function parseState(raw: string | Record<string, unknown>): State {
  if (typeof raw !== "string") return raw;
  const t = raw.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON after all, send the text */
    }
  }
  return raw;
}

/** A: any state, any questions, one call. Empty state is refused; System One cannot judge nothing. */
export async function askSystemOne(
  rawState: string | Record<string, unknown>,
  questionsJson: string,
  decide: Decide = (s, q) => systemOneClient.systemOne(s, q),
): Promise<AskResult> {
  const state = parseState(rawState);
  if (typeof state === "string" ? !state.trim() : !state || Object.keys(state).length === 0)
    throw new Error("state is empty");
  const questions = parseQuestions(questionsJson);
  const { answers, usage, model } = await decide(state, questions);
  return { answers, usage, model };
}
