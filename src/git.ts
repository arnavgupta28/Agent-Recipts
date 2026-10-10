// Git plumbing for snapshots and restore.
// Never touches HEAD, branches, the user's index or the stash: every write
// goes through a private index file (GIT_INDEX_FILE) and hidden refs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, rmdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "agent-receipts",
  GIT_AUTHOR_EMAIL: "agent-receipts@localhost",
  GIT_COMMITTER_NAME: "agent-receipts",
  GIT_COMMITTER_EMAIL: "agent-receipts@localhost",
};

export function git(cwd: string, args: string[], opts: { index?: string; input?: string } = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...AUTHOR_ENV };
  if (opts.index) env.GIT_INDEX_FILE = opts.index;
  // Hooks run inside Codex sessions; keep git quiet and non-interactive.
  env.GIT_TERMINAL_PROMPT = "0";
  return execFileSync("git", args, {
    cwd,
    env,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();
}

export function tryGit(cwd: string, args: string[], opts: { index?: string } = {}): string | null {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
}

export type RepoInfo = { root: string; gitDir: string; name: string; branch: string | null; head: string | null };

export function repoInfo(cwd: string): RepoInfo | null {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const gitDirRaw = git(root, ["rev-parse", "--absolute-git-dir"]);
  const branch = tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const head = tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return { root, gitDir: gitDirRaw, name: root.split("/").pop() || root, branch: branch || null, head: head || null };
}

/** Snapshot the working tree (tracked + untracked, minus ignored) into a commit. */
export function snapshotTree(root: string, indexFile: string, parent: string | null, message: string): { tree: string; commit: string } {
  // A missing index plus `add -A` hashes everything once; later calls are incremental.
  withIndexRetry(() => git(root, ["add", "-A", "--", "."], { index: indexFile }));
  const tree = git(root, ["write-tree"], { index: indexFile });
  const args = ["commit-tree", tree, "-m", message];
  if (parent) args.splice(2, 0, "-p", parent);
  const commit = git(root, args);
  return { tree, commit };
}

function withIndexRetry<T>(fn: () => T): T {
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as { stderr?: string }).stderr ?? err);
      if (!msg.includes("index.lock")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + i * 25);
    }
  }
  throw lastErr;
}

export function treeOf(root: string, commit: string): string {
  return git(root, ["rev-parse", `${commit}^{tree}`]);
}

export function updateRef(root: string, ref: string, commit: string): void {
  git(root, ["update-ref", ref, commit]);
}

export type FileChange = { path: string; status: string; add: number; del: number; oldPath?: string };

export function changedFiles(root: string, from: string, to: string): FileChange[] {
  if (treeOf(root, from) === treeOf(root, to)) return [];
  const status = git(root, ["diff", "--name-status", "-M", "--no-color", from, to]);
  const numstat = git(root, ["diff", "--numstat", "-M", "--no-color", from, to]);
  const counts = new Map<string, { add: number; del: number }>();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    const p = rest[rest.length - 1];
    counts.set(p, { add: a === "-" ? 0 : Number(a), del: d === "-" ? 0 : Number(d) });
  }
  const out: FileChange[] = [];
  for (const line of status.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const code = parts[0][0];
    const path = parts[parts.length - 1];
    const c = counts.get(path) ?? counts.get(`${parts[1]} => ${path}`) ?? { add: 0, del: 0 };
    out.push({ path, status: code, add: c.add, del: c.del, ...(parts.length > 2 ? { oldPath: parts[1] } : {}) });
  }
  return out;
}

export function fileDiff(root: string, from: string, to: string, path: string, cap = 20000): string {
  const text = tryGit(root, ["diff", "--no-color", "-U3", from, to, "--", path]) ?? "";
  return text.length > cap ? text.slice(0, cap) + "\n… diff truncated …" : text;
}

/**
 * Restore the working tree to exactly match `target`.
 * Files in `current` but not in `target` are deleted; everything else is
 * checked out from `target` through a throwaway index.
 */
export function restoreTree(root: string, current: string, target: string): { deleted: string[]; restored: number } {
  const list = (c: string) => new Set(git(root, ["ls-tree", "-r", "--name-only", "-z", c]).split("\0").filter(Boolean));
  const now = list(current);
  const want = list(target);
  const deleted: string[] = [];
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

function pruneEmptyDirs(root: string, dir: string): void {
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
