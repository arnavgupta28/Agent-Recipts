// Builds the portable .receipt JSON from recorded events + git snapshots.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles, fileDiff, tryGit, type FileChange, type RepoInfo } from "./git.js";
import { readEvents, readMeta, safeId, type RecordedEvent } from "./store.js";

export const RECEIPT_EXT = ".receipt";
export const RECEIPT_DIR = ".agent-receipts";

export type ReceiptFile = FileChange & { diff: string; foreign?: boolean };
export type ReceiptStep = {
  n: number;
  id: string;
  at: string;
  turn: string | null;
  agent: string;
  tool: string;
  kind: "edit" | "command" | "tool";
  title: string;
  input: unknown;
  output: unknown;
  failed: boolean;
  exitCode: number | null;
  snapshot: string | null; // state after this step (closest snapshot at or before it)
  changed: boolean;
  files: ReceiptFile[];
};
export type ReceiptAgent = { id: string; type: string; parent: string | null; steps: number; failures: number; startedAt: string | null; stoppedAt: string | null; lastMessage: string | null };
export type ReceiptTurn = { id: string; n: number; prompt: string; at: string; snapshot: string | null };
export type ReceiptModule = { path: string; files: string[]; steps: number[]; agents: string[]; add: number; del: number };
export type ReceiptPending = { id: string; at: string; agent: string; tool: string; kind: ReceiptStep["kind"]; title: string; toolUseId: string | null };
export type Receipt = {
  version: 1;
  generatedAt: string;
  status: "running" | "done" | "idle";
  lastEventAt: string | null;
  pending: ReceiptPending[];
  session: { id: string; model: string | null; startedAt: string; title: string; lastMessage: string | null };
  repo: { root: string; name: string; branch: string | null; head: string | null };
  baseline: string | null;
  final: string | null;
  agents: ReceiptAgent[];
  turns: ReceiptTurn[];
  steps: ReceiptStep[];
  modules: ReceiptModule[];
  rewinds: { at: string; toSnapshot: string; safety: string; toStep: number | null; undo: boolean }[];
  stats: { steps: number; edits: number; commands: number; failures: number; filesChanged: number; agents: number; add: number; del: number };
};

const GENERIC_ROOTS = new Set(["src", "lib", "app", "apps", "packages", "pkg", "internal", "cmd", "services", "modules"]);

export function moduleOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  if (GENERIC_ROOTS.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function commandOf(input: unknown): string | null {
  if (input && typeof input === "object") {
    const c = (input as Record<string, unknown>).command ?? (input as Record<string, unknown>).cmd;
    if (Array.isArray(c)) return c.map(String).join(" ");
    if (typeof c === "string") return c;
  }
  return typeof input === "string" ? input : null;
}

export function patchFiles(input: unknown): string[] {
  const text = commandOf(input) ?? str(input);
  const out: string[] = [];
  for (const m of text.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/\*\*\* Move to: (.+)/g)) out.push(m[1].trim());
  return [...new Set(out)];
}

export function detectFailure(output: unknown): { failed: boolean; exitCode: number | null } {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const k of ["exit_code", "exitCode", "returncode", "status_code"]) {
      if (typeof o[k] === "number") return { failed: o[k] !== 0, exitCode: o[k] as number };
    }
    if (o.success === false || o.is_error === true || o.isError === true || (typeof o.error === "string" && o.error)) return { failed: true, exitCode: null };
  }
  const text = str(output);
  const m = text.match(/(?:Exit code|exit code|exited with code|Process exited with code)[:\s]+(-?\d+)/);
  if (m) return { failed: Number(m[1]) !== 0, exitCode: Number(m[1]) };
  return { failed: false, exitCode: null };
}

function relPath(root: string, p: string): string {
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}

function stepTitle(tool: string, input: unknown, files: string[], root: string): { kind: ReceiptStep["kind"]; title: string } {
  if (tool === "apply_patch" || tool === "Edit" || tool === "Write") {
    const names = (files.length ? files : patchFiles(input)).map((f) => relPath(root, f));
    return { kind: "edit", title: names.length ? `Edit ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}` : "Apply patch" };
  }
  const cmd = commandOf(input);
  if (cmd && /bash|shell|exec|command|local_shell/i.test(tool)) return { kind: "command", title: cmd.length > 140 ? cmd.slice(0, 140) + "…" : cmd };
  return { kind: "tool", title: tool };
}

// Snapshot commits are immutable, so diffs between two of them can be cached for live refreshes.
const diffCache = new Map<string, ReceiptFile[]>();
function stepFiles(root: string, from: string, to: string): ReceiptFile[] {
  const key = `${root}\0${from}..${to}`;
  let files = diffCache.get(key);
  if (!files) {
    files = changedFiles(root, from, to).map((f) => ({ ...f, diff: fileDiff(root, from, to, f.path) }));
    if (diffCache.size > 2000) diffCache.clear();
    diffCache.set(key, files);
  }
  return files.map((f) => ({ ...f }));
}

const IDLE_MS = 10 * 60 * 1000;

export function buildReceipt(repo: RepoInfo, sessionId: string): Receipt {
  const meta = readMeta(repo, sessionId);
  if (!meta) throw new Error(`No recorded session ${sessionId}`);
  const events = readEvents(repo, sessionId);

  const agents = new Map<string, ReceiptAgent>();
  agents.set("main", { id: "main", type: "main", parent: null, steps: 0, failures: 0, startedAt: meta.startedAt, stoppedAt: null, lastMessage: null });
  const turns: ReceiptTurn[] = [];
  const steps: ReceiptStep[] = [];
  const rewinds: Receipt["rewinds"] = [];
  let prevSnap: string | null = null;
  let lastSnap: string | null = null;
  let lastMessage: string | null = null;
  const snapToStep = new Map<string, number>();
  const pre = new Map<string, RecordedEvent>();

  for (const ev of events) {
    const agentId = ev.agentId || "main";
    if (ev.kind === "agent-start" || ev.kind === "agent-stop") {
      const a = agents.get(agentId) ?? { id: agentId, type: ev.agentType || "subagent", parent: "main", steps: 0, failures: 0, startedAt: null, stoppedAt: null, lastMessage: null };
      if (ev.kind === "agent-start") a.startedAt = ev.at;
      else {
        a.stoppedAt = ev.at;
        a.lastMessage = ev.lastMessage ?? null;
      }
      if (ev.agentType) a.type = ev.agentType;
      agents.set(agentId, a);
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
      rewinds.push({ at: ev.at, toSnapshot: ev.toSnapshot!, safety: ev.safety!, toStep: undo ? null : snapToStep.get(ev.toSnapshot!) ?? null, undo });
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
    // step
    if (ev.toolUseId) pre.delete(ev.toolUseId);
    if (!agents.has(agentId)) agents.set(agentId, { id: agentId, type: ev.agentType || "subagent", parent: "main", steps: 0, failures: 0, startedAt: ev.at, stoppedAt: null, lastMessage: null });
    const tool = ev.tool || "tool";
    let files: ReceiptFile[] = [];
    if (ev.snapshot && prevSnap) {
      const claimed = new Set(patchFiles(ev.input).map((f) => relPath(repo.root, f)));
      files = stepFiles(repo.root, prevSnap, ev.snapshot).map((f) => (claimed.size && !claimed.has(f.path) ? { ...f, foreign: true } : f));
    } else if (ev.snapshot && !prevSnap) {
      files = [];
    }
    const { failed, exitCode } = detectFailure(ev.output);
    const { kind, title } = stepTitle(tool, ev.input, files.filter((f) => !f.foreign).map((f) => f.path), repo.root);
    const n = steps.length + 1;
    const snapshot = ev.snapshot ?? lastSnap;
    steps.push({ n, id: ev.id, at: ev.at, turn: ev.turnId ?? null, agent: agentId, tool, kind, title, input: ev.input, output: ev.output, failed, exitCode, snapshot, changed: !!ev.snapshot, files });
    // Label a state with the latest step that ended in it (e.g. a passing test run).
    if (snapshot) snapToStep.set(snapshot, n);
    if (ev.snapshot) prevSnap = lastSnap = ev.snapshot;
    const a = agents.get(agentId)!;
    a.steps++;
    if (failed) a.failures++;
  }

  const modules = new Map<string, ReceiptModule>();
  const allFiles = new Set<string>();
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
  const lastWork = events.reduce((i, e, idx) => (e.kind !== "rewind" && e.kind !== "stop" ? idx : i), -1);
  // A pending call older than the last stop never finished (e.g. it was interrupted).
  const stopAt = lastStopIdx >= 0 ? events[lastStopIdx].at : "";
  const pending: ReceiptPending[] = [...pre.values()]
    .filter((e) => e.at > stopAt)
    .map((e) => {
      const tool = e.tool || "tool";
      const { kind, title } = stepTitle(tool, e.input, [], repo.root);
      return { id: e.id, at: e.at, agent: e.agentId || "main", tool, kind, title, toolUseId: e.toolUseId ?? null };
    });
  const lastEventAt = events.length ? events[events.length - 1].at : null;
  let status: Receipt["status"] = lastStopIdx >= 0 && lastStopIdx > lastWork && !pending.length ? "done" : "running";
  if (status === "running" && lastEventAt && Date.now() - Date.parse(lastEventAt) > IDLE_MS) status = "idle";
  for (const p of pending) if (!agents.has(p.agent)) agents.set(p.agent, { id: p.agent, type: "subagent", parent: "main", steps: 0, failures: 0, startedAt: p.at, stoppedAt: null, lastMessage: null });

  const firstPrompt = turns[0]?.prompt ?? "";
  const title = firstPrompt ? (firstPrompt.length > 90 ? firstPrompt.slice(0, 90) + "…" : firstPrompt) : `Session ${sessionId.slice(0, 8)}`;
  const sum = (k: "add" | "del") => steps.reduce((t, s) => t + s.files.reduce((u, f) => u + f[k], 0), 0);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
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
      del: sum("del"),
    },
  };
}

export function receiptPathFor(repo: Pick<RepoInfo, "root">, sessionId: string, startedAt: string): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return join(repo.root, RECEIPT_DIR, `${stamp}-${safeId(sessionId).slice(0, 8)}${RECEIPT_EXT}`);
}

export function ensureExcluded(repo: RepoInfo): void {
  const infoDir = join(repo.gitDir, "info");
  const exclude = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === `${RECEIPT_DIR}/`)) appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${RECEIPT_DIR}/\n`);
}

export function exportReceipt(repo: RepoInfo, sessionId: string): { path: string; receipt: Receipt } {
  const receipt = buildReceipt(repo, sessionId);
  ensureExcluded(repo);
  const path = receiptPathFor(repo, sessionId, receipt.session.startedAt);
  mkdirSync(join(repo.root, RECEIPT_DIR), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  return { path, receipt };
}

export function loadReceipt(path: string): Receipt {
  const r = JSON.parse(readFileSync(path, "utf8")) as Receipt;
  if (r.version !== 1 || !Array.isArray(r.steps)) throw new Error("Not an Agent Receipts v1 file");
  return r;
}

/** Commit that existed at the end of a receipt, verified to be a real object in this repo. */
export function verifySnapshot(repo: RepoInfo, sha: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(sha) && tryGit(repo.root, ["cat-file", "-e", `${sha}^{commit}`]) !== null;
}
