/**
 * Level 9, option A: ask_jev_files.
 * The same questions, raw Jev question JSON, over many files. One call per file, every question in each, all in parallel with a cap. Answers come back per path. No file enters the agent's context.
 */
import { jev } from "../../core/client.ts";
import type { Answer } from "../../core/types.ts";
import { type Decide, parseQuestions } from "../../decide.ts";
import { FileStateError, readFileState } from "../level08/read-state.ts";
import { expandPatterns, pruneFiles, type Skipped } from "./prune.ts";

export interface FileAnswers {
  path: string;
  answers: Record<string, Answer>;
  usage?: unknown;
}

export interface AskFilesResult {
  results: FileAnswers[];
  skipped: Skipped[];
  /** Every decide attempt, including the ones that failed; failures also land in `skipped`. */
  calls: number;
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep the input order. */
export async function parallel<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function askFiles(
  patterns: string[],
  questionsJson: string,
  cwd: string,
  opts: {
    recursive?: boolean;
    concurrency?: number;
    decide?: Decide;
    onResult?: (r: FileAnswers) => void;
  } = {},
): Promise<AskFilesResult> {
  const questions = parseQuestions(questionsJson);
  const decide = opts.decide ?? ((s, q) => jev.systemOne(s, q));
  const expanded = await expandPatterns(patterns, cwd, opts.recursive ?? false);
  const { files, skipped } = await pruneFiles(expanded, cwd);
  const results: FileAnswers[] = [];
  let calls = 0;
  await parallel(files, opts.concurrency ?? 16, async (path) => {
    try {
      const state = await readFileState(path, cwd);
      calls++;
      const { answers, usage } = await decide(state, questions);
      const r = { path, answers, usage };
      results.push(r);
      opts.onResult?.(r);
    } catch (err: any) {
      skipped.push({
        path,
        reason: err instanceof FileStateError ? err.message : `call failed: ${err?.message ?? err}`,
      });
    }
  });
  results.sort((a, b) => a.path.localeCompare(b.path));
  return { results, skipped, calls };
}
