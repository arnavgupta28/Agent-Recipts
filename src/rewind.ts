// Restore the working tree to a recorded snapshot, safely and undoably.
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { git, restoreTree, snapshotTree, tryGit, updateRef, type RepoInfo } from "./git.js";
import { newEventId, readMeta, refFor, sessionDir, writeEvent, writeMeta } from "./store.js";
import { exportReceipt, type Receipt } from "./receipt.js";

export type RewindResult = { safety: string; target: string; deleted: string[]; receiptPath: string; receipt: Receipt };

function isReceiptsCommit(repo: RepoInfo, sha: string): boolean {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return false;
  if (tryGit(repo.root, ["cat-file", "-e", `${sha}^{commit}`]) === null) return false;
  const subject = tryGit(repo.root, ["log", "-1", "--format=%s", sha]) ?? "";
  return subject.startsWith("agent-receipts");
}

export function rewind(repo: RepoInfo, sessionId: string, target: string): RewindResult {
  const meta = readMeta(repo, sessionId);
  if (!meta) throw new Error(`Unknown session ${sessionId}`);
  if (!isReceiptsCommit(repo, target)) throw new Error("Target is not an Agent Receipts snapshot in this repository");
  const index = join(sessionDir(repo, sessionId), "index");
  const id = newEventId();

  // 1. Safety snapshot of the current state, so this rewind can be undone.
  const safety = snapshotTree(repo.root, index, meta.last ?? null, "agent-receipts safety (before rewind)").commit;
  updateRef(repo.root, refFor(sessionId, `${id}-safety`), safety);

  // 2. Make the working tree match the target exactly.
  const { deleted } = restoreTree(repo.root, safety, target);

  // 3. Refresh the private index and record the new state.
  const after = snapshotTree(repo.root, index, safety, "agent-receipts after rewind").commit;
  updateRef(repo.root, refFor(sessionId, id), after);
  writeMeta(repo, { ...meta, last: after });
  writeEvent(repo, { id, kind: "rewind", at: new Date().toISOString(), sessionId, toSnapshot: target, safety, snapshot: after });

  const { path, receipt } = exportReceipt(repo, sessionId);
  return { safety, target, deleted, receiptPath: path, receipt };
}

/** Sanity check used by tests: does the working tree match a commit's tree? */
export function worktreeMatches(repo: RepoInfo, commit: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipts-verify-"));
  try {
    const tmpIndex = join(dir, "index");
    git(repo.root, ["add", "-A", "--", "."], { index: tmpIndex });
    const tree = git(repo.root, ["write-tree"], { index: tmpIndex });
    return tree === git(repo.root, ["rev-parse", `${commit}^{tree}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
