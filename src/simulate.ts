// Builds a demo repo and replays a realistic multi-agent Codex session through
// the real recorder: a main agent splits work between a "refactor" and a "tests"
// subagent, and the refactor agent introduces an off-by-one bug that fails a test.
// Test runs are real (`node --test`), so outputs and exit codes are genuine.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { record, type HookPayload } from "./recorder.js";
import { exportReceipt } from "./receipt.js";
import { repoInfo } from "./git.js";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop-api", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# shop-api\n\nTiny demo API used to show Agent Receipts.\n\nRun tests with `npm test`.\n",
  "src/api/routes.js": `import { getProducts } from "../catalog/products.js";

export function handle(req) {
  if (req.path === "/products") return { status: 200, body: getProducts() };
  return { status: 404, body: { error: "not found" } };
}
`,
  "src/catalog/products.js": `const PRODUCTS = [
  { id: 1, name: "Keyboard", price: 4999 },
  { id: 2, name: "Mouse", price: 1499 },
];

export function getProducts() {
  return PRODUCTS;
}
`,
  "src/utils/log.js": `export function log(...args) {
  if (process.env.DEBUG) console.log(...args);
}
`,
  "test/routes.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/api/routes.js";

test("lists products", () => {
  assert.equal(handle({ path: "/products" }).status, 200);
});
`,
};

const CLOCK = `export function nowMs() {
  return Date.now();
}
`;

const LIMITER_GOOD = `import { nowMs } from "../utils/clock.js";

// Fixed-window rate limiter: at most \`limit\` requests per \`windowMs\` per key.
export function createLimiter({ limit, windowMs, clock = nowMs }) {
  const windows = new Map();
  return function allow(key) {
    const now = clock();
    const w = windows.get(key);
    if (!w || now - w.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  };
}
`;

const LIMITER_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../src/api/limiter.js";

test("allows exactly \`limit\` requests per window", () => {
  let t = 0;
  const allow = createLimiter({ limit: 3, windowMs: 1000, clock: () => t });
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), false);
});

test("resets after the window", () => {
  let t = 0;
  const allow = createLimiter({ limit: 1, windowMs: 1000, clock: () => t });
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), false);
  t = 1000;
  assert.equal(allow("ip"), true);
});
`;

// "Optimisation" by the refactor agent that introduces an off-by-one bug.
const LIMITER_BUGGY = LIMITER_GOOD.replace("if (w.count >= limit) return false;\n    w.count += 1;\n    return true;", "w.count += 1;\n    // Inline the check to save a branch.\n    return w.count < limit;");

const ROUTES_LIMITED = `import { getProducts } from "../catalog/products.js";
import { createLimiter } from "./limiter.js";
import { log } from "../utils/log.js";

const allow = createLimiter({ limit: 100, windowMs: 60_000 });

export function handle(req) {
  if (!allow(req.ip ?? "anon")) {
    log("rate limited", req.ip);
    return { status: 429, body: { error: "too many requests" } };
  }
  if (req.path === "/products") return { status: 200, body: getProducts() };
  return { status: 404, body: { error: "not found" } };
}
`;

function patchText(kind: "Add" | "Update", path: string, content: string): string {
  const body = content.split("\n").map((l) => (kind === "Add" ? `+${l}` : ` ${l}`)).join("\n");
  return `*** Begin Patch\n*** ${kind} File: ${path}\n${body}\n*** End Patch`;
}

export type SimulateOptions = { dir: string; fresh?: boolean; delayMs?: number; pathPrefix?: string; log?: (msg: string) => void; onReady?: (info: { dir: string; sessionId: string }) => void | Promise<void> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function simulate(opts: SimulateOptions): Promise<{ receiptPath: string; sessionId: string; dir: string }> {
  const dir = opts.dir;
  const say = opts.log ?? (() => {});
  const delay = opts.delayMs ?? 0;
  if (opts.fresh !== false && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const write = (p: string, c: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  for (const [p, c] of Object.entries(FILES)) write(p, c);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "add", "-A");
  g("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-q", "-m", "Initial shop-api");
  say(`Demo repo ready at ${dir}`);

  const session = randomUUID();
  const model = "gpt-6.1-sol";
  const turn = "turn-1";
  const base = (event: string, extra: Partial<HookPayload> = {}): HookPayload => ({
    hook_event_name: event,
    session_id: session,
    cwd: dir,
    model,
    permission_mode: "acceptEdits",
    transcript_path: null,
    turn_id: turn,
    ...extra,
  });
  const agent = (id: string, type: string) => ({ agent_id: id, agent_type: type });
  /** PreToolUse → (pause, so a live viewer shows it running) → do the work → PostToolUse. */
  const tool = async (name: string, input: unknown, work: () => unknown, who: Partial<HookPayload> = {}, workMs = delay) => {
    const id = `call_${randomUUID().slice(0, 8)}`;
    record(base("PreToolUse", { tool_name: name, tool_use_id: id, tool_input: input, ...who }));
    if (workMs) await sleep(workMs);
    const response = work();
    record(base("PostToolUse", { tool_name: name, tool_use_id: id, tool_input: input, tool_response: response, ...who }));
    if (delay) await sleep(Math.round(delay / 3));
    return response;
  };
  const edit = (kind: "Add" | "Update", path: string, content: string, who: Partial<HookPayload> = {}) =>
    tool("apply_patch", { command: patchText(kind, path, content) }, () => {
      write(path, content);
      return { output: `Success. Updated the following files:\nM ${path}`, exit_code: 0 };
    }, who);
  const shell = async (cmd: string, who: Partial<HookPayload> = {}, workMs = delay) => {
    const res = (await tool("Bash", { command: cmd }, () => {
      // Drop NODE_TEST_CONTEXT so nested `node --test` runs behave like a real terminal.
      const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
      const PATH = opts.pathPrefix ? `${opts.pathPrefix}:${env.PATH ?? ""}` : env.PATH;
      const r = spawnSync("bash", ["-c", cmd], { cwd: dir, encoding: "utf8", env: { ...env, PATH, NODE_NO_WARNINGS: "1" } });
      return { output: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-3000), exit_code: r.status ?? 1 };
    }, who, workMs)) as { exit_code: number };
    return res.exit_code;
  };
  const event = async (name: string, extra: Partial<HookPayload>) => {
    record(base(name, extra));
    if (delay) await sleep(Math.round(delay / 2));
  };

  const REFACTOR = agent("agent-refactor", "refactor");
  const TESTS = agent("agent-tests", "tests");

  record(base("SessionStart", { source: "startup" }));
  await opts.onReady?.({ dir, sessionId: session });
  await event("UserPromptSubmit", { prompt: "Add per-IP rate limiting to the shop API and cover it with tests. Use a refactor agent for the code and a tests agent for the tests." });
  await shell("grep -rn \"export function\" src | head -20");
  await shell("npm test --silent");
  await event("SubagentStart", REFACTOR);
  await event("SubagentStart", TESTS);
  await edit("Add", "src/utils/clock.js", CLOCK, REFACTOR);
  await edit("Add", "src/api/limiter.js", LIMITER_GOOD, REFACTOR);
  await edit("Add", "test/limiter.test.js", LIMITER_TEST, TESTS);
  const firstRun = await shell("node --test", TESTS, delay * 2);
  say(`First test run exit code: ${firstRun}`);
  await edit("Update", "src/api/routes.js", ROUTES_LIMITED, REFACTOR);
  await edit("Update", "src/api/limiter.js", LIMITER_BUGGY, REFACTOR);
  await event("SubagentStop", { ...REFACTOR, last_assistant_message: "Wired the limiter into routes and inlined the limit check to save a branch." });
  const secondRun = await shell("node --test", TESTS, delay * 2);
  say(`Second test run exit code: ${secondRun}`);
  await event("SubagentStop", { ...TESTS, last_assistant_message: "Limiter tests fail: the 3rd request in a window is rejected (expected allowed)." });
  await shell("git diff --stat");
  const stop = record(base("Stop", { last_assistant_message: "Rate limiting is wired in, but limiter tests fail after the refactor agent's inline check. Needs a fix before merging." }));

  const repo = repoInfo(dir)!;
  const receiptPath = stop.receiptPath ?? exportReceipt(repo, session).path;
  say(`Receipt written to ${receiptPath}`);
  return { receiptPath, sessionId: session, dir };
}
