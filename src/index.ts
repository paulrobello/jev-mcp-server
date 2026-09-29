/**
 * jev-mcp-server — the Jev decision tools as MCP tools for Claude Code.
 *
 * Six tools, ported one-to-one from the ten-levels-of-jev levels 8-10 extensions:
 *   ask_jev / ask_jev_files / pick_first_file / ask_jev_file_bool / _choice / _score
 * Files are read by code and judged by Jev; nothing enters the agent's context.
 * Claude Code has no pi hooks here, so ask_jev's `command` runs through the level 6
 * bash gate inside the tool (fail closed after ~5s) instead of a harness hook.
 *
 * The `src/jev/` tree is vendored from ten-levels-of-jev (apps/ten-levels, commit
 * 2b584a5) — re-copy from there to update. Run: bun src/index.ts (stdio).
 */
import { exec } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parseQuestions } from "./jev/decide.ts";
import { BLOCK_NOTICE, gateBashCommand } from "./jev/levels/level06/index.ts";
import {
  askFileBool,
  askFileChoice,
  askFileScore,
  type FileStateError,
} from "./jev/levels/level08/index.ts";
import { askFiles, pickFirstFile } from "./jev/levels/level09/index.ts";
import { AskStateError, assembleState, type CommandOutput } from "./jev/levels/level10/index.ts";
import { decide, withGuardTimeout } from "./jev.ts";

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;

const WHEN =
  "Use this for a judgment about what a file does or contains, without reading it into your context. " +
  "Write the question against `content`, which is the file's text. Use the read tool instead when you need the code itself, to edit or quote it. " +
  "Exact lookups, does this string appear, how many lines, belong to grep, not here.";

const QUESTION_SCHEMA =
  "questions_json is a JSON object keyed by question id. Three types. " +
  'noul: {"type":"noul","instructions":"Does `content` ...?","criteria":{"true":"...","false":"..."}} returns a probability of yes. ' +
  'choice: {"type":"choice","instructions":"Which ... is `content`?","criteria":{"option_a":"when it applies","option_b":"...","other":"none of the above"}} returns one of your keys plus confidence, up to 255 options. ' +
  'score: {"type":"score","instructions":"How ... is `content`?","criteria":["lowest situation","...","highest situation"]} returns a position on your levels, two to ten of them. ' +
  "Write every question against `content`, the file's text; `path` is also in the state. Ask every question you might need in one block, it is one call per file either way.";

/**
 * Annotated so registerTool's generic resolves over the plain compat record instead of the
 * zod literal — with zod 3.25's dual v3/v4 types, inferring the literal sends TS 5.9 into
 * TS2589. Handlers take `any` params for the same reason; runtime validation is unchanged
 * (the SDK parses against the shape, and the level functions validate their own inputs).
 */
const shape = (s: object): ZodRawShapeCompat => s as ZodRawShapeCompat;

const ok = (payload: object): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload as Record<string, unknown>,
});
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

/** Run a command for ask_jev's state. Output is captured, never streamed to the agent. */
function runCommand(command: string, cwd: string): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_CHARS * 4,
        env: { ...process.env, CI: "1" },
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number" && !stderr && !stdout)
          return reject(err);
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? null
              : 0;
        resolve({
          command,
          exit_code: code,
          stdout: String(stdout).slice(0, MAX_OUTPUT_CHARS),
          stderr: String(stderr).slice(0, MAX_OUTPUT_CHARS),
        });
      },
    );
  });
}

/** The bash gate ask_jev commands pass through: irreversible or destructive commands refuse. */
async function gatedRun(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandOutput> {
  const gate = await withGuardTimeout((s) =>
    gateBashCommand(command, cwd, (st, q) =>
      decide("ask_jev command gate", st, q, {}, { signal: s ?? signal }),
    ),
  );
  if (gate.block) {
    throw new AskStateError(
      `ask_jev: the command was refused by the bash gate: ${gate.reason}. ${BLOCK_NOTICE} ask_jev commands should only read.`,
    );
  }
  return runCommand(command, cwd);
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "jev-mcp-server", version: "1.0.0" });
  const cwd = () => process.cwd();
  const R: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  /**
   * registerTool's generics (ShapeOutput over the zod v3/v4 compat union) exceed TS 5.9's
   * instantiation depth at every call site; this adapter erases them once at the boundary.
   * Runtime behavior is unchanged — the SDK still parses arguments against the shape.
   */
  type ToolConfig = {
    title?: string;
    description?: string;
    inputSchema?: ZodRawShapeCompat;
    annotations?: ToolAnnotations;
  };
  type Cb = (args: Record<string, any>, extra: { signal?: AbortSignal }) => Promise<CallToolResult>;
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: ToolConfig,
    cb: Cb,
  ) => void;

  register(
    "ask_jev",
    {
      title: "Ask Jev",
      description:
        "One Jev call over an assembled situation: your own short state, up to 20 files code reads for you, and/or one gated command's output. " +
        "Returns typed answers (noul probability, choice, score) without any of the content entering your context. " +
        "Files over Jev's budget are skipped with a reason, never truncated; an over-budget situation is refused with a suggested split. " +
        "Prefer this over reasoning out a classification, risk score, or yes/no with confidence yourself.",
      inputSchema: shape({
        questions_json: z
          .string()
          .describe("The question block, a JSON object keyed by question id"),
        state: z
          .string()
          .optional()
          .describe(
            "Your own state: plain text, or a JSON object as a string. Short. Not for pasting files or output.",
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe('Files or globs for code to read into files["path"]. Up to 20 files.'),
        command: z
          .string()
          .optional()
          .describe(
            "A command for code to run in the repo; its result goes into output. Read-only commands; gated.",
          ),
      }),
      annotations: R,
    },
    async (p: any, extra: any): Promise<CallToolResult> => {
      try {
        const questions = parseQuestions(p.questions_json);
        const { state, summary } = await assembleState(
          { state: p.state, paths: p.paths, command: p.command },
          cwd(),
          (c, d) => gatedRun(c, d, extra.signal),
        );
        const result = await decide("ask_jev", state, questions, { summary });
        return ok({
          answers: result.answers,
          state_summary: summary,
          usage: { ...result.usage, cost: result.meta.cost.amount ?? undefined },
          cost_source: result.meta.cost.source,
          model: result.model,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  register(
    "ask_jev_files",
    {
      title: "Ask Jev about many files",
      description:
        "Ask the same typed questions of many files at once without reading any of them. Code expands globs and directories, " +
        "drops node_modules, .git, binaries, and files over the budget, caps the list at 255, then makes one Jev call per file in parallel. " +
        `Returns { results: [{ path, answers }], skipped: [{ path, reason }], calls }. ${QUESTION_SCHEMA} ` +
        "Use read when you need a file's code; use grep for exact strings.",
      inputSchema: shape({
        paths_or_globs: z
          .array(z.string())
          .describe(
            'Files, directories, or globs, relative to the repo, for example ["src/**/*.ts"] or ["src/http"]',
          ),
        questions_json: z.string().describe("The question block as a JSON string"),
        recursive: z
          .boolean()
          .optional()
          .describe("For directories: include every file below them. Default false."),
      }),
      annotations: R,
    },
    async (p: any, extra: any): Promise<CallToolResult> => {
      try {
        const result = await askFiles(p.paths_or_globs, p.questions_json, cwd(), {
          recursive: p.recursive ?? false,
          decide: (s, q) =>
            decide(
              "ask_jev_files",
              s,
              q,
              { path: (s as { path?: string }).path },
              { signal: extra.signal },
            ),
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  register(
    "pick_first_file",
    {
      title: "Pick the file to open first",
      description:
        "After ask_jev_files, choose which of a list of files to open first for a goal. One Choice keyed by path, so the pick is always a real file. " +
        "Returns { path | null, confidence, probabilities }. Pass a short note per path if you have one, for example the answers you already got.",
      inputSchema: shape({
        question: z
          .string()
          .describe(
            "The goal, for example: Which file should I open first to fix the proration bug?",
          ),
        candidates: z
          .array(z.object({ path: z.string(), note: z.string().optional() }))
          .describe("Paths, with an optional one line note each"),
      }),
      annotations: R,
    },
    async (p: any, extra: any): Promise<CallToolResult> => {
      try {
        return ok(
          await pickFirstFile(p.question, p.candidates, (s, q) =>
            decide("pick_first_file", s, q, {}, { signal: extra.signal }),
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  register(
    "ask_jev_file_bool",
    {
      title: "Ask Jev about a file, yes or no",
      description: `Yes or no about one file. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. ${WHEN}`,
      inputSchema: shape({
        path: z.string().describe("File path, relative to the repo"),
        question: z
          .string()
          .describe(
            "A yes or no question about `content`, for example: Does `content` validate authentication tokens?",
          ),
        yes: z.string().optional().describe("What counts as yes"),
        no: z.string().optional().describe("What counts as no"),
      }),
      annotations: R,
    },
    async (p: any, extra: any): Promise<CallToolResult> => {
      try {
        return ok(
          await askFileBool(p.path, p.question, cwd(), { yes: p.yes, no: p.no }, (s, q) =>
            decide("ask_jev_file_bool", s, q, { path: p.path }, { signal: extra.signal }),
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  register(
    "ask_jev_file_choice",
    {
      title: "Ask Jev about a file, pick one",
      description: `Pick one option about one file. Returns { path, choice, confidence, probabilities }. The choice is always one of your options; an "other" option is added if you leave none. ${WHEN}`,
      inputSchema: shape({
        path: z.string().describe("File path, relative to the repo"),
        question: z.string().describe("The question, for example: Which layer is `content`?"),
        options: z
          .record(z.string())
          .describe("Option name to a one line description of when it applies. Up to 255."),
      }),
      annotations: R,
    },
    async (p: any, extra: any): Promise<CallToolResult> => {
      try {
        return ok(
          await askFileChoice(p.path, p.question, p.options, cwd(), (s, q) =>
            decide("ask_jev_file_choice", s, q, { path: p.path }, { signal: extra.signal }),
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  register(
    "ask_jev_file_score",
    {
      title: "Ask Jev about a file, on a scale",
      description: `A position on a scale you define, about one file. Returns { path, score, top, nearest, confidence, legend }. Levels are ordered low to high, two to ten of them, each a described situation. ${WHEN}`,
      inputSchema: shape({
        path: z.string().describe("File path, relative to the repo"),
        question: z
          .string()
          .describe("The question, for example: How risky is a refactor of `content`?"),
        levels: z
          .array(z.string())
          .min(2)
          .max(10)
          .describe(
            "Ordered low to high, each level a situation, for example: Isolated and well tested",
          ),
      }),
      annotations: R,
    },
    async (p: any, extra: any): Promise<CallToolResult> => {
      try {
        return ok(
          await askFileScore(p.path, p.question, p.levels, cwd(), (s, q) =>
            decide("ask_jev_file_score", s, q, { path: p.path }, { signal: extra.signal }),
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

if (import.meta.main) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("jev-mcp-server: ready (stdio)\n");
}
