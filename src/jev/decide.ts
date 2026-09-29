/**
 * Shared: the decision seam every injectable level agrees on, and the parser
 * for the raw Jev question JSON the agent-side levels accept. Declared once
 * here so levels 6, 8, 9, and 10 cannot drift apart.
 */
import { validateQuestions, type Answer, type Questions, type State } from "./core/types.ts";

/** One decision: state and questions in, typed answers out. The shared client by default; the extensions pass a reporting wrapper, tests pass stubs. */
export type Decide = (
  state: State,
  questions: Questions,
) => Promise<{
  answers: Record<string, Answer>;
  usage?: unknown;
  model?: string;
}>;

/** The agent writes Jev's question shape as JSON. Malformed blocks fail here, with the reason, before any file is read. */
export function parseQuestions(questionsJson: string): Questions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(questionsJson);
  } catch (err: any) {
    throw new Error(`questions_json is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("questions_json must be an object keyed by question id");
  validateQuestions(parsed as Questions);
  return parsed as Questions;
}
