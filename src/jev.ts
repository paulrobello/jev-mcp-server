/**
 * The one way this server calls Jev: client resolution from the environment, the
 * call, and a JEV_EVENT line on stderr for debugging. Mirrors the omp extension's
 * report.ts wiring (par-omp-ext Extensions/jev), minus the pi side channel.
 *
 * cc-router relays Jev to OpenRouter with its own key and logs cost and bodies on
 * its dashboard, so this side needs no OpenRouter credential. Precedence: JEV_BACKEND
 * keeps upstream behavior (mock, or direct OpenRouter with the ambient key);
 * JEV_ENDPOINT points at a relay; OPENROUTER_API_KEY goes direct; the default is
 * the local cc-router relay.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JevClient, type JevClientOptions, type SystemOneResult } from "./jev/core/client.ts";
import { type Answer, type Questions, type State, validateQuestions } from "./jev/core/types.ts";

export const RELAY_ENDPOINT = "http://127.0.0.1:8792/v1/systemone";

const relayKey = (): string => {
  const env = process.env.JEV_OPENROUTER_KEY?.trim();
  if (env) return env;
  try {
    return readFileSync(join(homedir(), ".config", "jev", "key"), "utf8").trim() || "cc-router";
  } catch {
    return "cc-router"; // inert: cc-router replaces upstream auth
  }
};

export function jevClientOptions(env: NodeJS.ProcessEnv = process.env): JevClientOptions {
  if (env.JEV_BACKEND?.trim()) return {};
  const relay = env.JEV_ENDPOINT?.trim();
  if (relay)
    return {
      provider: "openrouter",
      baseUrl: relay,
      apiKey: env.JEV_OPENROUTER_KEY?.trim() || relayKey(),
    };
  if (env.OPENROUTER_API_KEY?.trim()) return {};
  return {
    provider: "openrouter",
    baseUrl: RELAY_ENDPOINT,
    apiKey: env.JEV_OPENROUTER_KEY?.trim() || relayKey(),
  };
}

export interface Decision {
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
  model: string;
  ms: number;
  meta: SystemOneResult["meta"];
  raw: SystemOneResult["raw"];
}

let client: JevClient | undefined;
const jev = () => (client ??= new JevClient(jevClientOptions()));

export async function decide(
  source: string,
  state: State,
  questions: Questions,
  extra: Record<string, unknown> = {},
  opts: { signal?: AbortSignal } = {},
): Promise<Decision> {
  validateQuestions(questions);
  const started = performance.now();
  const result = await jev().systemOne(state, questions, { signal: opts.signal });
  const out: Decision = {
    answers: result.answers,
    usage: result.usage as Decision["usage"],
    model: result.model,
    ms: Math.round(performance.now() - started),
    meta: result.meta,
    raw: result.raw,
  };
  process.stderr.write(
    `JEV_EVENT ${JSON.stringify({ kind: "jev", at: Date.now(), source, answers: out.answers, model: out.model, ms: out.ms, meta: out.meta, ...extra })}\n`,
  );
  return out;
}

/** Race work against a timer: a Jev outage must not hold a gated command for the client's 30s retry ladder. */
export function withGuardTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms = 5_000,
): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`guard unavailable: timed out after ${ms} ms`));
      ac.abort();
    }, ms);
  });
  return Promise.race([work(ac.signal), expired]).finally(() => clearTimeout(timer));
}
