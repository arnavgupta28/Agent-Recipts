"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// vscode/src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var import_node_child_process3 = require("node:child_process");
var import_node_fs5 = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path7 = require("node:path");

// src/git.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "agent-receipts",
  GIT_AUTHOR_EMAIL: "agent-receipts@localhost",
  GIT_COMMITTER_NAME: "agent-receipts",
  GIT_COMMITTER_EMAIL: "agent-receipts@localhost"
};
function git(cwd, args, opts = {}) {
  const env2 = { ...process.env, ...AUTHOR_ENV };
  if (opts.index) env2.GIT_INDEX_FILE = opts.index;
  env2.GIT_TERMINAL_PROMPT = "0";
  return (0, import_node_child_process.execFileSync)("git", args, {
    cwd,
    env: env2,
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
  const status2 = git(root, ["diff", "--name-status", "-M", "--no-color", from, to]);
  const numstat = git(root, ["diff", "--numstat", "-M", "--no-color", from, to]);
  const counts = /* @__PURE__ */ new Map();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("	");
    const p = rest[rest.length - 1];
    counts.set(p, { add: a === "-" ? 0 : Number(a), del: d === "-" ? 0 : Number(d) });
  }
  const out = [];
  for (const line of status2.split("\n").filter(Boolean)) {
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
function restoreTree(root, current2, target) {
  const list = (c) => new Set(git(root, ["ls-tree", "-r", "--name-only", "-z", c]).split("\0").filter(Boolean));
  const now = list(current2);
  const want = list(target);
  const deleted = [];
  for (const p of now) {
    if (want.has(p)) continue;
    const abs = (0, import_node_path.join)(root, p);
    if ((0, import_node_fs.existsSync)(abs)) {
      (0, import_node_fs.unlinkSync)(abs);
      deleted.push(p);
      pruneEmptyDirs(root, (0, import_node_path.dirname)(abs));
    }
  }
  const tmp = (0, import_node_fs.mkdtempSync)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "agent-receipts-"));
  const idx = (0, import_node_path.join)(tmp, "index");
  try {
    git(root, ["read-tree", target], { index: idx });
    git(root, ["checkout-index", "-a", "-f"], { index: idx });
  } finally {
    (0, import_node_fs.rmSync)(tmp, { recursive: true, force: true });
  }
  return { deleted, restored: want.size };
}
function pruneEmptyDirs(root, dir) {
  while (dir.startsWith(root) && dir !== root) {
    try {
      if ((0, import_node_fs.readdirSync)(dir).length > 0) return;
      (0, import_node_fs.rmdirSync)(dir);
    } catch {
      return;
    }
    dir = (0, import_node_path.dirname)(dir);
  }
}

// src/store.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var import_node_crypto = require("node:crypto");
function safeId(id) {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "unknown";
}
function receiptsDir(repo) {
  return (0, import_node_path2.join)(repo.gitDir, "agent-receipts");
}
function sessionDir(repo, sessionId) {
  return (0, import_node_path2.join)(receiptsDir(repo), safeId(sessionId));
}
function refFor(sessionId, eventId) {
  return `refs/agent-receipts/${safeId(sessionId)}/${safeId(eventId)}`;
}
function newEventId() {
  const ns = process.hrtime.bigint() % 1000000n;
  const ms = BigInt(Date.now()) * 1000000n + ns;
  return `${ms.toString().padStart(22, "0")}-${(0, import_node_crypto.randomBytes)(3).toString("hex")}`;
}
function ensureSession(repo, sessionId, init) {
  const dir = sessionDir(repo, sessionId);
  (0, import_node_fs2.mkdirSync)((0, import_node_path2.join)(dir, "events"), { recursive: true });
  const metaPath = (0, import_node_path2.join)(dir, "meta.json");
  if ((0, import_node_fs2.existsSync)(metaPath)) return JSON.parse((0, import_node_fs2.readFileSync)(metaPath, "utf8"));
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
  const p = (0, import_node_path2.join)(sessionDir(repo, sessionId), "meta.json");
  return (0, import_node_fs2.existsSync)(p) ? JSON.parse((0, import_node_fs2.readFileSync)(p, "utf8")) : null;
}
function writeMeta(repo, meta) {
  writeJsonAtomic((0, import_node_path2.join)(sessionDir(repo, meta.sessionId), "meta.json"), meta);
}
function writeEvent(repo, ev) {
  writeJsonAtomic((0, import_node_path2.join)(sessionDir(repo, ev.sessionId), "events", `${ev.id}.json`), ev);
}
function readEvents(repo, sessionId) {
  const dir = (0, import_node_path2.join)(sessionDir(repo, sessionId), "events");
  if (!(0, import_node_fs2.existsSync)(dir)) return [];
  return (0, import_node_fs2.readdirSync)(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    try {
      return JSON.parse((0, import_node_fs2.readFileSync)((0, import_node_path2.join)(dir, f), "utf8"));
    } catch {
      return null;
    }
  }).filter((e) => e !== null);
}
function listSessions(repo) {
  const dir = receiptsDir(repo);
  if (!(0, import_node_fs2.existsSync)(dir)) return [];
  const out = [];
  for (const name of (0, import_node_fs2.readdirSync)(dir)) {
    const metaPath = (0, import_node_path2.join)(dir, name, "meta.json");
    if (!(0, import_node_fs2.existsSync)(metaPath)) continue;
    const meta = JSON.parse((0, import_node_fs2.readFileSync)(metaPath, "utf8"));
    const evDir = (0, import_node_path2.join)(dir, name, "events");
    const files = (0, import_node_fs2.existsSync)(evDir) ? (0, import_node_fs2.readdirSync)(evDir) : [];
    const updated = files.length ? (0, import_node_fs2.statSync)((0, import_node_path2.join)(evDir, files.sort()[files.length - 1])).mtime : (0, import_node_fs2.statSync)(metaPath).mtime;
    out.push({ sessionId: meta.sessionId, startedAt: meta.startedAt, updatedAt: updated.toISOString(), events: files.length, model: meta.model });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${(0, import_node_crypto.randomBytes)(3).toString("hex")}.tmp`;
  (0, import_node_fs2.writeFileSync)(tmp, JSON.stringify(value, null, 2));
  (0, import_node_fs2.renameSync)(tmp, path);
}

// src/receipt.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
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
function detectFailure(output2) {
  if (output2 && typeof output2 === "object") {
    const o = output2;
    for (const k of ["exit_code", "exitCode", "returncode", "status_code"]) {
      if (typeof o[k] === "number") return { failed: o[k] !== 0, exitCode: o[k] };
    }
    if (o.success === false || o.is_error === true || o.isError === true || typeof o.error === "string" && o.error) return { failed: true, exitCode: null };
  }
  const text = str(output2);
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
  let status2 = lastStopIdx >= 0 && lastStopIdx > lastWork && !pending.length ? "done" : "running";
  if (status2 === "running" && lastEventAt && Date.now() - Date.parse(lastEventAt) > IDLE_MS) status2 = "idle";
  for (const p of pending) if (!agents.has(p.agent)) agents.set(p.agent, { id: p.agent, type: "subagent", parent: "main", steps: 0, failures: 0, startedAt: p.at, stoppedAt: null, lastMessage: null });
  const firstPrompt = turns[0]?.prompt ?? "";
  const title = firstPrompt ? firstPrompt.length > 90 ? firstPrompt.slice(0, 90) + "\u2026" : firstPrompt : `Session ${sessionId.slice(0, 8)}`;
  const sum = (k) => steps.reduce((t, s) => t + s.files.reduce((u, f) => u + f[k], 0), 0);
  return {
    version: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: status2,
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
  return (0, import_node_path3.join)(repo.root, RECEIPT_DIR, `${stamp}-${safeId(sessionId).slice(0, 8)}${RECEIPT_EXT}`);
}
function ensureExcluded(repo) {
  const infoDir = (0, import_node_path3.join)(repo.gitDir, "info");
  const exclude = (0, import_node_path3.join)(infoDir, "exclude");
  (0, import_node_fs3.mkdirSync)(infoDir, { recursive: true });
  const cur = (0, import_node_fs3.existsSync)(exclude) ? (0, import_node_fs3.readFileSync)(exclude, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === `${RECEIPT_DIR}/`)) (0, import_node_fs3.appendFileSync)(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${RECEIPT_DIR}/
`);
}
function exportReceipt(repo, sessionId) {
  const receipt = buildReceipt(repo, sessionId);
  ensureExcluded(repo);
  const path = receiptPathFor(repo, sessionId, receipt.session.startedAt);
  (0, import_node_fs3.mkdirSync)((0, import_node_path3.join)(repo.root, RECEIPT_DIR), { recursive: true });
  (0, import_node_fs3.writeFileSync)(path, JSON.stringify(receipt, null, 2));
  return { path, receipt };
}

// src/rewind.ts
var import_node_path4 = require("node:path");
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
  const index = (0, import_node_path4.join)(sessionDir(repo, sessionId), "index");
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
var import_node_child_process2 = require("node:child_process");
var import_node_fs4 = require("node:fs");
var import_node_path6 = require("node:path");
var import_node_crypto2 = require("node:crypto");

// src/recorder.ts
var import_node_path5 = require("node:path");
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
  const index = (0, import_node_path5.join)(sessionDir(repo, sessionId), "index");
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
  if (opts.fresh !== false && (0, import_node_fs4.existsSync)(dir)) (0, import_node_fs4.rmSync)(dir, { recursive: true, force: true });
  (0, import_node_fs4.mkdirSync)(dir, { recursive: true });
  const write = (p, c) => {
    (0, import_node_fs4.mkdirSync)((0, import_node_path6.dirname)((0, import_node_path6.join)(dir, p)), { recursive: true });
    (0, import_node_fs4.writeFileSync)((0, import_node_path6.join)(dir, p), c);
  };
  for (const [p, c] of Object.entries(FILES)) write(p, c);
  const g = (...args) => (0, import_node_child_process2.execFileSync)("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "add", "-A");
  g("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-q", "-m", "Initial shop-api");
  say(`Demo repo ready at ${dir}`);
  const session = (0, import_node_crypto2.randomUUID)();
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
    const id = `call_${(0, import_node_crypto2.randomUUID)().slice(0, 8)}`;
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
      const { NODE_TEST_CONTEXT: _ignored, ...env2 } = process.env;
      const PATH = opts.pathPrefix ? `${opts.pathPrefix}:${env2.PATH ?? ""}` : env2.PATH;
      const r = (0, import_node_child_process2.spawnSync)("bash", ["-c", cmd], { cwd: dir, encoding: "utf8", env: { ...env2, PATH, NODE_NO_WARNINGS: "1" } });
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

// vscode/src/extension.ts
var SCHEME = "agent-receipts";
var HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"];
var panel;
var status;
var ctx;
var output;
var current = null;
var announced = /* @__PURE__ */ new Set();
function activate(context) {
  ctx = context;
  output = vscode.window.createOutputChannel("Agent Receipts");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "agentReceipts.open";
  context.subscriptions.push(status, output);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: snapshotContent }),
    vscode.commands.registerCommand("agentReceipts.open", () => openPanel(true)),
    vscode.commands.registerCommand("agentReceipts.installHooks", installHooks),
    vscode.commands.registerCommand("agentReceipts.trustHooks", trustHooks),
    vscode.commands.registerCommand("agentReceipts.pickSession", pickSession),
    vscode.commands.registerCommand("agentReceipts.demo", runDemo)
  );
  const timer = setInterval(() => void tick(), 1e3);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void tick();
}
function deactivate() {
}
function workspaceRepos() {
  const seen = /* @__PURE__ */ new Map();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const r = repoInfo(f.uri.fsPath);
    if (r && !seen.has(r.root)) seen.set(r.root, r);
  }
  return [...seen.values()];
}
function latestSession() {
  let best = null;
  for (const repo of workspaceRepos()) {
    const s = listSessions(repo)[0];
    if (s && (!best || s.updatedAt > best.updatedAt)) best = { repo, session: s.sessionId, updatedAt: s.updatedAt };
  }
  return best;
}
var signature = (r) => `${r.status}|${r.steps.length}|${r.pending.map((p) => p.id).join(",")}|${r.rewinds.length}|${r.agents.map((a) => `${a.id}:${a.steps}:${a.stoppedAt ?? ""}`).join(",")}`;
async function tick() {
  try {
    const cfg = vscode.workspace.getConfiguration("agentReceipts");
    const latest = latestSession();
    if (!latest) {
      status.hide();
      return;
    }
    const follow = !current || !pinned && (current.session !== latest.session || current.repo.root !== latest.repo.root);
    if (follow) current = { repo: latest.repo, session: latest.session, signature: "" };
    if (!current || !readMeta(current.repo, current.session)) return;
    const receipt = buildReceipt(current.repo, current.session);
    updateStatus(receipt);
    const sig = signature(receipt);
    const fresh = !announced.has(current.session);
    if (fresh && receipt.status === "running" && cfg.get("autoOpen", true)) {
      announced.add(current.session);
      openPanel(false);
    }
    if (sig !== current.signature) {
      current.signature = sig;
      post({ type: "receipt", receipt });
    }
  } catch (err) {
    output.appendLine(`tick: ${err.stack ?? err}`);
  }
}
var pinned = false;
function updateStatus(r) {
  if (r.status === "running") {
    const p = r.pending[r.pending.length - 1];
    const who = p ? p.agent === "main" ? "main" : r.agents.find((a) => a.id === p.agent)?.type ?? p.agent : null;
    status.text = `$(pulse) Codex${p ? ` \xB7 ${who}: ${p.title.slice(0, 40)}` : " running"} \xB7 ${r.stats.steps} steps`;
    status.tooltip = "Agent Receipts: Codex is running. Click to open the live run graph.";
    status.backgroundColor = void 0;
  } else {
    status.text = `$(history) Receipt \xB7 ${r.stats.steps} steps${r.stats.failures ? ` \xB7 $(error) ${r.stats.failures} failed` : ""}`;
    status.tooltip = `Agent Receipts: ${r.session.title}`;
    status.backgroundColor = r.stats.failures ? new vscode.ThemeColor("statusBarItem.warningBackground") : void 0;
  }
  status.show();
}
function openPanel(focus) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, !focus);
    if (current) post({ type: "receipt", receipt: buildReceipt(current.repo, current.session) });
    return;
  }
  panel = vscode.window.createWebviewPanel("agentReceipts", "Agent Receipts", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: []
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "icon.svg");
  const html = (0, import_node_fs5.readFileSync)((0, import_node_path7.join)(ctx.extensionPath, "dist", "viewer.html"), "utf8");
  const boot = `<script>window.__AGENT_RECEIPTS__=${JSON.stringify({ mode: "vscode" })};</script>`;
  panel.webview.html = html.replace("<!--BOOT-->", () => boot);
  panel.webview.onDidReceiveMessage(onMessage, void 0, ctx.subscriptions);
  panel.onDidDispose(() => panel = void 0, void 0, ctx.subscriptions);
}
function post(msg) {
  void panel?.webview.postMessage(msg);
}
async function onMessage(msg) {
  if (!current) return;
  const { repo, session } = current;
  switch (msg.type) {
    case "ready":
      current.signature = "";
      post({ type: "receipt", receipt: buildReceipt(repo, session) });
      return;
    case "rewind": {
      try {
        const r = rewind(repo, session, msg.snapshot);
        current.signature = signature(r.receipt);
        post({ type: "reply", id: msg.id, ok: true, data: { receipt: r.receipt, safety: r.safety, deleted: r.deleted } });
      } catch (err) {
        post({ type: "reply", id: msg.id, ok: false, error: err.message });
      }
      return;
    }
    case "explain": {
      await vscode.env.clipboard.writeText(msg.prompt);
      const sent = await sendToCodex(msg.prompt);
      post({ type: "reply", id: msg.id, ok: true, data: sent ? "sent" : "copied" });
      return;
    }
    case "openFile": {
      const uri = vscode.Uri.file((0, import_node_path7.join)(repo.root, msg.path));
      if ((0, import_node_fs5.existsSync)(uri.fsPath)) await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, preview: true });
      else void vscode.window.showInformationMessage(`${msg.path} doesn't exist in the working tree right now.`);
      return;
    }
    case "openDiff":
      return openDiff(repo, session, msg.step, msg.path);
    case "pickSession":
      return pickSession();
  }
}
async function sendToCodex(prompt) {
  try {
    await vscode.commands.executeCommand("chatgpt.openSidebar");
  } catch {
  }
  void vscode.window.showInformationMessage("Explain prompt copied. Paste it into the Codex chat (\u2318V).");
  void prompt;
  return false;
}
function snapshotContent(uri) {
  const q = new URLSearchParams(uri.query);
  const root = q.get("root");
  const commit = q.get("commit");
  const path = q.get("path");
  if (!commit) return "";
  return tryGit(root, ["show", `${commit}:${path}`]) ?? "";
}
function snapUri(root, commit, path, label) {
  const q = new URLSearchParams({ root, path, ...commit ? { commit } : {} });
  return vscode.Uri.from({ scheme: SCHEME, path: `/${label}/${path}`, query: q.toString() });
}
async function openDiff(repo, session, stepN, path) {
  const r = buildReceipt(repo, session);
  const idx = r.steps.findIndex((s) => s.n === stepN);
  const step = r.steps[idx];
  if (!step?.snapshot) return;
  let before = r.baseline;
  for (let i = idx - 1; i >= 0; i--) {
    if (r.steps[i].changed && r.steps[i].snapshot) {
      before = r.steps[i].snapshot;
      break;
    }
  }
  const turnSnap = [...r.turns].reverse().find((t) => t.at <= step.at && t.snapshot)?.snapshot;
  if (turnSnap && (!before || r.steps.slice(0, idx).every((s) => !s.changed))) before = turnSnap;
  const agent = r.agents.find((a) => a.id === step.agent);
  const who = agent ? agent.id === "main" ? "main" : agent.type : step.agent;
  const left = snapUri(repo.root, before, path, "before");
  const right = snapUri(repo.root, step.snapshot, path, `after-step-${stepN}`);
  await vscode.commands.executeCommand("vscode.diff", left, right, `${path.split("/").pop()} \xB7 step #${stepN} (${who})`, { viewColumn: vscode.ViewColumn.One, preview: true });
}
async function pickSession() {
  const items = [{ label: "$(pulse) Follow the latest session", description: "auto" }];
  for (const repo of workspaceRepos()) {
    for (const s of listSessions(repo)) {
      let title = s.sessionId.slice(0, 8);
      try {
        title = buildReceipt(repo, s.sessionId).session.title;
      } catch {
      }
      items.push({ label: title, description: `${repo.name} \xB7 ${new Date(s.updatedAt).toLocaleString()} \xB7 ${s.events} events`, repo, session: s.sessionId });
    }
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Which agent run do you want to see?" });
  if (!pick) return;
  if (!pick.repo || !pick.session) {
    pinned = false;
    current = null;
  } else {
    pinned = true;
    current = { repo: pick.repo, session: pick.session, signature: "" };
    exportReceipt(pick.repo, pick.session);
  }
  openPanel(true);
  await tick();
}
function findNode() {
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  try {
    const p = (0, import_node_child_process3.execFileSync)(process.env.SHELL || "/bin/zsh", ["-lc", "command -v node"], { encoding: "utf8", timeout: 5e3 }).trim();
    if (p && (0, import_node_fs5.existsSync)(p)) return p;
  } catch {
  }
  return candidates.find((c) => (0, import_node_fs5.existsSync)(c)) ?? "node";
}
function hookCommand() {
  return `"${findNode()}" "${(0, import_node_path7.join)(ctx.extensionPath, "dist", "hook.mjs")}"`;
}
function hooksConfig(command) {
  const out = {};
  for (const ev of HOOK_EVENTS) {
    const async = ev === "PreToolUse" || ev === "SubagentStart" || ev === "SubagentStop" || ev === "Stop";
    const handler = { type: "command", command, timeout: ev === "Stop" ? 60 : 30, ...async ? { async: true } : {}, ...ev === "PostToolUse" ? { statusMessage: "Recording receipt" } : {} };
    out[ev] = [{ ...ev.endsWith("ToolUse") ? { matcher: "*" } : {}, hooks: [handler] }];
  }
  return out;
}
function mergeHooks(path, command) {
  const existing = (0, import_node_fs5.existsSync)(path) ? JSON.parse((0, import_node_fs5.readFileSync)(path, "utf8")) : {};
  existing.hooks = existing.hooks ?? {};
  const marker = (0, import_node_path7.join)("dist", "hook.mjs");
  for (const [ev, groups] of Object.entries(hooksConfig(command))) {
    const cur = (existing.hooks[ev] ?? []).filter((g) => !(g.hooks ?? []).some((h) => h.command?.includes(marker) && h.command?.includes("agent-receipts")));
    existing.hooks[ev] = [...cur, ...groups];
  }
  (0, import_node_fs5.mkdirSync)((0, import_node_path7.join)(path, ".."), { recursive: true });
  (0, import_node_fs5.writeFileSync)(path, JSON.stringify(existing, null, 2) + "\n");
}
async function installHooks() {
  const repos = workspaceRepos();
  const choice = await vscode.window.showQuickPick(
    [
      { label: "This workspace's repo", description: repos[0] ? `${repos[0].root}/.codex/hooks.json` : "open a git repo first", id: "repo" },
      { label: "All repos on this machine", description: "~/.codex/hooks.json (does nothing outside git repos)", id: "user" }
    ],
    { placeHolder: "Where should Codex record agent receipts?" }
  );
  if (!choice) return;
  const command = hookCommand();
  let path;
  if (choice.id === "repo") {
    if (!repos[0]) return void vscode.window.showErrorMessage("Open a folder that is a git repository first.");
    path = (0, import_node_path7.join)(repos[0].root, ".codex", "hooks.json");
  } else path = (0, import_node_path7.join)((0, import_node_os2.homedir)(), ".codex", "hooks.json");
  mergeHooks(path, command);
  output.appendLine(`Wrote hooks to ${path} using: ${command}`);
  const next = await vscode.window.showInformationMessage(
    `Agent Receipts hooks added to ${path}. Codex only runs hooks you've reviewed and trusted.`,
    "Review & trust hooks",
    "Open hooks file"
  );
  if (next === "Review & trust hooks") await trustHooks();
  if (next === "Open hooks file") await vscode.window.showTextDocument(vscode.Uri.file(path));
}
function bundledCodex() {
  const ext = vscode.extensions.getExtension("openai.chatgpt");
  if (!ext) return null;
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const p = (0, import_node_path7.join)(ext.extensionPath, "bin", `${os}-${arch}`, process.platform === "win32" ? "codex.exe" : "codex");
  return (0, import_node_fs5.existsSync)(p) ? p : null;
}
async function trustHooks() {
  const codex = bundledCodex() ?? "codex";
  const cwd = workspaceRepos()[0]?.root ?? (0, import_node_os2.tmpdir)();
  const term = vscode.window.createTerminal({ name: "Codex \xB7 review hooks", cwd });
  term.show();
  term.sendText(`"${codex}"`);
  void vscode.window.showInformationMessage("In the Codex terminal, type /hooks, review the Agent Receipts hooks and trust them. Then start a new Codex chat.");
}
async function runDemo() {
  const target = vscode.Uri.file((0, import_node_path7.join)((0, import_node_os2.homedir)(), "agent-receipts-demo"));
  const go = await vscode.window.showInformationMessage(
    `Replay a recorded 3-agent run into ${target.fsPath}? The folder is recreated from scratch.`,
    { modal: true },
    "Run live demo"
  );
  if (go !== "Run live demo") return;
  const delayMs = vscode.workspace.getConfiguration("agentReceipts").get("demoDelayMs", 1500);
  const repoFor = (dir) => repoInfo(dir);
  const node = findNode();
  await simulate({
    dir: target.fsPath,
    delayMs,
    pathPrefix: node.includes("/") ? node.slice(0, node.lastIndexOf("/")) : void 0,
    log: (m) => output.appendLine(m),
    onReady: async ({ dir, sessionId }) => {
      pinned = true;
      current = { repo: repoFor(dir), session: sessionId, signature: "" };
      announced.add(sessionId);
      openPanel(true);
      await new Promise((r) => setTimeout(r, 1200));
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
