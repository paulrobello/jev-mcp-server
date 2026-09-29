/**
 * MockJev — a deterministic, offline stand-in for the real System One endpoint.
 *
 * It exists so every level in this codebase runs (and its tests pass) without an
 * API key. It mimics the exact wire contract: typed answers, probability
 * distributions that sum to 1, legends on scores, and confidence derived from
 * how peaked the distribution is.
 *
 * How it decides: token overlap between the flattened state and each option /
 * level / criteria description, run through a softmax. A `command` field in
 * the state is expanded first into the plain-English meaning of its words and
 * flags, so shell evidence scores the way a reader would read it. It is a
 * stand-in for *shape*, not for intelligence — with a real key, the same code
 * paths hit https://openrouter.ai/api/alpha/decisions and nothing else changes.
 */
import type {
  Answer,
  ChoiceQuestion,
  NoulQuestion,
  ScoreQuestion,
  State,
  SystemOneRequest,
  SystemOneResponse,
} from "./types.ts";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "without",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "done",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "by",
  "from",
  "into",
  "about",
  "against",
  "between",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "too",
  "very",
  "s",
  "t",
  "can",
  "will",
  "just",
  "don",
  "should",
  "now",
  "d",
  "ll",
  "m",
  "o",
  "re",
  "ve",
  "y",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "what",
  "which",
  "who",
  "whom",
  "am",
  "has",
  "have",
  "had",
  "having",
  "message",
  "text",
  "given",
]);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  // "delete" and "deletes" must land on the same stem, or inflections never overlap.
  if (t.length > 3 && t.endsWith("e")) return t.slice(0, -1);
  return t;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[`_*#>/\[\]{}()"',.;:!?\\-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
      .map(stem),
  );
}

/** Flatten any state shape into text the overlap engine can read. */
export function flattenState(state: State): string {
  if (typeof state === "string") return state;
  return JSON.stringify(state, null, 2);
}

function softmax(values: number[], temperature = 0.6): number[] {
  if (values.every((v) => v === 0)) {
    return values.map(() => 1 / values.length);
  }
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp((v - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** Affinity: how many meaningful tokens the state shares with a description, weighted by rarity-free overlap. */
function affinity(stateTokens: Set<string>, description: string): number {
  const descTokens = tokenize(description);
  let shared = 0;
  for (const t of descTokens) if (stateTokens.has(t)) shared++;
  return shared;
}

function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Plain-English meaning of common shell words, so a `command` field carries
 * the evidence a reader would see in it: `ls` lists and reads, `rm` deletes.
 * A flag counts as its word once dashes strip ("-rf" -> "rf"). Unmapped words
 * stay just themselves.
 */
const COMMAND_WORDS: Record<string, string> = {
  ls: "list read files",
  dir: "list read files",
  cat: "read file",
  less: "read file",
  head: "read file",
  tail: "read file",
  grep: "search read",
  rg: "search read",
  find: "search files",
  wc: "count read",
  pwd: "print directory",
  echo: "print",
  which: "locate",
  diff: "compare read",
  stat: "read status",
  rm: "delete remove files",
  rmdir: "delete remove directory",
  unlink: "delete remove file",
  rf: "recursive force",
  f: "force",
  force: "force",
  mv: "move rename",
  cp: "copy",
  mkdir: "create directory",
  touch: "create file",
  install: "install",
  push: "push upload",
  pull: "pull download",
  reset: "reset",
  checkout: "switch restore",
  drop: "delete drop data",
  truncate: "delete drop data",
  purge: "delete purge",
  deploy: "deploy publish",
  chmod: "change permissions",
  chown: "change ownership",
  curl: "fetch network",
  wget: "download network",
};

/** Expand a shell command into the plain-English evidence of what its words and flags do. */
function commandEvidence(command: string): string {
  const glosses: string[] = [];
  for (const word of command.split(/\s+/)) {
    const gloss = COMMAND_WORDS[word.replace(/^-+/, "")];
    if (gloss) glosses.push(gloss);
  }
  return glosses.join(" ");
}

function noulAnswer(q: NoulQuestion, stateTokens: Set<string>): Answer {
  // Evidence comes only from the criteria describing what yes and no look
  // like. The question's own wording is not evidence: it shares tokens with
  // the state's field names ("command", "cwd") and fabricates a yes.
  const yes = affinity(stateTokens, q.criteria?.true ?? "");
  const no = affinity(stateTokens, q.criteria?.false ?? "");
  // Smoothed signal in [-1, 1]; logistic to [0, 1]. No signal -> 0.5.
  const k = 2.5;
  const signal = (yes - no) / (yes + no + k);
  const p = 1 / (1 + Math.exp(-4 * signal));
  return { type: "noul", noul: round(p) };
}

function choiceAnswer(q: ChoiceQuestion, stateTokens: Set<string>): Answer {
  const entries = Object.entries(q.criteria);
  const affinities = entries.map(([option, desc]) => {
    const keyText = option.replace(/_/g, " ");
    return affinity(stateTokens, keyText) * 1.5 + affinity(stateTokens, desc ?? "") * 1.0;
  });
  const probs = softmax(affinities);
  const probabilities: Record<string, number> = {};
  entries.forEach(([option], i) => (probabilities[option] = round(probs[i])));
  let best = 0;
  entries.forEach((_, i) => {
    if (probs[i] > probs[best]) best = i;
  });
  return {
    type: "choice",
    choice: entries[best][0],
    probabilities,
    confidence: round(probs[best]),
  };
}

function scoreAnswer(q: ScoreQuestion, stateTokens: Set<string>): Answer {
  const affinities = q.criteria.map((level) => affinity(stateTokens, level) + 1e-9);
  const probs = softmax(affinities);
  const legend: Record<string, string> = {};
  q.criteria.forEach((level, i) => (legend[String(i)] = level));
  const probabilities: Record<string, number> = {};
  q.criteria.forEach((_, i) => (probabilities[String(i)] = round(probs[i])));
  const scoreValue = probs.reduce((acc, p, i) => acc + p * i, 0);
  const confidence = Math.max(...probs);
  return {
    type: "score",
    score: round(scoreValue, 2),
    legend,
    probabilities,
    confidence: round(confidence),
  };
}

export class MockJev {
  readonly model = "jev-1.13.0-mock";

  systemOne(req: SystemOneRequest): SystemOneResponse {
    const stateText = flattenState(req.state);
    // A `command` field is shell evidence: score what its words and flags do,
    // not only how they are spelled.
    const command =
      typeof req.state === "object" &&
      req.state !== null &&
      !Array.isArray(req.state) &&
      typeof (req.state as Record<string, unknown>).command === "string"
        ? commandEvidence((req.state as Record<string, unknown>).command as string)
        : "";
    const stateTokens = tokenize(command ? `${stateText} ${command}` : stateText);
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (q.type === "noul") answers[id] = noulAnswer(q, stateTokens);
      else if (q.type === "choice") answers[id] = choiceAnswer(q, stateTokens);
      else answers[id] = scoreAnswer(q, stateTokens);
    }
    const usage = {
      input_tokens:
        Math.ceil(flattenState(req.state).length / 4) + 20 * Object.keys(req.questions).length,
      output_tokens: 20 * Object.keys(req.questions).length,
    };
    return { model: this.model, answers, usage };
  }
}
