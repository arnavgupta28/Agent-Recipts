// On-disk layout for recorded sessions.
//   <gitDir>/agent-receipts/<session>/meta.json
//   <gitDir>/agent-receipts/<session>/index          private git index
//   <gitDir>/agent-receipts/<session>/events/*.json  one file per event
//   refs/agent-receipts/<session>/<eventId>          snapshot commits
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RepoInfo } from "./git.js";

export type EventKind = "session" | "turn" | "pre" | "step" | "agent-start" | "agent-stop" | "stop" | "rewind";

export type RecordedEvent = {
  id: string;
  kind: EventKind;
  at: string; // ISO time
  sessionId: string;
  turnId?: string;
  agentId?: string;
  agentType?: string;
  // step
  tool?: string;
  toolUseId?: string;
  input?: unknown;
  output?: unknown;
  snapshot?: string | null; // commit sha after this event, null = unchanged
  // turn
  prompt?: string;
  // agent-stop / stop
  lastMessage?: string | null;
  // rewind
  toSnapshot?: string;
  safety?: string;
  // session
  model?: string;
  source?: string;
};

export type SessionMeta = {
  sessionId: string;
  startedAt: string;
  model?: string;
  repo: { root: string; name: string; branch: string | null; head: string | null };
  baseline?: string;
  last?: string; // last snapshot commit
};

export const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "unknown";
}

export function receiptsDir(repo: Pick<RepoInfo, "gitDir">): string {
  return join(repo.gitDir, "agent-receipts");
}

export function sessionDir(repo: Pick<RepoInfo, "gitDir">, sessionId: string): string {
  return join(receiptsDir(repo), safeId(sessionId));
}

export function refFor(sessionId: string, eventId: string): string {
  return `refs/agent-receipts/${safeId(sessionId)}/${safeId(eventId)}`;
}

/** Time-sortable id: 16-digit ns-ish timestamp + random suffix. */
export function newEventId(): string {
  const ns = process.hrtime.bigint() % 1_000_000n;
  const ms = BigInt(Date.now()) * 1_000_000n + ns;
  return `${ms.toString().padStart(22, "0")}-${randomBytes(3).toString("hex")}`;
}

export function ensureSession(repo: RepoInfo, sessionId: string, init: Partial<SessionMeta>): SessionMeta {
  const dir = sessionDir(repo, sessionId);
  mkdirSync(join(dir, "events"), { recursive: true });
  const metaPath = join(dir, "meta.json");
  if (existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
  const meta: SessionMeta = {
    sessionId,
    startedAt: new Date().toISOString(),
    repo: { root: repo.root, name: repo.name, branch: repo.branch, head: repo.head },
    ...init,
  };
  writeJsonAtomic(metaPath, meta);
  return meta;
}

export function readMeta(repo: Pick<RepoInfo, "gitDir">, sessionId: string): SessionMeta | null {
  const p = join(sessionDir(repo, sessionId), "meta.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SessionMeta) : null;
}

export function writeMeta(repo: Pick<RepoInfo, "gitDir">, meta: SessionMeta): void {
  writeJsonAtomic(join(sessionDir(repo, meta.sessionId), "meta.json"), meta);
}

export function writeEvent(repo: Pick<RepoInfo, "gitDir">, ev: RecordedEvent): void {
  writeJsonAtomic(join(sessionDir(repo, ev.sessionId), "events", `${ev.id}.json`), ev);
}

export function readEvents(repo: Pick<RepoInfo, "gitDir">, sessionId: string): RecordedEvent[] {
  const dir = join(sessionDir(repo, sessionId), "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as RecordedEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is RecordedEvent => e !== null);
}

export type SessionSummary = { sessionId: string; startedAt: string; updatedAt: string; events: number; model?: string };

export function listSessions(repo: Pick<RepoInfo, "gitDir">): SessionSummary[] {
  const dir = receiptsDir(repo);
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const name of readdirSync(dir)) {
    const metaPath = join(dir, name, "meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
    const evDir = join(dir, name, "events");
    const files = existsSync(evDir) ? readdirSync(evDir) : [];
    const updated = files.length ? statSync(join(evDir, files.sort()[files.length - 1])).mtime : statSync(metaPath).mtime;
    out.push({ sessionId: meta.sessionId, startedAt: meta.startedAt, updatedAt: updated.toISOString(), events: files.length, model: meta.model });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function logError(repo: Pick<RepoInfo, "gitDir"> | null, err: unknown): void {
  try {
    const dir = repo ? receiptsDir(repo) : null;
    const line = `${new Date().toISOString()} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "errors.log"), line);
    } else {
      process.stderr.write(line);
    }
  } catch {
    /* never throw from logging */
  }
}
