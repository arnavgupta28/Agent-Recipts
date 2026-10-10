#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli.ts
import { createServer } from "node:http";
import { randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname4, join as join8, resolve } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { spawn } from "node:child_process";

// src/git.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
function restoreTree(root, current, target) {
  const list = (c) => new Set(git(root, ["ls-tree", "-r", "--name-only", "-z", c]).split("\0").filter(Boolean));
  const now = list(current);
  const want = list(target);
  const deleted = [];
  for (const p of now) {
    if (want.has(p)) continue;
    const abs = join(root, p);
    if (existsSync(abs)) {
      unlinkSync(abs);
      deleted.push(p);
      pruneEmptyDirs(root, dirname(abs));
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), "agent-receipts-"));
  const idx = join(tmp, "index");
  try {
    git(root, ["read-tree", target], { index: idx });
    git(root, ["checkout-index", "-a", "-f"], { index: idx });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { deleted, restored: want.size };
}
function pruneEmptyDirs(root, dir) {
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

// src/store.ts
import { existsSync as existsSync2, mkdirSync, readFileSync, readdirSync as readdirSync2, statSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join as join2 } from "node:path";
import { randomBytes } from "node:crypto";
function safeId(id) {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "unknown";
}
function receiptsDir(repo) {
  return join2(repo.gitDir, "agent-receipts");
}
function sessionDir(repo, sessionId) {
  return join2(receiptsDir(repo), safeId(sessionId));
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
  mkdirSync(join2(dir, "events"), { recursive: true });
  const metaPath = join2(dir, "meta.json");
  if (existsSync2(metaPath)) return JSON.parse(readFileSync(metaPath, "utf8"));
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
  const p = join2(sessionDir(repo, sessionId), "meta.json");
  return existsSync2(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function writeMeta(repo, meta) {
  writeJsonAtomic(join2(sessionDir(repo, meta.sessionId), "meta.json"), meta);
}
function writeEvent(repo, ev) {
  writeJsonAtomic(join2(sessionDir(repo, ev.sessionId), "events", `${ev.id}.json`), ev);
}
function readEvents(repo, sessionId) {
  const dir = join2(sessionDir(repo, sessionId), "events");
  if (!existsSync2(dir)) return [];
  return readdirSync2(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    try {
      return JSON.parse(readFileSync(join2(dir, f), "utf8"));
    } catch {
      return null;
    }
  }).filter((e) => e !== null);
}
function listSessions(repo) {
  const dir = receiptsDir(repo);
  if (!existsSync2(dir)) return [];
  const out = [];
  for (const name of readdirSync2(dir)) {
    const metaPath = join2(dir, name, "meta.json");
    if (!existsSync2(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const evDir = join2(dir, name, "events");
    const files = existsSync2(evDir) ? readdirSync2(evDir) : [];
    const updated = files.length ? statSync(join2(evDir, files.sort()[files.length - 1])).mtime : statSync(metaPath).mtime;
    out.push({ sessionId: meta.sessionId, startedAt: meta.startedAt, updatedAt: updated.toISOString(), events: files.length, model: meta.model });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

// src/receipt.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
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
  return join3(repo.root, RECEIPT_DIR, `${stamp}-${safeId(sessionId).slice(0, 8)}${RECEIPT_EXT}`);
}
function ensureExcluded(repo) {
  const infoDir = join3(repo.gitDir, "info");
  const exclude = join3(infoDir, "exclude");
  mkdirSync2(infoDir, { recursive: true });
  const cur = existsSync3(exclude) ? readFileSync2(exclude, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === `${RECEIPT_DIR}/`)) appendFileSync2(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${RECEIPT_DIR}/
`);
}
function exportReceipt(repo, sessionId) {
  const receipt = buildReceipt(repo, sessionId);
  ensureExcluded(repo);
  const path = receiptPathFor(repo, sessionId, receipt.session.startedAt);
  mkdirSync2(join3(repo.root, RECEIPT_DIR), { recursive: true });
  writeFileSync2(path, JSON.stringify(receipt, null, 2));
  return { path, receipt };
}
function loadReceipt(path) {
  const r = JSON.parse(readFileSync2(path, "utf8"));
  if (r.version !== 1 || !Array.isArray(r.steps)) throw new Error("Not an Agent Receipts v1 file");
  return r;
}

// src/rewind.ts
import { join as join4 } from "node:path";
function isReceiptsCommit(repo, sha) {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return false;
  if (tryGit(repo.root, ["cat-file", "-e", `${sha}^{commit}`]) === null) return false;
  const subject = tryGit(repo.root, ["log", "-1", "--format=%s", sha]) ?? "";
  return subject.startsWith("agent-receipts");
}
function rewind(repo, sessionId, target) {
  const meta = readMeta(repo, sessionId);
  if (!meta) throw new Error(`Unknown session ${sessionId}`);
  if (!isReceiptsCommit(repo, target)) throw new Error("Target is not an Agent Receipts snapshot in this repository");
  const index = join4(sessionDir(repo, sessionId), "index");
  const id = newEventId();
  const safety = snapshotTree(repo.root, index, meta.last ?? null, "agent-receipts safety (before rewind)").commit;
  updateRef(repo.root, refFor(sessionId, `${id}-safety`), safety);
  const { deleted } = restoreTree(repo.root, safety, target);
  const after = snapshotTree(repo.root, index, safety, "agent-receipts after rewind").commit;
  updateRef(repo.root, refFor(sessionId, id), after);
  writeMeta(repo, { ...meta, last: after });
  writeEvent(repo, { id, kind: "rewind", at: (/* @__PURE__ */ new Date()).toISOString(), sessionId, toSnapshot: target, safety, snapshot: after });
  const { path, receipt } = exportReceipt(repo, sessionId);
  return { safety, target, deleted, receiptPath: path, receipt };
}

// src/simulate.ts
import { spawnSync, execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join6 } from "node:path";
import { randomUUID } from "node:crypto";

// src/recorder.ts
import { join as join5 } from "node:path";
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
function record(payload) {
  const repo = repoInfo(payload.cwd);
  if (!repo || !payload.session_id) return { recorded: null, repo };
  const sessionId = payload.session_id;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const base = { id: newEventId(), at: now, sessionId, turnId: payload.turn_id, agentId: payload.agent_id, agentType: payload.agent_type };
  const meta = ensureSession(repo, sessionId, { model: payload.model });
  const index = join5(sessionDir(repo, sessionId), "index");
  const snap = (label, eventId) => {
    const cur = readMeta(repo, sessionId) ?? meta;
    const { tree, commit } = snapshotTree(repo.root, index, cur.last ?? null, label);
    if (cur.last && treeOf(repo.root, cur.last) === tree) return null;
    updateRef(repo.root, refFor(sessionId, eventId), commit);
    writeMeta(repo, { ...cur, last: commit, baseline: cur.baseline ?? commit });
    return commit;
  };
  let ev;
  switch (payload.hook_event_name) {
    case "SessionStart": {
      ev = { ...base, kind: "session", model: payload.model, source: payload.source };
      const cur = readMeta(repo, sessionId) ?? meta;
      if (!cur.baseline) ev.snapshot = snap("agent-receipts baseline", ev.id);
      break;
    }
    case "UserPromptSubmit": {
      ev = { ...base, kind: "turn", prompt: String(preview(payload.prompt ?? "", 2e3)) };
      const cur = readMeta(repo, sessionId) ?? meta;
      ev.snapshot = cur.baseline ? snap("agent-receipts turn start", ev.id) : snap("agent-receipts baseline", ev.id);
      break;
    }
    case "PreToolUse": {
      ev = { ...base, kind: "pre", tool: payload.tool_name, toolUseId: payload.tool_use_id, input: preview(payload.tool_input, 1e3) };
      break;
    }
    case "PostToolUse": {
      ev = {
        ...base,
        kind: "step",
        tool: payload.tool_name,
        toolUseId: payload.tool_use_id,
        input: preview(payload.tool_input),
        output: preview(payload.tool_response)
      };
      ev.snapshot = snap(`agent-receipts ${payload.tool_name ?? "tool"}`, ev.id);
      break;
    }
    case "SubagentStart":
      ev = { ...base, kind: "agent-start" };
      break;
    case "SubagentStop":
      ev = { ...base, kind: "agent-stop", lastMessage: preview(payload.last_assistant_message ?? null, 2e3) ?? null };
      break;
    case "Stop":
      ev = { ...base, kind: "stop", lastMessage: preview(payload.last_assistant_message ?? null, 2e3) ?? null };
      break;
    default:
      return { recorded: null, repo };
  }
  writeEvent(repo, ev);
  let receiptPath;
  if (ev.kind === "stop") receiptPath = exportReceipt(repo, sessionId).path;
  return { recorded: ev, repo, receiptPath };
}

// src/simulate.ts
var FILES = {
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
`
};
var CLOCK = `export function nowMs() {
  return Date.now();
}
`;
var LIMITER_GOOD = `import { nowMs } from "../utils/clock.js";

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
var LIMITER_TEST = `import { test } from "node:test";
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
var LIMITER_BUGGY = LIMITER_GOOD.replace("if (w.count >= limit) return false;\n    w.count += 1;\n    return true;", "w.count += 1;\n    // Inline the check to save a branch.\n    return w.count < limit;");
var ROUTES_LIMITED = `import { getProducts } from "../catalog/products.js";
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
function patchText(kind, path, content) {
  const body = content.split("\n").map((l) => kind === "Add" ? `+${l}` : ` ${l}`).join("\n");
  return `*** Begin Patch
*** ${kind} File: ${path}
${body}
*** End Patch`;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function simulate(opts) {
  const dir = opts.dir;
  const say = opts.log ?? (() => {
  });
  const delay = opts.delayMs ?? 0;
  if (opts.fresh !== false && existsSync4(dir)) rmSync2(dir, { recursive: true, force: true });
  mkdirSync3(dir, { recursive: true });
  const write = (p, c) => {
    mkdirSync3(dirname2(join6(dir, p)), { recursive: true });
    writeFileSync3(join6(dir, p), c);
  };
  for (const [p, c] of Object.entries(FILES)) write(p, c);
  const g = (...args) => execFileSync2("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "add", "-A");
  g("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-q", "-m", "Initial shop-api");
  say(`Demo repo ready at ${dir}`);
  const session = randomUUID();
  const model = "gpt-6.1-sol";
  const turn = "turn-1";
  const base = (event2, extra = {}) => ({
    hook_event_name: event2,
    session_id: session,
    cwd: dir,
    model,
    permission_mode: "acceptEdits",
    transcript_path: null,
    turn_id: turn,
    ...extra
  });
  const agent = (id, type) => ({ agent_id: id, agent_type: type });
  const tool = async (name, input, work, who = {}, workMs = delay) => {
    const id = `call_${randomUUID().slice(0, 8)}`;
    record(base("PreToolUse", { tool_name: name, tool_use_id: id, tool_input: input, ...who }));
    if (workMs) await sleep(workMs);
    const response = work();
    record(base("PostToolUse", { tool_name: name, tool_use_id: id, tool_input: input, tool_response: response, ...who }));
    if (delay) await sleep(Math.round(delay / 3));
    return response;
  };
  const edit = (kind, path, content, who = {}) => tool("apply_patch", { command: patchText(kind, path, content) }, () => {
    write(path, content);
    return { output: `Success. Updated the following files:
M ${path}`, exit_code: 0 };
  }, who);
  const shell = async (cmd, who = {}, workMs = delay) => {
    const res = await tool("Bash", { command: cmd }, () => {
      const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
      const PATH = opts.pathPrefix ? `${opts.pathPrefix}:${env.PATH ?? ""}` : env.PATH;
      const r = spawnSync("bash", ["-c", cmd], { cwd: dir, encoding: "utf8", env: { ...env, PATH, NODE_NO_WARNINGS: "1" } });
      return { output: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-3e3), exit_code: r.status ?? 1 };
    }, who, workMs);
    return res.exit_code;
  };
  const event = async (name, extra) => {
    record(base(name, extra));
    if (delay) await sleep(Math.round(delay / 2));
  };
  const REFACTOR = agent("agent-refactor", "refactor");
  const TESTS = agent("agent-tests", "tests");
  record(base("SessionStart", { source: "startup" }));
  await opts.onReady?.({ dir, sessionId: session });
  await event("UserPromptSubmit", { prompt: "Add per-IP rate limiting to the shop API and cover it with tests. Use a refactor agent for the code and a tests agent for the tests." });
  await shell('grep -rn "export function" src | head -20');
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
  const repo = repoInfo(dir);
  const receiptPath = stop.receiptPath ?? exportReceipt(repo, session).path;
  say(`Receipt written to ${receiptPath}`);
  return { receiptPath, sessionId: session, dir };
}

// src/html.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname3, join as join7 } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname3(fileURLToPath(import.meta.url));
function viewerHtml(mode, extra = {}) {
  const html = readFileSync3(join7(HERE, "viewer.html"), "utf8");
  const boot = `<script>window.__AGENT_RECEIPTS__=${JSON.stringify({ mode, ...extra }).replace(/</g, "\\u003c")};</script>`;
  return html.replace("<!--BOOT-->", () => boot);
}

// src/cli.ts
var HERE2 = dirname4(fileURLToPath2(import.meta.url));
function parseArgs(argv) {
  const [cmd = "help", ...rest] = argv;
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}
function needRepo(cwd) {
  const repo = repoInfo(cwd);
  if (!repo) throw new Error(`Not inside a git repository: ${cwd}`);
  return repo;
}
function pickSession(repo, wanted) {
  const sessions = listSessions(repo);
  if (!sessions.length) throw new Error("No recorded sessions in this repo yet. Run Codex with the plugin, or try `agent-receipts simulate`.");
  if (typeof wanted === "string" && wanted !== "latest") {
    const hit = sessions.find((s) => s.sessionId === wanted || s.sessionId.startsWith(wanted));
    if (!hit) throw new Error(`No session matching ${wanted}`);
    return hit.sessionId;
  }
  return sessions[0].sessionId;
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
  }
}
function receiptLoader(src) {
  let root = src.root;
  let session = src.session;
  if (src.file && (!root || !session)) {
    const r = loadReceipt(src.file);
    root = r.repo.root;
    session = r.session.id;
  }
  const repo = root ? repoInfo(root) : null;
  return {
    label: src.file ?? `${root} (session ${session?.slice(0, 8)})`,
    load: () => {
      if (repo && session && readMeta(repo, session)) return buildReceipt(repo, session);
      if (src.file) return loadReceipt(src.file);
      throw new Error("Receipt not found");
    }
  };
}
function view(src, port, open) {
  const token = randomBytes2(16).toString("hex");
  const loader = receiptLoader(src);
  let current = loader.load();
  const receiptPath = loader.label;
  const server = createServer((req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return send(200, viewerHtml("http", { token }), "text/html; charset=utf-8");
      if (url.pathname.startsWith("/api/") && req.headers["x-agent-receipts-token"] !== token) return send(403, JSON.stringify({ error: "bad token" }));
      if (req.method === "GET" && url.pathname === "/api/receipt") {
        current = loader.load();
        return send(200, JSON.stringify({ receipt: current, path: receiptPath }));
      }
      if (req.method === "POST" && url.pathname === "/api/rewind") {
        let body = "";
        req.on("data", (c) => body += c);
        req.on("end", () => {
          try {
            const { snapshot } = JSON.parse(body || "{}");
            if (!snapshot) return send(400, JSON.stringify({ error: "snapshot required" }));
            const repo = needRepo(current.repo.root);
            const r = rewind(repo, current.session.id, snapshot);
            current = r.receipt;
            send(200, JSON.stringify({ receipt: r.receipt, safety: r.safety, deleted: r.deleted }));
          } catch (err) {
            send(500, JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
      send(404, JSON.stringify({ error: "not found" }));
    } catch (err) {
      send(500, JSON.stringify({ error: err.message }));
    }
  });
  return new Promise((resolveListen) => server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    const url = `http://127.0.0.1:${p}/`;
    console.log(`Agent Receipts viewer: ${url}`);
    console.log(`Receipt: ${receiptPath}`);
    console.log("Press Ctrl+C to stop.");
    if (open) openBrowser(url);
    resolveListen();
  }));
}
function install(repo) {
  const hook = resolve(HERE2, "hook.js");
  const cmd = `node "${hook}"`;
  const h = (async) => [{ hooks: [{ type: "command", command: cmd, timeout: 30, ...async ? { async: true } : {} }] }];
  const config = {
    hooks: {
      SessionStart: h(false),
      UserPromptSubmit: h(false),
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd, timeout: 10, async: true }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd, timeout: 30, statusMessage: "Recording receipt" }] }],
      SubagentStart: h(true),
      SubagentStop: h(true),
      Stop: h(true)
    }
  };
  const dir = join8(repo.root, ".codex");
  mkdirSync4(dir, { recursive: true });
  const path = join8(dir, "hooks.json");
  if (existsSync5(path)) {
    const existing = JSON.parse(readFileSync4(path, "utf8"));
    existing.hooks = { ...existing.hooks ?? {} };
    for (const [ev, groups] of Object.entries(config.hooks)) {
      const cur = existing.hooks[ev] ?? [];
      if (!JSON.stringify(cur).includes(hook)) existing.hooks[ev] = [...cur, ...groups];
    }
    writeFileSync4(path, JSON.stringify(existing, null, 2) + "\n");
  } else writeFileSync4(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}
var HELP = `agent-receipts \u2014 see what your coding agent did, and rewind it

Usage:
  agent-receipts list     [--cwd DIR]                 List recorded sessions in a repo
  agent-receipts export   [--cwd DIR] [--session ID]  Write the session's ${RECEIPT_EXT} file (default: latest)
  agent-receipts view     [FILE] [--cwd DIR] [--session ID] [--port N] [--no-open]
                                                       Open a receipt in the browser viewer
  agent-receipts rewind   --to SNAPSHOT [--cwd DIR] [--session ID]
                                                       Restore files to a snapshot (undoable)
  agent-receipts install  [--cwd DIR]                 Add recording hooks to <repo>/.codex/hooks.json
  agent-receipts simulate [--dir DIR] [--live [MS]] [--no-view]
                                                       Build a demo repo with a recorded multi-agent run
                                                       (--live replays it slowly so the graph grows in real time)
`;
async function main() {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const cwd = resolve(typeof flags.cwd === "string" ? flags.cwd : process.cwd());
  const port = typeof flags.port === "string" ? Number(flags.port) : 0;
  switch (cmd) {
    case "list": {
      const repo = needRepo(cwd);
      const sessions = listSessions(repo);
      if (!sessions.length) return console.log("No recorded sessions.");
      for (const s of sessions) console.log(`${s.sessionId}  ${s.updatedAt}  ${s.events} events  ${s.model ?? ""}`);
      return;
    }
    case "export": {
      const repo = needRepo(cwd);
      const { path, receipt } = exportReceipt(repo, pickSession(repo, flags.session));
      console.log(path);
      console.error(`${receipt.stats.steps} steps, ${receipt.stats.filesChanged} files, ${receipt.stats.failures} failed, ${receipt.stats.agents} agents`);
      return;
    }
    case "view": {
      let file = pos[0] ? resolve(pos[0]) : null;
      if (!file) {
        const repo = needRepo(cwd);
        file = exportReceipt(repo, pickSession(repo, flags.session)).path;
      }
      await view({ file }, port, flags["no-open"] !== true);
      return;
    }
    case "rewind": {
      const repo = needRepo(cwd);
      if (typeof flags.to !== "string") throw new Error("--to SNAPSHOT is required");
      const r = rewind(repo, pickSession(repo, flags.session), flags.to);
      console.log(`Restored files to ${r.target.slice(0, 10)}. Deleted ${r.deleted.length} file(s).`);
      console.log(`Undo with: agent-receipts rewind --to ${r.safety} --cwd "${repo.root}"`);
      return;
    }
    case "install": {
      const path = install(needRepo(cwd));
      console.log(`Hooks written to ${path}. In Codex, run /hooks to review and trust them.`);
      return;
    }
    case "simulate": {
      const dir = resolve(typeof flags.dir === "string" ? flags.dir : join8(process.cwd(), "demo-shop-api"));
      const live = flags.live !== void 0;
      const delayMs = live ? typeof flags.live === "string" ? Number(flags.live) : 1500 : 0;
      const showView = flags["no-view"] !== true;
      const r = await simulate({
        dir,
        delayMs,
        log: (m) => console.log(m),
        onReady: live && showView ? async ({ dir: d, sessionId }) => {
          await view({ root: d, session: sessionId }, port, flags["no-open"] !== true);
          await new Promise((res) => setTimeout(res, 2500));
        } : void 0
      });
      if (!live && showView) await view({ file: r.receiptPath }, port, flags["no-open"] !== true);
      return;
    }
    default:
      console.log(HELP);
      void RECEIPT_DIR;
  }
}
main().catch((err) => {
  console.error(`agent-receipts: ${err.message}`);
  process.exit(1);
});
