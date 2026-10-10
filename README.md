# Agent Receipts

See exactly what your coding agent did, step by step and agent by agent, and rewind your files to any step.

- **Hooks** record every Codex tool call: which agent ran it, input, output, pass or fail.
- **Hidden git snapshots** after each step, in `refs/agent-receipts/*`. Your HEAD, branch, index and stash are never touched. Ignored files like `.env` are never captured or changed.
- **A `.receipt` file viewer** inside ChatGPT and the Codex app: modules → files → the exact diff, an agent tree, a timeline, and one-click **rewind** that can always be undone.
- **A live run graph**: one lane per agent and one node per step. Spawn and hand-back lines connect the agents, failures show in red, and steps that are running now pulse. It updates every second while the agent works.
- **Explain this run** sends a compact summary to ChatGPT to name the root cause.

## Docs

Requirements, architecture, build plan, demo script and research notes are in [`docs/`](docs/). Start with [docs/01-PRD.md](docs/01-PRD.md). Meet the cast in [docs/characters.html](docs/characters.html).

## Quick start (no Codex needed)

```sh
npm install
npm run build
node dist/cli.js simulate          # builds ./demo-shop-api, records a 3-agent run, opens the viewer
node dist/cli.js simulate --live   # same run replayed slowly, so you watch the graph grow live
```

The simulated run is real. A refactor agent and a tests agent work on a tiny API. The refactor agent introduces an off-by-one bug, and `node --test` really fails. Click **Rewind to after #6** and the tests pass again.

## Use in VS Code (recommended)

The `vscode/` folder is a VS Code extension. It shows the live run graph and receipt in a panel beside the Codex chat, puts what Codex is doing right now in the status bar, and opens diffs in VS Code's native diff editor.

```sh
node vscode/build.mjs && (cd vscode && ../node_modules/.bin/vsce package --no-dependencies --skip-license -o agent-receipts.vsix)
code --install-extension vscode/agent-receipts.vsix
```

Then, from the command palette:
1. **Agent Receipts: Set Up Recording for Codex**. This writes hooks to the repo's `.codex/hooks.json` or to `~/.codex/hooks.json`.
2. **Agent Receipts: Review & Trust Codex Hooks**. In the Codex terminal that opens, type `/hooks` and trust them.
3. Start a new Codex chat. The panel opens as soon as Codex starts working.

**Agent Receipts: Run Live Demo** replays a 3-agent run without Codex.

> The Codex engine bundled with the VS Code extension (0.162) has removed plugin-bundled hooks (`plugin_hooks: removed`). Hooks must live in a `hooks.json` config file, which is what the setup command writes.

## Use with Codex CLI / ChatGPT

**Option A: as a plugin** (hooks + skill + MCP server + file viewer)

This folder is a Codex plugin (`.codex-plugin/plugin.json`) and a local marketplace (`.agents/plugins/marketplace.json`). Add it as a local plugin source in Codex, install **Agent Receipts** from `/plugins`, then run `/hooks` and trust its hooks. Start a new session.

**Option B: hooks + MCP server directly**

```sh
node dist/cli.js install --cwd /path/to/your/repo     # writes <repo>/.codex/hooks.json
codex mcp add agent-receipts -- node "$(pwd)/dist/server.js"
```

Then run `/hooks` in Codex and trust them.

Ask Codex *"show me the receipt"*, or open `<repo>/.agent-receipts/*.receipt`.

## CLI

```sh
node dist/cli.js list     --cwd <repo>
node dist/cli.js export   --cwd <repo> [--session ID]
node dist/cli.js view     [file.receipt] [--cwd <repo>] [--port N]
node dist/cli.js rewind   --to <snapshot> --cwd <repo>     # prints an undo command
```

## How it works

| Piece | File |
|---|---|
| Hook entry (stdin JSON → event + snapshot, always exits 0) | `src/hook.ts`, `src/recorder.ts` |
| Snapshots and restore through a private git index | `src/git.ts`, `src/rewind.ts` |
| Receipt builder | `src/receipt.ts` |
| MCP server: `receipts.open` (file viewer), `receipts.show`, `receipts.list`, `receipts.rewind` | `src/server.ts` |
| Viewer UI (MCP App, or browser via `view`) | `src/ui/` |

Storage: `<repo>/.git/agent-receipts/<session>/` holds events, plus `<repo>/.agent-receipts/*.receipt`, which is added to `.git/info/exclude`.

## Tests

```sh
npm run build && npm test
```

The tests cover receipt correctness, rewind and undo, deleting agent-created files, protecting ignored files, rejecting non-snapshot commits, secret redaction, and the hook never failing the agent.
