/**
 * Level 6, option B: write gate.
 * Before any write or edit: paths are checked in code, content is judged by Jev. Outside the repo blocks without a call. Inside, one call asks whether the file or its content holds credentials.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { jev } from "../../core/client.ts";
import { choice, noul } from "../../core/helpers.ts";
import type { ChoiceAnswer, NoulAnswer, Questions, State } from "../../core/types.ts";
import type { Decide } from "../../decide.ts";
import type { GateDecision } from "./bash-gate.ts";

export const WRITE_QUESTIONS = {
  kind: choice("What kind of file is `path`, given `content`?", {
    source_code: "Application code, tests, scripts",
    config: "Settings, build config, CI, package manifests",
    secrets: "Credentials, API keys, tokens, private keys, or a file whose job is to hold them",
    docs: "Markdown, notes, licenses, changelogs",
    data: "Fixtures, migrations, seeds, exports",
  }),
  contains_secret: noul("Does `content` contain a real credential, not a placeholder?", {
    true: "A key, token, password, or connection string with what looks like a real value",
    false: "Placeholders like replace-me or xxx, empty values, or no credentials at all",
  }),
};

export interface WriteGateAnswers {
  kind: ChoiceAnswer;
  contains_secret: NoulAnswer;
}

export const WRITE_THRESHOLDS = { secret: 0.7 };

/** Resolve symlinks; for a not-yet-existing write target, resolve its deepest existing ancestor. */
function realpathish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

/** Paths stay in code: anything that resolves outside the repo is blocked before Jev is asked. `~` expands and symlinks resolve, so neither can pose as inside. */
export function insideRepo(path: string, repo: string): boolean {
  const tilde = path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
  const root = realpathish(repo);
  const target = realpathish(isAbsolute(tilde) ? tilde : resolve(root, tilde));
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Deterministic credential patterns. The scan sees the FULL content; truncation only limits what Jev is asked. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-(or-v1-)?[A-Za-z0-9_-]{20,}/, "API key"],
  [/AKIA[0-9A-Z]{16}/, "AWS key"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];

/** Returns the kind of the first credential-looking string, or null. No Jev call needed for these. */
export function findSecret(content: string): string | null {
  for (const [pattern, kind] of SECRET_PATTERNS) if (pattern.test(content)) return kind;
  return null;
}

export function gateWrite(
  a: WriteGateAnswers,
  secretFloor = WRITE_THRESHOLDS.secret,
): GateDecision {
  if (a.contains_secret.noul >= secretFloor) {
    return {
      block: true,
      reason: `contains a credential (${a.contains_secret.noul.toFixed(2)}): write it to an ignored .env or a secret store, not the repo`,
    };
  }
  if (a.kind.choice === "secrets" && a.kind.confidence >= 0.8) {
    return {
      block: true,
      reason: `a secrets file (${a.kind.confidence.toFixed(2)}): keep credentials out of the repo`,
    };
  }
  return {
    block: false,
    reason: `${a.kind.choice} (${a.kind.confidence.toFixed(2)}), secret ${a.contains_secret.noul.toFixed(2)}`,
  };
}

/** B: code decides on the path and the obvious secrets, Jev on the rest of the content. Content is trimmed for the call, but the pattern scan sees all of it. */
export async function gateWriteCall(
  path: string,
  content: string,
  repo: string,
  decide: Decide = (s, q) => jev.systemOne(s, q),
): Promise<GateDecision> {
  const secret = findSecret(content);
  if (secret)
    return {
      block: true,
      reason: `contains a ${secret.toLowerCase()} (pattern match, no call needed)`,
    };
  if (!insideRepo(path, repo)) return { block: true, reason: `outside the repo: ${path}` };
  const state: State = {
    path,
    content: content.length > 4000 ? content.slice(0, 4000) + "\n…" : content,
  };
  const { answers } = await decide(state, WRITE_QUESTIONS as Questions);
  return gateWrite(answers as unknown as WriteGateAnswers);
}
