/**
 * Server tests over an in-memory MCP client: the six tools list, and the main
 * paths round-trip on the offline mock backend (SYSTEMONE_BACKEND=mock, no key, no
 * network). ask_systemone's command gate is exercised with a benign command.
 */
process.env.SYSTEMONE_BACKEND = "mock";

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.ts";

const TOOL_NAMES = [
  "ask_systemone",
  "ask_systemone_file_bool",
  "ask_systemone_file_choice",
  "ask_systemone_file_score",
  "ask_systemone_files",
  "pick_first_file",
].sort();

let client: Client;
let fixture: string;

beforeEach(async () => {
  client = new Client({ name: "test", version: "0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverT);
  await client.connect(clientT);
  fixture = mkdtempSync(join(tmpdir(), "systemone-mcp-"));
  writeFileSync(join(fixture, "a.ts"), "export const billing = () => 1;\n");
  writeFileSync(join(fixture, "b.ts"), "export const auth = () => 2;\n");
  writeFileSync(join(fixture, "big.txt"), "x".repeat(300_000));
  mkdirSync(join(fixture, "node_modules"));
  writeFileSync(join(fixture, "node_modules", "dep.ts"), "skipped\n");
  process.chdir(fixture);
});

describe("systemone-mcp-server", () => {
  test("lists the six tools", async () => {
    const { tools } = (await client.listTools()) as unknown as { tools: { name: string }[] };
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
  });

  test("ask_systemone_files answers per path and reports skipped files with reasons", async () => {
    const r = await client.callTool({
      name: "ask_systemone_files",
      arguments: {
        paths_or_globs: ["."],
        questions_json: JSON.stringify({
          u: { type: "noul", instructions: "Does `content` mention billing?" },
        }),
        recursive: false,
      },
    });
    expect(r.isError).toBeFalsy();
    const payload = r.structuredContent as {
      results: { path: string }[];
      calls: number;
      skipped: { path: string; reason: string }[];
    };
    expect(payload.results.map((x) => x.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(payload.calls).toBe(2);
    const reasons = Object.fromEntries(payload.skipped.map((s) => [s.path, s.reason]));
    expect(reasons["big.txt"]).toMatch(/^too large/);
    expect(reasons["node_modules"]).toBe("skipped directory");
  });

  test("ask_systemone assembles state and returns typed answers", async () => {
    const r = await client.callTool({
      name: "ask_systemone",
      arguments: {
        questions_json: JSON.stringify({ u: { type: "noul", instructions: "Is `text` urgent?" } }),
        state: "the deploy failed at 3am",
      },
    });
    expect(r.isError).toBeFalsy();
    const payload = r.structuredContent as {
      answers: Record<string, unknown>;
      state_summary: { tokens: number };
    };
    expect(payload.answers.u).toBeDefined();
    expect(payload.state_summary.tokens).toBeGreaterThan(0);
  });

  test("ask_systemone runs a benign gated command into the state", async () => {
    const r = await client.callTool({
      name: "ask_systemone",
      arguments: {
        questions_json: JSON.stringify({
          u: { type: "noul", instructions: "Is `text` a file listing?" },
        }),
        command: "ls",
      },
    });
    expect(r.isError).toBeFalsy();
    // summary.output is a description of the command, not its body: "ls, exit 0, N tokens".
    const payload = r.structuredContent as { state_summary: { output: string | null } };
    expect(payload.state_summary.output).toMatch(/^ls, exit 0/);
  });

  test("ask_systemone_file_bool answers and a missing file is an actionable error", async () => {
    const good = await client.callTool({
      name: "ask_systemone_file_bool",
      arguments: { path: "a.ts", question: "Does `content` mention billing?", yes: "it does" },
    });
    expect(good.isError).toBeFalsy();
    // The mock's score is word-overlap evidence, not judgment; pin the shape, not the verdict.
    const payload = good.structuredContent as { answer: boolean; noul: number };
    expect(typeof payload.answer).toBe("boolean");
    expect(payload.noul).toBeGreaterThanOrEqual(0);
    expect(payload.noul).toBeLessThanOrEqual(1);

    const bad = await client.callTool({
      name: "ask_systemone_file_bool",
      arguments: { path: "nope.ts", question: "?" },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0].text).toContain("not found");
  });

  test("pick_first_file returns a candidate with confidence", async () => {
    const r = await client.callTool({
      name: "pick_first_file",
      arguments: {
        question: "Which file should I open first to fix billing?",
        candidates: [{ path: "a.ts" }, { path: "b.ts" }],
      },
    });
    expect(r.isError).toBeFalsy();
    const payload = r.structuredContent as { path: string | null; confidence: number };
    expect(["a.ts", "b.ts", null]).toContain(payload.path);
    expect(typeof payload.confidence).toBe("number");
  });

  test("invalid questions_json fails before any file is read", async () => {
    const r = await client.callTool({
      name: "ask_systemone_files",
      arguments: { paths_or_globs: ["."], questions_json: "{nope" },
    });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain("not valid JSON");
  });
});

process.on("exit", () => {
  if (fixture?.startsWith(tmpdir())) rmSync(fixture, { recursive: true, force: true });
});
