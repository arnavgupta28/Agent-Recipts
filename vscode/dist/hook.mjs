#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/hook.ts
import { readFileSync as readFileSync3 } from "node:fs";

// src/git.ts
import { execFileSync } from "node:child_process";
var AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "agent-receipts",
  GIT_AUTHOR_EMAIL: "agent-receipts@localhost",
  GIT_COMMITTER_NAME: "agent-receipts",
  GIT_COMMITTER_EMAIL: "agent-receipts@localhost"
};
function git(cwd, args, opts = {}) {
  const env = { ...process.env, ...AUTHOR_ENV };
  if (opts.index) env.GIT_INDEX_FILE = opts.index;
  env.GIT_TERMINAL_PROMPT = "0";
  return execFileSync("git", args, {
    cwd,
    env,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"]
  }).trimEnd();
}
function tryGit(cwd, args, opts = {}) {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
}
function repoInfo(cwd) {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const gitDirRaw = git(root, ["rev-parse", "--absolute-git-dir"]);
  const branch = tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const head = tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return { root, gitDir: gitDirRaw, name: root.split("/").pop() || root, branch: branch || null, head: head || null };
}
function snapshotTree(root, indexFile, parent, message) {
  withIndexRetry(() => git(root, ["add", "-A", "--", "."], { index: indexFile }));
  const tree = git(root, ["write-tree"], { index: indexFile });
  const args = ["commit-tree", tree, "-m", message];
  if (parent) args.splice(2, 0, "-p", parent);
  const commit = git(root, args);
  return { tree, commit };
}
function withIndexRetry(fn) {
  let lastErr;
  for (let i = 0; i < 20; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err.stderr ?? err);
      if (!msg.includes("index.lock")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + i * 25);
    }
  }
  throw lastErr;
}
function treeOf(root, commit) {
  return git(root, ["rev-parse", `${commit}^{tree}`]);
}
function updateRef(root, ref, commit) {
  git(root, ["update-ref", ref, commit]);
}
function changedFiles(root, from, to) {
  if (treeOf(root, from) === treeOf(root, to)) return [];
  const status = git(root, ["diff", "--name-status", "-M", "--no-color", from, to]);
  const numstat = git(root, ["diff", "--numstat", "-M", "--no-color", from, to]);
  const counts = /* @__PURE__ */ new Map();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("	");
    const p = rest[rest.length - 1];
    counts.set(p, { add: a === "-" ? 0 : Number(a), del: d === "-" ? 0 : Number(d) });
  }
  const out = [];
  for (const line of status.split("\n").filter(Boolean)) {
    const parts = line.split("	");
    const code = parts[0][0];
    const path = parts[parts.length - 1];
    const c = counts.get(path) ?? counts.get(`${parts[1]} => ${path}`) ?? { add: 0, del: 0 };
    out.push({ path, status: code, add: c.add, del: c.del, ...parts.length > 2 ? { oldPath: parts[1] } : {} });
  }
  return out;
}
function fileDiff(root, from, to, path, cap = 2e4) {
  const text = tryGit(root, ["diff", "--no-color", "-U3", from, to, "--", path]) ?? "";
  return text.length > cap ? text.slice(0, cap) + "\n\u2026 diff truncated \u2026" : text;
}

// src/store.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
function safeId(id) {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "unknown";
}
function receiptsDir(repo) {
  return join(repo.gitDir, "agent-receipts");
}
function sessionDir(repo, sessionId) {
  return join(receiptsDir(repo), safeId(sessionId));
}
function refFor(sessionId, eventId) {
  return `refs/agent-receipts/${safeId(sessionId)}/${safeId(eventId)}`;
}
function newEventId() {
  const ns = process.hrtime.bigint() % 1000000n;
  const ms = BigInt(Date.now()) * 1000000n + ns;
  return `${ms.toString().padStart(22, "0")}-${randomBytes(3).toString("hex")}`;
}
function ensureSession(repo, sessionId, init) {
  const dir = sessionDir(repo, sessionId);
  mkdirSync(join(dir, "events"), { recursive: true });
  const metaPath = join(dir, "meta.json");
  if (existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, "utf8"));
  const meta = {
    sessionId,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    repo: { root: repo.root, name: repo.name, branch: repo.branch, head: repo.head },
    ...init
  };
  writeJsonAtomic(metaPath, meta);
  return meta;
}
function readMeta(repo, sessionId) {
  const p = join(sessionDir(repo, sessionId), "meta.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function writeMeta(repo, meta) {
  writeJsonAtomic(join(sessionDir(repo, meta.sessionId), "meta.json"), meta);
}
function writeEvent(repo, ev) {
  writeJsonAtomic(join(sessionDir(repo, ev.sessionId), "events", `${ev.id}.json`), ev);
}
function readEvents(repo, sessionId) {
  const dir = join(sessionDir(repo, sessionId), "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      return null;
    }
  }).filter((e) => e !== null);
}
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}
function logError(repo, err) {
  try {
    const dir = repo ? receiptsDir(repo) : null;
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${err instanceof Error ? err.stack ?? err.message : String(err)}
`;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "errors.log"), line);
    } else {
      process.stderr.write(line);
    }
  } catch {
  }
}

// src/receipt.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var RECEIPT_EXT = ".receipt";
var RECEIPT_DIR = ".agent-receipts";
var GENERIC_ROOTS = /* @__PURE__ */ new Set(["src", "lib", "app", "apps", "packages", "pkg", "internal", "cmd", "services", "modules"]);
function moduleOf(path) {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  if (GENERIC_ROOTS.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}
function str(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}
function commandOf(input) {
  if (input && typeof input === "object") {
    const c = input.command ?? input.cmd;
    if (Array.isArray(c)) return c.map(String).join(" ");
    if (typeof c === "string") return c;
  }
  return typeof input === "string" ? input : null;
}
function patchFiles(input) {
  const text = commandOf(input) ?? str(input);
  const out = [];
  for (const m of text.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/\*\*\* Move to: (.+)/g)) out.push(m[1].trim());
  return [...new Set(out)];
}
function detectFailure(output) {
  if (output && typeof output === "object") {
    const o = output;
    for (const k of ["exit_code", "exitCode", "returncode", "status_code"]) {
      if (typeof o[k] === "number") return { failed: o[k] !== 0, exitCode: o[k] };
    }
    if (o.success === false || o.is_error === true || o.isError === true || typeof o.error === "string" && o.error) return { failed: true, exitCode: null };
  }
  const text = str(output);
  const m = text.match(/(?:Exit code|exit code|exited with code|Process exited with code)[:\s]+(-?\d+)/);
  if (m) return { failed: Number(m[1]) !== 0, exitCode: Number(m[1]) };
  return { failed: false, exitCode: null };
}
function relPath(root, p) {
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}
function stepTitle(tool, input, files, root) {
  if (tool === "apply_patch" || tool === "Edit" || tool === "Write") {
    const names = (files.length ? files : patchFiles(input)).map((f) => relPath(root, f));
    return { kind: "edit", title: names.length ? `Edit ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}` : "Apply patch" };
  }
  const cmd = commandOf(input);
  if (cmd && /bash|shell|exec|command|local_shell/i.test(tool)) return { kind: "command", title: cmd.length > 140 ? cmd.slice(0, 140) + "\u2026" : cmd };
  return { kind: "tool", title: tool };
}
var diffCache = /* @__PURE__ */ new Map();
function stepFiles(root, from, to) {
  const key = `${root}\0${from}..${to}`;
  let files = diffCache.get(key);
  if (!files) {
    files = changedFiles(root, from, to).map((f) => ({ ...f, diff: fileDiff(root, from, to, f.path) }));
    if (diffCache.size > 2e3) diffCache.clear();
    diffCache.set(key, files);
  }
  return files.map((f) => ({ ...f }));
}
var IDLE_MS = 10 * 60 * 1e3;
function buildReceipt(repo, sessionId) {
  const meta = readMeta(repo, sessionId);
  if (!meta) throw new Error(`No recorded session ${sessionId}`);
  const events = readEvents(repo, sessionId);
  const agents = /* @__PURE__ */ new Map();
  agents.set("main", { id: "main", type: "main", parent: null, steps: 0, failures: 0, startedAt: meta.startedAt, stoppedAt: null, lastMessage: null });
  const turns = [];
  const steps = [];
  const rewinds = [];
  let prevSnap = null;
  let lastSnap = null;
  let lastMessage = null;
  const snapToStep = /* @__PURE__ */ new Map();
  const pre = /* @__PURE__ */ new Map();
  for (const ev of events) {
    const agentId = ev.agentId || "main";
    if (ev.kind === "agent-start" || ev.kind === "agent-stop") {
      const a2 = agents.get(agentId) ?? { id: agentId, type: ev.agentType || "subagent", parent: "main", steps: 0, failures: 0, startedAt: null, stoppedAt: null, lastMessage: null };
      if (ev.kind === "agent-start") a2.startedAt = ev.at;
      else {
        a2.stoppedAt = ev.at;
        a2.lastMessage = ev.lastMessage ?? null;
      }
      if (ev.agentType) a2.type = ev.agentType;
      agents.set(agentId, a2);
      continue;
    }
    if (ev.kind === "pre") {
      pre.set(ev.toolUseId || ev.id, ev);
      continue;
    }
    if (ev.kind === "stop") {
      lastMessage = ev.lastMessage ?? lastMessage;
      continue;
    }
    if (ev.kind === "rewind") {
      const undo = rewinds.some((w) => w.safety === ev.toSnapshot);
      rewinds.push({ at: ev.at, toSnapshot: ev.toSnapshot, safety: ev.safety, toStep: undo ? null : snapToStep.get(ev.toSnapshot) ?? null, undo });
      if (ev.snapshot) prevSnap = ev.snapshot;
      if (ev.toSnapshot) prevSnap = ev.toSnapshot;
      lastSnap = prevSnap;
      continue;
    }
    if (ev.kind === "session" || ev.kind === "turn") {
      if (ev.kind === "turn") turns.push({ id: ev.turnId || ev.id, n: turns.length + 1, prompt: ev.prompt || "", at: ev.at, snapshot: ev.snapshot ?? prevSnap });
      if (ev.snapshot) prevSnap = lastSnap = ev.snapshot;
      continue;
    }
    if (ev.toolUseId) pre.delete(ev.toolUseId);
    if (!agents.has(agentId)) agents.set(agentId, { id: agentId, type: ev.agentType || "subagent", parent: "main", steps: 0, failures: 0, startedAt: ev.at, stoppedAt: null, lastMessage: null });
    const tool = ev.tool || "tool";
    let files = [];
    if (ev.snapshot && prevSnap) {
      const claimed = new Set(patchFiles(ev.input).map((f) => relPath(repo.root, f)));
      files = stepFiles(repo.root, prevSnap, ev.snapshot).map((f) => claimed.size && !claimed.has(f.path) ? { ...f, foreign: true } : f);
    } else if (ev.snapshot && !prevSnap) {
      files = [];
    }
    const { failed, exitCode } = detectFailure(ev.output);
    const { kind, title: title2 } = stepTitle(tool, ev.input, files.filter((f) => !f.foreign).map((f) => f.path), repo.root);
    const n = steps.length + 1;
    const snapshot = ev.snapshot ?? lastSnap;
    steps.push({ n, id: ev.id, at: ev.at, turn: ev.turnId ?? null, agent: agentId, tool, kind, title: title2, input: ev.input, output: ev.output, failed, exitCode, snapshot, changed: !!ev.snapshot, files });
    if (snapshot) snapToStep.set(snapshot, n);
    if (ev.snapshot) prevSnap = lastSnap = ev.snapshot;
    const a = agents.get(agentId);
    a.steps++;
    if (failed) a.failures++;
  }
  const modules = /* @__PURE__ */ new Map();
  const allFiles = /* @__PURE__ */ new Set();
  for (const s of steps) {
    for (const f of s.files) {
      allFiles.add(f.path);
      const key = moduleOf(f.path);
      const m = modules.get(key) ?? { path: key, files: [], steps: [], agents: [], add: 0, del: 0 };
      if (!m.files.includes(f.path)) m.files.push(f.path);
      if (!m.steps.includes(s.n)) m.steps.push(s.n);
      if (!m.agents.includes(s.agent)) m.agents.push(s.agent);
      m.add += f.add;
      m.del += f.del;
      modules.set(key, m);
    }
  }
  const lastStopIdx = events.map((e) => e.kind).lastIndexOf("stop");
  const lastWork = events.reduce((i, e, idx) => e.kind !== "rewind" && e.kind !== "stop" ? idx : i, -1);
  const stopAt = lastStopIdx >= 0 ? events[lastStopIdx].at : "";
  const pending = [...pre.values()].filter((e) => e.at > stopAt).map((e) => {
    const tool = e.tool || "tool";
    const { kind, title: title2 } = stepTitle(tool, e.input, [], repo.root);
    return { id: e.id, at: e.at, agent: e.agentId || "main", tool, kind, title: title2, toolUseId: e.toolUseId ?? null };
  });
  const lastEventAt = events.length ? events[events.length - 1].at : null;
  let status = lastStopIdx >= 0 && lastStopIdx > lastWork && !pending.length ? "done" : "running";
  if (status === "running" && lastEventAt && Date.now() - Date.parse(lastEventAt) > IDLE_MS) status = "idle";
  for (const p of pending) if (!agents.has(p.agent)) agents.set(p.agent, { id: p.agent, type: "subagent", parent: "main", steps: 0, failures: 0, startedAt: p.at, stoppedAt: null, lastMessage: null });
  const firstPrompt = turns[0]?.prompt ?? "";
  const title = firstPrompt ? firstPrompt.length > 90 ? firstPrompt.slice(0, 90) + "\u2026" : firstPrompt : `Session ${sessionId.slice(0, 8)}`;
  const sum = (k) => steps.reduce((t, s) => t + s.files.reduce((u, f) => u + f[k], 0), 0);
  return {
    version: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status,
    lastEventAt,
    pending,
    session: { id: sessionId, model: meta.model ?? null, startedAt: meta.startedAt, title, lastMessage },
    repo: { root: repo.root, name: repo.name, branch: repo.branch, head: repo.head },
    baseline: meta.baseline ?? null,
    final: meta.last ?? null,
    agents: [...agents.values()],
    turns,
    steps,
    modules: [...modules.values()].sort((a, b) => b.steps.length - a.steps.length || a.path.localeCompare(b.path)),
    rewinds,
    stats: {
      steps: steps.length,
      edits: steps.filter((s) => s.kind === "edit").length,
      commands: steps.filter((s) => s.kind === "command").length,
      failures: steps.filter((s) => s.failed).length,
      filesChanged: allFiles.size,
      agents: agents.size,
      add: sum("add"),
      del: sum("del")
    }
  };
}
function receiptPathFor(repo, sessionId, startedAt) {
  const d = new Date(startedAt);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return join2(repo.root, RECEIPT_DIR, `${stamp}-${safeId(sessionId).slice(0, 8)}${RECEIPT_EXT}`);
}
function ensureExcluded(repo) {
  const infoDir = join2(repo.gitDir, "info");
  const exclude = join2(infoDir, "exclude");
  mkdirSync2(infoDir, { recursive: true });
  const cur = existsSync2(exclude) ? readFileSync2(exclude, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === `${RECEIPT_DIR}/`)) appendFileSync2(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${RECEIPT_DIR}/
`);
}
function exportReceipt(repo, sessionId) {
  const receipt = buildReceipt(repo, sessionId);
  ensureExcluded(repo);
  const path = receiptPathFor(repo, sessionId, receipt.session.startedAt);
  mkdirSync2(join2(repo.root, RECEIPT_DIR), { recursive: true });
  writeFileSync2(path, JSON.stringify(receipt, null, 2));
  return { path, receipt };
}

// src/recorder.ts
import { join as join3 } from "node:path";
var PREVIEW_CAP = 4e3;
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(xox[abpr]-[A-Za-z0-9-]{10,})/g,
  /("?(?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi
];
function redact(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => typeof p1 === "string" && m.startsWith(p1) ? `${p1}[redacted]` : "[redacted]");
  return out;
}
function preview(value, cap = PREVIEW_CAP) {
  if (value == null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const red = redact(text);
  if (typeof value === "string" || red.length > cap) return red.length > cap ? red.slice(0, cap) + " \u2026[truncated]" : red;
  try {
    return JSON.parse(red);
  } catch {
    return red;
  }
}
function record(payload2) {
  const repo = repoInfo(payload2.cwd);
  if (!repo || !payload2.session_id) return { recorded: null, repo };
  const sessionId = payload2.session_id;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const base = { id: newEventId(), at: now, sessionId, turnId: payload2.turn_id, agentId: payload2.agent_id, agentType: payload2.agent_type };
  const meta = ensureSession(repo, sessionId, { model: payload2.model });
  const index = join3(sessionDir(repo, sessionId), "index");
  const snap = (label, eventId) => {
    const cur = readMeta(repo, sessionId) ?? meta;
    const { tree, commit } = snapshotTree(repo.root, index, cur.last ?? null, label);
    if (cur.last && treeOf(repo.root, cur.last) === tree) return null;
    updateRef(repo.root, refFor(sessionId, eventId), commit);
    writeMeta(repo, { ...cur, last: commit, baseline: cur.baseline ?? commit });
    return commit;
  };
  let ev;
  switch (payload2.hook_event_name) {
    case "SessionStart": {
      ev = { ...base, kind: "session", model: payload2.model, source: payload2.source };
      const cur = readMeta(repo, sessionId) ?? meta;
      if (!cur.baseline) ev.snapshot = snap("agent-receipts baseline", ev.id);
      break;
    }
    case "UserPromptSubmit": {
      ev = { ...base, kind: "turn", prompt: String(preview(payload2.prompt ?? "", 2e3)) };
      const cur = readMeta(repo, sessionId) ?? meta;
      ev.snapshot = cur.baseline ? snap("agent-receipts turn start", ev.id) : snap("agent-receipts baseline", ev.id);
      break;
    }
    case "PreToolUse": {
      ev = { ...base, kind: "pre", tool: payload2.tool_name, toolUseId: payload2.tool_use_id, input: preview(payload2.tool_input, 1e3) };
      break;
    }
    case "PostToolUse": {
      ev = {
        ...base,
        kind: "step",
        tool: payload2.tool_name,
        toolUseId: payload2.tool_use_id,
        input: preview(payload2.tool_input),
        output: preview(payload2.tool_response)
      };
      ev.snapshot = snap(`agent-receipts ${payload2.tool_name ?? "tool"}`, ev.id);
      break;
    }
    case "SubagentStart":
      ev = { ...base, kind: "agent-start" };
      break;
    case "SubagentStop":
      ev = { ...base, kind: "agent-stop", lastMessage: preview(payload2.last_assistant_message ?? null, 2e3) ?? null };
      break;
    case "Stop":
      ev = { ...base, kind: "stop", lastMessage: preview(payload2.last_assistant_message ?? null, 2e3) ?? null };
      break;
    default:
      return { recorded: null, repo };
  }
  writeEvent(repo, ev);
  let receiptPath;
  if (ev.kind === "stop") receiptPath = exportReceipt(repo, sessionId).path;
  return { recorded: ev, repo, receiptPath };
}

// src/hook.ts
var payload = null;
try {
  const raw = readFileSync3(0, "utf8");
  if (raw.trim()) payload = JSON.parse(raw);
} catch (err) {
  logError(null, err);
}
if (payload && !process.env.AGENT_RECEIPTS_DISABLE) {
  try {
    record(payload);
  } catch (err) {
    let repo = null;
    try {
      repo = repoInfo(payload.cwd);
    } catch {
    }
    logError(repo, err);
  }
}
process.exit(0);
