#!/usr/bin/env node
// agent-receipts CLI: list | export | view | rewind | install | simulate
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { repoInfo, type RepoInfo } from "./git.js";
import { listSessions, readMeta } from "./store.js";
import { buildReceipt, exportReceipt, loadReceipt, RECEIPT_DIR, RECEIPT_EXT, type Receipt } from "./receipt.js";
import { rewind } from "./rewind.js";
import { simulate } from "./simulate.js";
import { viewerHtml } from "./html.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | true> } {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

function needRepo(cwd: string): RepoInfo {
  const repo = repoInfo(cwd);
  if (!repo) throw new Error(`Not inside a git repository: ${cwd}`);
  return repo;
}

function pickSession(repo: RepoInfo, wanted?: string | true): string {
  const sessions = listSessions(repo);
  if (!sessions.length) throw new Error("No recorded sessions in this repo yet. Run Codex with the plugin, or try `agent-receipts simulate`.");
  if (typeof wanted === "string" && wanted !== "latest") {
    const hit = sessions.find((s) => s.sessionId === wanted || s.sessionId.startsWith(wanted));
    if (!hit) throw new Error(`No session matching ${wanted}`);
    return hit.sessionId;
  }
  return sessions[0].sessionId;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* user can open it manually */
  }
}

type ViewSource = { file?: string; root?: string; session?: string };

/** Returns a loader that rebuilds the receipt from recorded events (live), falling back to the file. */
function receiptLoader(src: ViewSource): { load: () => Receipt; label: string } {
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
    },
  };
}

function view(src: ViewSource, port: number, open: boolean): Promise<void> {
  const token = randomBytes(16).toString("hex");
  const loader = receiptLoader(src);
  let current: Receipt = loader.load();
  const receiptPath = loader.label;
  const server = createServer((req, res) => {
    const send = (code: number, body: string, type = "application/json") => {
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
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { snapshot } = JSON.parse(body || "{}") as { snapshot?: string };
            if (!snapshot) return send(400, JSON.stringify({ error: "snapshot required" }));
            const repo = needRepo(current.repo.root);
            const r = rewind(repo, current.session.id, snapshot);
            current = r.receipt;
            send(200, JSON.stringify({ receipt: r.receipt, safety: r.safety, deleted: r.deleted }));
          } catch (err) {
            send(500, JSON.stringify({ error: (err as Error).message }));
          }
        });
        return;
      }
      send(404, JSON.stringify({ error: "not found" }));
    } catch (err) {
      send(500, JSON.stringify({ error: (err as Error).message }));
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

function install(repo: RepoInfo): string {
  const hook = resolve(HERE, "hook.js");
  const cmd = `node "${hook}"`;
  const h = (async: boolean) => [{ hooks: [{ type: "command", command: cmd, timeout: 30, ...(async ? { async: true } : {}) }] }];
  const config = {
    hooks: {
      SessionStart: h(false),
      UserPromptSubmit: h(false),
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd, timeout: 10, async: true }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd, timeout: 30, statusMessage: "Recording receipt" }] }],
      SubagentStart: h(true),
      SubagentStop: h(true),
      Stop: h(true),
    },
  };
  const dir = join(repo.root, ".codex");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "hooks.json");
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    existing.hooks = { ...(existing.hooks ?? {}) };
    for (const [ev, groups] of Object.entries(config.hooks)) {
      const cur = (existing.hooks[ev] ?? []) as unknown[];
      if (!JSON.stringify(cur).includes(hook)) existing.hooks[ev] = [...cur, ...groups];
    }
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  } else writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

const HELP = `agent-receipts — see what your coding agent did, and rewind it

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

async function main(): Promise<void> {
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
      const dir = resolve(typeof flags.dir === "string" ? flags.dir : join(process.cwd(), "demo-shop-api"));
      const live = flags.live !== undefined;
      const delayMs = live ? (typeof flags.live === "string" ? Number(flags.live) : 1500) : 0;
      const showView = flags["no-view"] !== true;
      const r = await simulate({
        dir,
        delayMs,
        log: (m) => console.log(m),
        onReady: live && showView ? async ({ dir: d, sessionId }) => {
          await view({ root: d, session: sessionId }, port, flags["no-open"] !== true);
          await new Promise((res) => setTimeout(res, 2500)); // give the browser a moment to load
        } : undefined,
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
  console.error(`agent-receipts: ${(err as Error).message}`);
  process.exit(1);
});
