// Agent Receipts for VS Code: a live run graph + receipt panel beside the Codex chat.
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { repoInfo, tryGit, type RepoInfo } from "../../src/git.js";
import { listSessions, readMeta } from "../../src/store.js";
import { buildReceipt, exportReceipt, type Receipt } from "../../src/receipt.js";
import { rewind } from "../../src/rewind.js";
import { simulate } from "../../src/simulate.js";

const SCHEME = "agent-receipts";
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"] as const;

let panel: vscode.WebviewPanel | undefined;
let status: vscode.StatusBarItem;
let ctx: vscode.ExtensionContext;
let output: vscode.OutputChannel;

/** What the panel is currently showing. */
let current: { repo: RepoInfo; session: string; signature: string } | null = null;
/** Sessions we've already auto-opened, so we only pop the panel once per session. */
const announced = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  output = vscode.window.createOutputChannel("Agent Receipts");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "agentReceipts.open";
  context.subscriptions.push(status, output);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: snapshotContent }),
    vscode.commands.registerCommand("agentReceipts.open", () => openPanel(true)),
    vscode.commands.registerCommand("agentReceipts.welcome", openWalkthrough),
    vscode.commands.registerCommand("agentReceipts.installHooks", installHooks),
    vscode.commands.registerCommand("agentReceipts.trustHooks", trustHooks),
    vscode.commands.registerCommand("agentReceipts.pickSession", pickSession),
    vscode.commands.registerCommand("agentReceipts.demo", runDemo),
  );

  // First run: show the Getting Started walkthrough once.
  if (!context.globalState.get<boolean>("agentReceipts.welcomed")) {
    void context.globalState.update("agentReceipts.welcomed", true);
    setTimeout(() => void openWalkthrough(), 1500);
  }

  // Poll for new events. Cheap (a readdir per repo) and robust across .git watcher excludes.
  const timer = setInterval(() => void tick(), 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void tick();
}

export function deactivate(): void {}

async function openWalkthrough(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${ctx.extension.id}#agentReceipts.start`, false);
}

// ---------- repos & sessions ----------
function workspaceRepos(): RepoInfo[] {
  const seen = new Map<string, RepoInfo>();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const r = repoInfo(f.uri.fsPath);
    if (r && !seen.has(r.root)) seen.set(r.root, r);
  }
  return [...seen.values()];
}

function latestSession(): { repo: RepoInfo; session: string; updatedAt: string } | null {
  let best: { repo: RepoInfo; session: string; updatedAt: string } | null = null;
  for (const repo of workspaceRepos()) {
    const s = listSessions(repo)[0];
    if (s && (!best || s.updatedAt > best.updatedAt)) best = { repo, session: s.sessionId, updatedAt: s.updatedAt };
  }
  return best;
}

const signature = (r: Receipt) => `${r.status}|${r.steps.length}|${r.pending.map((p) => p.id).join(",")}|${r.rewinds.length}|${r.agents.map((a) => `${a.id}:${a.steps}:${a.stoppedAt ?? ""}`).join(",")}`;

async function tick(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("agentReceipts");
    const latest = latestSession();
    if (!latest) {
      status.hide();
      return;
    }
    // Follow the newest session unless the user pinned another one.
    const follow = !current || (!pinned && (current.session !== latest.session || current.repo.root !== latest.repo.root));
    if (follow) current = { repo: latest.repo, session: latest.session, signature: "" };
    if (!current || !readMeta(current.repo, current.session)) return;
    const receipt = buildReceipt(current.repo, current.session);
    updateStatus(receipt);
    const sig = signature(receipt);
    const fresh = !announced.has(current.session);
    if (fresh && receipt.status === "running" && cfg.get<boolean>("autoOpen", true)) {
      announced.add(current.session);
      openPanel(false);
    }
    if (sig !== current.signature) {
      current.signature = sig;
      post({ type: "receipt", receipt });
    }
  } catch (err) {
    output.appendLine(`tick: ${(err as Error).stack ?? err}`);
  }
}
let pinned = false;

function updateStatus(r: Receipt): void {
  if (r.status === "running") {
    const p = r.pending[r.pending.length - 1];
    const who = p ? (p.agent === "main" ? "main" : r.agents.find((a) => a.id === p.agent)?.type ?? p.agent) : null;
    status.text = `$(pulse) Codex${p ? ` · ${who}: ${p.title.slice(0, 40)}` : " running"} · ${r.stats.steps} steps`;
    status.tooltip = "Agent Receipts: Codex is running. Click to open the live run graph.";
    status.backgroundColor = undefined;
  } else {
    status.text = `$(history) Receipt · ${r.stats.steps} steps${r.stats.failures ? ` · $(error) ${r.stats.failures} failed` : ""}`;
    status.tooltip = `Agent Receipts: ${r.session.title}`;
    status.backgroundColor = r.stats.failures ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }
  status.show();
}

// ---------- panel ----------
function openPanel(focus: boolean): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, !focus);
    if (current) post({ type: "receipt", receipt: buildReceipt(current.repo, current.session) });
    return;
  }
  panel = vscode.window.createWebviewPanel("agentReceipts", "Agent Receipts", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "icon.svg");
  const html = readFileSync(join(ctx.extensionPath, "dist", "viewer.html"), "utf8");
  const boot = `<script>window.__AGENT_RECEIPTS__=${JSON.stringify({ mode: "vscode" })};</script>`;
  panel.webview.html = html.replace("<!--BOOT-->", () => boot);
  panel.webview.onDidReceiveMessage(onMessage, undefined, ctx.subscriptions);
  panel.onDidDispose(() => (panel = undefined), undefined, ctx.subscriptions);
}

function post(msg: unknown): void {
  void panel?.webview.postMessage(msg);
}

type Msg =
  | { type: "ready" }
  | { type: "rewind"; id: number; snapshot: string }
  | { type: "explain"; id: number; prompt: string }
  | { type: "openFile"; path: string }
  | { type: "openDiff"; step: number; path: string }
  | { type: "pickSession" };

async function onMessage(msg: Msg): Promise<void> {
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
        post({ type: "reply", id: msg.id, ok: false, error: (err as Error).message });
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
      const uri = vscode.Uri.file(join(repo.root, msg.path));
      if (existsSync(uri.fsPath)) await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, preview: true });
      else void vscode.window.showInformationMessage(`${msg.path} doesn't exist in the working tree right now.`);
      return;
    }
    case "openDiff":
      return openDiff(repo, session, msg.step, msg.path);
    case "pickSession":
      return pickSession();
  }
}

/** Opens the Codex sidebar with the prompt on the clipboard. Returns true only if we could hand it over directly. */
async function sendToCodex(prompt: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("chatgpt.openSidebar");
  } catch {
    /* Codex extension not installed */
  }
  void vscode.window.showInformationMessage("Explain prompt copied. Paste it into the Codex chat (⌘V).");
  void prompt;
  return false;
}

// ---------- native diff ----------
function snapshotContent(uri: vscode.Uri): string {
  const q = new URLSearchParams(uri.query);
  const root = q.get("root")!;
  const commit = q.get("commit");
  const path = q.get("path")!;
  if (!commit) return "";
  return tryGit(root, ["show", `${commit}:${path}`]) ?? "";
}

function snapUri(root: string, commit: string | null, path: string, label: string): vscode.Uri {
  const q = new URLSearchParams({ root, path, ...(commit ? { commit } : {}) });
  return vscode.Uri.from({ scheme: SCHEME, path: `/${label}/${path}`, query: q.toString() });
}

async function openDiff(repo: RepoInfo, session: string, stepN: number, path: string): Promise<void> {
  const r = buildReceipt(repo, session);
  const idx = r.steps.findIndex((s) => s.n === stepN);
  const step = r.steps[idx];
  if (!step?.snapshot) return;
  // "Before" = the newest snapshot strictly before this step's.
  let before: string | null = r.baseline;
  for (let i = idx - 1; i >= 0; i--) {
    if (r.steps[i].changed && r.steps[i].snapshot) {
      before = r.steps[i].snapshot;
      break;
    }
  }
  const turnSnap = [...r.turns].reverse().find((t) => t.at <= step.at && t.snapshot)?.snapshot;
  if (turnSnap && (!before || r.steps.slice(0, idx).every((s) => !s.changed))) before = turnSnap;
  const agent = r.agents.find((a) => a.id === step.agent);
  const who = agent ? (agent.id === "main" ? "main" : agent.type) : step.agent;
  const left = snapUri(repo.root, before, path, "before");
  const right = snapUri(repo.root, step.snapshot, path, `after-step-${stepN}`);
  await vscode.commands.executeCommand("vscode.diff", left, right, `${path.split("/").pop()} · step #${stepN} (${who})`, { viewColumn: vscode.ViewColumn.One, preview: true });
}

// ---------- sessions ----------
async function pickSession(): Promise<void> {
  const items: (vscode.QuickPickItem & { repo?: RepoInfo; session?: string })[] = [{ label: "$(pulse) Follow the latest session", description: "auto" }];
  for (const repo of workspaceRepos()) {
    for (const s of listSessions(repo)) {
      let title = s.sessionId.slice(0, 8);
      try {
        title = buildReceipt(repo, s.sessionId).session.title;
      } catch {
        /* ignore */
      }
      items.push({ label: title, description: `${repo.name} · ${new Date(s.updatedAt).toLocaleString()} · ${s.events} events`, repo, session: s.sessionId });
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

// ---------- hooks ----------
function findNode(): string {
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  try {
    const p = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "command -v node"], { encoding: "utf8", timeout: 5000 }).trim();
    if (p && existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  return candidates.find((c) => existsSync(c)) ?? "node";
}

function hookCommand(): string {
  return `"${findNode()}" "${join(ctx.extensionPath, "dist", "hook.mjs")}"`;
}

function hooksConfig(command: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS) {
    const async = ev === "PreToolUse" || ev === "SubagentStart" || ev === "SubagentStop" || ev === "Stop";
    const handler = { type: "command", command, timeout: ev === "Stop" ? 60 : 30, ...(async ? { async: true } : {}), ...(ev === "PostToolUse" ? { statusMessage: "Recording receipt" } : {}) };
    out[ev] = [{ ...(ev.endsWith("ToolUse") ? { matcher: "*" } : {}), hooks: [handler] }];
  }
  return out;
}

function mergeHooks(path: string, command: string): void {
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  existing.hooks = existing.hooks ?? {};
  const marker = join("dist", "hook.mjs");
  for (const [ev, groups] of Object.entries(hooksConfig(command))) {
    // Drop older Agent Receipts entries, keep everything else the user has.
    const cur = ((existing.hooks[ev] ?? []) as { hooks?: { command?: string }[] }[]).filter((g) => !(g.hooks ?? []).some((h) => h.command?.includes(marker) && h.command?.includes("agent-receipts")));
    existing.hooks[ev] = [...cur, ...groups];
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
}

async function installHooks(): Promise<void> {
  const repos = workspaceRepos();
  const choice = await vscode.window.showQuickPick(
    [
      { label: "This workspace's repo", description: repos[0] ? `${repos[0].root}/.codex/hooks.json` : "open a git repo first", id: "repo" },
      { label: "All repos on this machine", description: "~/.codex/hooks.json (does nothing outside git repos)", id: "user" },
    ],
    { placeHolder: "Where should Codex record agent receipts?" },
  );
  if (!choice) return;
  const command = hookCommand();
  let path: string;
  if (choice.id === "repo") {
    if (!repos[0]) return void vscode.window.showErrorMessage("Open a folder that is a git repository first.");
    path = join(repos[0].root, ".codex", "hooks.json");
  } else path = join(homedir(), ".codex", "hooks.json");
  mergeHooks(path, command);
  output.appendLine(`Wrote hooks to ${path} using: ${command}`);
  const next = await vscode.window.showInformationMessage(
    `Agent Receipts hooks added to ${path}. Codex only runs hooks you've reviewed and trusted.`,
    "Review & trust hooks",
    "Open hooks file",
  );
  if (next === "Review & trust hooks") await trustHooks();
  if (next === "Open hooks file") await vscode.window.showTextDocument(vscode.Uri.file(path));
}

function bundledCodex(): string | null {
  const ext = vscode.extensions.getExtension("openai.chatgpt");
  if (!ext) return null;
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const p = join(ext.extensionPath, "bin", `${os}-${arch}`, process.platform === "win32" ? "codex.exe" : "codex");
  return existsSync(p) ? p : null;
}

async function trustHooks(): Promise<void> {
  const codex = bundledCodex() ?? "codex";
  const cwd = workspaceRepos()[0]?.root ?? tmpdir();
  const term = vscode.window.createTerminal({ name: "Codex · review hooks", cwd });
  term.show();
  term.sendText(`"${codex}"`);
  void vscode.window.showInformationMessage("In the Codex terminal, type /hooks, review the Agent Receipts hooks and trust them. Then start a new Codex chat.");
}

// ---------- demo ----------
async function runDemo(): Promise<void> {
  const target = vscode.Uri.file(join(homedir(), "agent-receipts-demo"));
  const go = await vscode.window.showInformationMessage(
    `Replay a recorded 3-agent run into ${target.fsPath}? The folder is recreated from scratch.`,
    { modal: true },
    "Run live demo",
  );
  if (go !== "Run live demo") return;
  const delayMs = vscode.workspace.getConfiguration("agentReceipts").get<number>("demoDelayMs", 1500);
  const repoFor = (dir: string) => repoInfo(dir)!;
  const node = findNode();
  await simulate({
    dir: target.fsPath,
    delayMs,
    pathPrefix: node.includes("/") ? node.slice(0, node.lastIndexOf("/")) : undefined,
    log: (m) => output.appendLine(m),
    onReady: async ({ dir, sessionId }) => {
      pinned = true;
      current = { repo: repoFor(dir), session: sessionId, signature: "" };
      announced.add(sessionId);
      openPanel(true);
      await new Promise((r) => setTimeout(r, 1200));
    },
  });
}
