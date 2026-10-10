// Turns one Codex hook payload into a recorded event (+ snapshot).
// Shared by the real hook, the simulator and the tests.
import { repoInfo, snapshotTree, treeOf, updateRef, type RepoInfo } from "./git.js";
import { ensureSession, newEventId, readMeta, refFor, writeEvent, writeMeta, sessionDir, type RecordedEvent } from "./store.js";
import { exportReceipt } from "./receipt.js";
import { join } from "node:path";

export type HookPayload = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  model?: string;
  source?: string;
  turn_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  agent_id?: string;
  agent_type?: string;
  last_assistant_message?: string | null;
  [k: string]: unknown;
};

const PREVIEW_CAP = 4000;
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(xox[abpr]-[A-Za-z0-9-]{10,})/g,
  /("?(?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === "string" && m.startsWith(p1) ? `${p1}[redacted]` : "[redacted]"));
  return out;
}

export function preview(value: unknown, cap = PREVIEW_CAP): unknown {
  if (value == null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const red = redact(text);
  if (typeof value === "string" || red.length > cap) return red.length > cap ? red.slice(0, cap) + " …[truncated]" : red;
  try {
    return JSON.parse(red);
  } catch {
    return red;
  }
}

export type RecordResult = { recorded: RecordedEvent | null; repo: RepoInfo | null; receiptPath?: string };

export function record(payload: HookPayload): RecordResult {
  const repo = repoInfo(payload.cwd);
  if (!repo || !payload.session_id) return { recorded: null, repo };
  const sessionId = payload.session_id;
  const now = new Date().toISOString();
  const base = { id: newEventId(), at: now, sessionId, turnId: payload.turn_id, agentId: payload.agent_id, agentType: payload.agent_type };
  const meta = ensureSession(repo, sessionId, { model: payload.model });
  const index = join(sessionDir(repo, sessionId), "index");

  const snap = (label: string, eventId: string): string | null => {
    const cur = readMeta(repo, sessionId) ?? meta;
    const { tree, commit } = snapshotTree(repo.root, index, cur.last ?? null, label);
    if (cur.last && treeOf(repo.root, cur.last) === tree) return null;
    updateRef(repo.root, refFor(sessionId, eventId), commit);
    writeMeta(repo, { ...cur, last: commit, baseline: cur.baseline ?? commit });
    return commit;
  };

  let ev: RecordedEvent;
  switch (payload.hook_event_name) {
    case "SessionStart": {
      ev = { ...base, kind: "session", model: payload.model, source: payload.source };
      const cur = readMeta(repo, sessionId) ?? meta;
      if (!cur.baseline) ev.snapshot = snap("agent-receipts baseline", ev.id);
      break;
    }
    case "UserPromptSubmit": {
      ev = { ...base, kind: "turn", prompt: String(preview(payload.prompt ?? "", 2000)) };
      // Capture anything the user changed by hand between turns.
      const cur = readMeta(repo, sessionId) ?? meta;
      ev.snapshot = cur.baseline ? snap("agent-receipts turn start", ev.id) : snap("agent-receipts baseline", ev.id);
      break;
    }
    case "PreToolUse": {
      // No snapshot: just mark the call as running so viewers can show it live.
      ev = { ...base, kind: "pre", tool: payload.tool_name, toolUseId: payload.tool_use_id, input: preview(payload.tool_input, 1000) };
      break;
    }
    case "PostToolUse": {
      ev = {
        ...base,
        kind: "step",
        tool: payload.tool_name,
        toolUseId: payload.tool_use_id,
        input: preview(payload.tool_input),
        output: preview(payload.tool_response),
      };
      // If SessionStart was missed, this first snapshot doubles as the baseline.
      ev.snapshot = snap(`agent-receipts ${payload.tool_name ?? "tool"}`, ev.id);
      break;
    }
    case "SubagentStart":
      ev = { ...base, kind: "agent-start" };
      break;
    case "SubagentStop":
      ev = { ...base, kind: "agent-stop", lastMessage: (preview(payload.last_assistant_message ?? null, 2000) as string | null) ?? null };
      break;
    case "Stop":
      ev = { ...base, kind: "stop", lastMessage: (preview(payload.last_assistant_message ?? null, 2000) as string | null) ?? null };
      break;
    default:
      return { recorded: null, repo };
  }
  writeEvent(repo, ev);
  let receiptPath: string | undefined;
  if (ev.kind === "stop") receiptPath = exportReceipt(repo, sessionId).path;
  return { recorded: ev, repo, receiptPath };
}
