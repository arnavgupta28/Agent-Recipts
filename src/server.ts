// MCP server for the Agent Receipts plugin.
//   receipts.open    file viewer entrypoint for .receipt files (ChatGPT / Codex app)
//   receipts.show    model-callable: render the latest receipt for a repo inline
//   receipts.list    model-callable: list recorded sessions for a repo
//   receipts.rewind  app-only, destructive: restore files to a snapshot
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OpenAIFileEntrypointInputSchema, getResourcePath } from "@openai/mcp-extensions/server";
import { z } from "zod/v4";
import { repoInfo } from "./git.js";
import { listSessions } from "./store.js";
import { exportReceipt, loadReceipt, RECEIPT_EXT, type Receipt } from "./receipt.js";
import { rewind } from "./rewind.js";
import { viewerHtml } from "./html.js";

const VIEWER_URI = "ui://agent-receipts/viewer-v1";
const MIME = "text/html;profile=mcp-app";
const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function summary(r: Receipt, path?: string): string {
  const fail = r.steps.filter((s) => s.failed);
  const lines = [
    `Agent Receipt for "${r.session.title}" in ${r.repo.name}${path ? ` (${path})` : ""}.`,
    `${r.stats.steps} steps by ${r.stats.agents} agents, ${r.stats.filesChanged} files changed (+${r.stats.add} −${r.stats.del}), ${r.stats.failures} failed.`,
    ...fail.map((s) => `Failed: step #${s.n} by ${s.agent} — ${s.title}`),
    "The user can drill into modules, files and diffs, and rewind files to any step in the viewer.",
  ];
  return lines.join("\n");
}

const ok = (data: Record<string, unknown>, text: string) => ({ content: [{ type: "text" as const, text }], structuredContent: data });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], structuredContent: { error: message }, isError: true });

function register(server: McpServer): void {
  const icons = [{ src: "data:image/svg+xml;utf8," + encodeURIComponent(ICON), mimeType: "image/svg+xml", sizes: ["any"] }];

  server.registerResource("agent-receipts-viewer", VIEWER_URI, { title: "Agent Receipts", mimeType: MIME }, async (uri: URL) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: MIME,
        text: viewerHtml("mcp"),
        _meta: { ui: { prefersBorder: true }, "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] } },
      },
    ],
  }));

  server.registerTool(
    "receipts.open",
    {
      title: "Agent Receipts viewer",
      description: "Open an Agent Receipts (.receipt) file in the interactive viewer.",
      inputSchema: OpenAIFileEntrypointInputSchema,
      icons,
      annotations: readonly,
      _meta: { ui: { resourceUri: VIEWER_URI }, "openai/ui": { entrypoints: [{ type: "file", extensions: [RECEIPT_EXT] }] } },
    },
    async (args: { file: { name: string; resourceUri: string } }, context: { mcpReq?: { _meta?: unknown } }) => {
      // Prefer reading the file server-side; the app falls back to resources.read.
      const path = getResourcePath(context?.mcpReq?._meta as never);
      if (!path) return ok({ file: args.file }, `Opening ${args.file.name}`);
      try {
        const receipt = loadReceipt(path);
        return ok({ receipt, path }, summary(receipt, path));
      } catch (err) {
        return fail(`Could not read receipt: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "receipts.show",
    {
      title: "Show agent receipt",
      description:
        "Show what a coding agent did in a git repository: an interactive receipt with every step, which agent did it, file diffs, failures, and one-click rewind to any step. Use when the user asks what the agent changed, what went wrong, wants an audit trail, or wants to undo/rewind agent changes.",
      inputSchema: z.object({
        cwd: z.string().describe("Absolute path to the repository (usually the current working directory)."),
        session: z.string().optional().describe("Session id or prefix. Defaults to the most recent session."),
      }),
      icons,
      annotations: readonly,
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ cwd, session }: { cwd: string; session?: string }) => {
      const repo = repoInfo(cwd);
      if (!repo) return fail(`Not a git repository: ${cwd}`);
      const sessions = listSessions(repo);
      if (!sessions.length) return fail("No recorded agent sessions in this repository yet. Make sure the Agent Receipts hooks are trusted (/hooks in Codex).");
      const hit = session ? sessions.find((s) => s.sessionId.startsWith(session)) : sessions[0];
      if (!hit) return fail(`No session matching ${session}`);
      const { path, receipt } = exportReceipt(repo, hit.sessionId);
      return ok({ receipt, path }, summary(receipt, path));
    },
  );

  server.registerTool(
    "receipts.list",
    {
      title: "List agent sessions",
      description: "List recorded Codex sessions (receipts) for a git repository, newest first.",
      inputSchema: z.object({ cwd: z.string().describe("Absolute path to the repository.") }),
      annotations: readonly,
    },
    async ({ cwd }: { cwd: string }) => {
      const repo = repoInfo(cwd);
      if (!repo) return fail(`Not a git repository: ${cwd}`);
      const sessions = listSessions(repo);
      return ok({ sessions }, sessions.length ? sessions.map((s) => `${s.sessionId}  updated ${s.updatedAt}  ${s.events} events`).join("\n") : "No recorded sessions.");
    },
  );

  server.registerTool(
    "receipts.rewind",
    {
      title: "Rewind files to a step",
      description: "Restore the repository's working tree to an Agent Receipts snapshot. Takes a safety snapshot first so it can be undone.",
      inputSchema: z.object({ root: z.string(), session: z.string(), snapshot: z.string().regex(/^[0-9a-f]{7,64}$/) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ root, session, snapshot }: { root: string; session: string; snapshot: string }) => {
      const repo = repoInfo(root);
      if (!repo) return fail(`Not a git repository: ${root}`);
      try {
        const r = rewind(repo, session, snapshot);
        return ok({ receipt: r.receipt, safety: r.safety, deleted: r.deleted }, `Restored files to snapshot ${snapshot.slice(0, 10)}. Undo snapshot: ${r.safety}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>`;

export function createServer(): McpServer {
  const server = new McpServer({ name: "agent-receipts", version: "0.1.0" });
  register(server);
  return server;
}

serveStdio(() => createServer());
