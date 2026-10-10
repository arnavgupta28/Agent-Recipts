// End-to-end tests against the built dist/ bundles. Run: npm run build && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist/cli.js");
const { NODE_TEST_CONTEXT: _ctx, ...CLEAN_ENV } = process.env;
const HOOK = join(ROOT, "dist/hook.js");
const cli = (...args) => execFileSync("node", [CLI, ...args], { encoding: "utf8", env: CLEAN_ENV });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const testsPass = (cwd) => spawnSync("node", ["--test"], { cwd, encoding: "utf8", env: CLEAN_ENV }).status === 0;
const receiptOf = (dir) => {
  const d = join(dir, ".agent-receipts");
  return JSON.parse(readFileSync(join(d, readdirSync(d).find((f) => f.endsWith(".receipt"))), "utf8"));
};

function simulated() {
  const dir = join(mkdtempSync(join(tmpdir(), "ar-test-")), "repo");
  cli("simulate", "--no-view", "--dir", dir);
  return dir;
}

test("simulated multi-agent run produces a correct receipt", () => {
  const dir = simulated();
  const r = receiptOf(dir);
  assert.equal(r.version, 1);
  assert.deepEqual(r.agents.map((a) => a.id), ["main", "agent-refactor", "agent-tests"]);
  assert.equal(r.stats.steps, 10);
  assert.equal(r.stats.failures, 1);
  const failed = r.steps.find((s) => s.failed);
  assert.equal(failed.n, 9);
  assert.equal(failed.agent, "agent-tests");
  assert.equal(failed.exitCode, 1);
  const buggy = r.steps.find((s) => s.n === 8);
  assert.equal(buggy.agent, "agent-refactor");
  assert.match(buggy.files[0].diff, /return w\.count < limit;/);
  assert.deepEqual(r.modules.map((m) => m.path).sort(), ["src/api", "src/utils", "test"]);
  assert.ok(readFileSync(join(dir, ".git/info/exclude"), "utf8").includes(".agent-receipts/"));
});

test("recording never touches HEAD, branch or the real index", () => {
  const dir = simulated();
  assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1");
  assert.equal(git(dir, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(dir, "diff", "--cached", "--name-only"), "");
  assert.equal(git(dir, "stash", "list"), "");
  assert.ok(Number(git(dir, "for-each-ref", "--count=100", "refs/agent-receipts").split("\n").length) >= 5);
});

test("rewind to last passing run fixes tests, and undo restores the bug", () => {
  const dir = simulated();
  const r = receiptOf(dir);
  assert.equal(testsPass(dir), false);
  const good = r.steps.find((s) => s.n === 6);
  const out = cli("rewind", "--to", good.snapshot, "--cwd", dir);
  assert.equal(testsPass(dir), true);
  const safety = out.match(/rewind --to ([0-9a-f]+)/)[1];
  cli("rewind", "--to", safety, "--cwd", dir);
  assert.equal(testsPass(dir), false);
  const after = receiptOf(dir);
  assert.equal(after.rewinds.length, 2);
  assert.equal(after.rewinds[0].toStep, 6);
});

test("rewind to baseline removes files agents created, but never touches ignored files", () => {
  const dir = simulated();
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "x", "--allow-empty");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  const r = receiptOf(dir);
  cli("rewind", "--to", r.baseline, "--cwd", dir);
  assert.equal(existsSync(join(dir, "src/api/limiter.js")), false);
  assert.equal(existsSync(join(dir, "test/limiter.test.js")), false);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "SECRET=1\n");
});

test("rewind rejects commits that are not receipt snapshots", () => {
  const dir = simulated();
  const head = git(dir, "rev-parse", "HEAD");
  const res = spawnSync("node", [CLI, "rewind", "--to", head, "--cwd", dir], { encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not an Agent Receipts snapshot/);
});

test("hook entry point records from stdin and never fails the agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-hook-"));
  git(dir, "init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.txt"), "one\n");
  const run = (payload) => spawnSync("node", [HOOK], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8" });
  const base = { session_id: "s-1", cwd: dir, model: "gpt-6.1-sol", permission_mode: "default", transcript_path: null, turn_id: "t1" };
  assert.equal(run({ ...base, hook_event_name: "SessionStart", source: "startup" }).status, 0);
  writeFileSync(join(dir, "src/a.txt"), "two\n");
  const r = run({ ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "c1", tool_input: { command: "*** Begin Patch\n*** Update File: src/a.txt\n*** End Patch" }, tool_response: { output: "ok", api_key: "sk-abcdefghijklmnopqrstuvwxyz" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const events = readdirSync(join(dir, ".git/agent-receipts/s-1/events"));
  assert.equal(events.length, 2);
  const step = events.map((f) => JSON.parse(readFileSync(join(dir, ".git/agent-receipts/s-1/events", f), "utf8"))).find((e) => e.kind === "step");
  assert.ok(step.snapshot);
  assert.doesNotMatch(JSON.stringify(step.output), /sk-abcdefghijklmnop/);
  // Garbage and non-repo payloads must still exit 0.
  assert.equal(run("not json").status, 0);
  assert.equal(run({ ...base, cwd: tmpdir(), hook_event_name: "PostToolUse" }).status, 0);
  assert.equal(run({ ...base, hook_event_name: "Stop", last_assistant_message: "done" }).status, 0);
  assert.ok(readdirSync(join(dir, ".agent-receipts")).some((f) => f.endsWith(".receipt")));
});

test("PreToolUse shows a step as running until PostToolUse arrives", () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-live-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "1\n");
  const run = (p) => spawnSync("node", [HOOK], { input: JSON.stringify(p), encoding: "utf8" });
  const base = { session_id: "live-1", cwd: dir, model: "m", permission_mode: "default", transcript_path: null, turn_id: "t1" };
  run({ ...base, hook_event_name: "SessionStart", source: "startup" });
  run({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "npm test" }, agent_id: "a-tests", agent_type: "tests" });
  const exportJson = () => {
    const path = cli("export", "--cwd", dir).trim();
    return JSON.parse(readFileSync(path, "utf8"));
  };
  let r = exportJson();
  assert.equal(r.status, "running");
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].agent, "a-tests");
  assert.equal(r.pending[0].title, "npm test");
  run({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "npm test" }, tool_response: { output: "ok", exit_code: 0 }, agent_id: "a-tests", agent_type: "tests" });
  r = exportJson();
  assert.equal(r.pending.length, 0);
  assert.equal(r.steps.length, 1);
  run({ ...base, hook_event_name: "Stop", last_assistant_message: "done" });
  assert.equal(exportJson().status, "done");
});
