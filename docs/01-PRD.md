# Agent Receipts: Product Requirements

**One line:** see exactly what your coding agent did to your codebase, step by step and agent by agent, and rewind your files to any step.

**Event:** DevDay Exchange Community Hackathon, Bengaluru, Oct 10 2026. Build window 10:00 AM to 1:00 PM.

---

## 1. Problem

Codex now runs long, multi-agent tasks. When a run goes wrong, developers can't answer three basic questions:

1. **What happened?** Which commands ran, which files changed, in what order.
2. **Who did it?** Which subagent made which change.
3. **How do I get back?** Rewinding the chat does not undo file edits or command side effects.

### Evidence of demand (open GitHub issues on openai/codex)

| Issue | 👍 |
|---|---|
| [#9203 Please make "/undo" back](https://github.com/openai/codex/issues/9203) | 525 |
| [#11626 /rewind checkpoint restore for chat and code edits](https://github.com/openai/codex/issues/11626) | 228 |
| [#28058 Encrypted MultiAgentV2 messages remove readable task audit trail](https://github.com/openai/codex/issues/28058) | 149 |

### Why existing tools don't solve it

| Tool | Gap |
|---|---|
| `git diff` / `git stash` | Shows the end state only. No steps, no agent attribution, misses untracked files. |
| LangGraph checkpoints | Only for apps built on LangGraph, and only agent state. Doesn't restore files. |
| DeepWiki, CodeViz | Explain a codebase. They don't show what an agent changed. |
| Codex Code Review | Reviews a finished diff. No step history, no rewind. |

---

## 2. Users

| User | Need |
|---|---|
| **Developer running Codex locally** (primary) | Understand and undo a run without reading raw logs |
| **Reviewer of an agent-made PR** | See how the change was produced and by which agent |
| **Team lead** | Audit what agents did in a repo |

---

## 3. Goals and non-goals

### Goals (hackathon scope)
- **G1:** Record every Codex tool call with its agent, turn, input, output and resulting file changes.
- **G2:** Snapshot the working tree after each step without touching the user's branch, HEAD, index or stash.
- **G3:** Show a receipt as an interactive, three-level drill-down: modules → files → code diff.
- **G4:** Rewind the working tree to the state after any step, safely and undoably.
- **G5:** One click asks ChatGPT to explain where the run went wrong.
- **G6:** Ship as one Codex plugin: hooks + skill + MCP server + file viewer.

### Non-goals
- Rewinding the chat context itself. This is a stretch goal only.
- Undoing external side effects like network calls, database writes or `git push`.
- Mapping the whole codebase. The map only shows modules and files the run touched.
- Cloud or team sharing.

---

## 4. User stories

| ID | As a… | I want to… | So that… |
|---|---|---|---|
| US-1 | developer | install one plugin and have receipts recorded automatically | I don't change how I use Codex |
| US-2 | developer | open a `.receipt` file and see the run's timeline | I know what happened |
| US-3 | developer | see which subagent made each change | I can find the agent that broke things |
| US-4 | developer | click a module, then a file, then a step | I go from overview to exact code fast |
| US-5 | developer | rewind files to after step N | I keep the good work and drop the bad |
| US-6 | developer | undo a rewind | rewinding is never scary |
| US-7 | developer | ask "explain this run" in one click | I get the root cause without reading everything |
| US-8 | developer | ask Codex "show me the receipt" | I don't hunt for files |

---

## 5. Functional requirements

### Recording (Codex hooks)
- **FR-1:** On `SessionStart`, take a baseline snapshot of the working tree.
- **FR-2:** On `UserPromptSubmit`, record a turn with the prompt text.
- **FR-3:** On `PostToolUse`, record a step: time, turn, agent id and type, tool name, input preview, output preview, failure flag. Snapshot the tree after the step.
- **FR-4:** On `SubagentStart` and `SubagentStop`, record the agent tree, including the subagent's last message.
- **FR-5:** On `Stop`, regenerate the session's `.receipt` file.
- **FR-6:** Hooks must never block or fail the Codex run. Every error is caught and logged, and the hook exits 0.
- **FR-7:** If a step changed nothing, record it but don't create a new snapshot.

### Snapshots and rewind
- **FR-8:** Snapshots are git commits on hidden refs `refs/agent-receipts/<session>/<step>`, built with a private index. Ignored files are excluded.
- **FR-9:** Rewind restores the working tree to a chosen snapshot. Files added after it are deleted and changed files are restored.
- **FR-10:** Before any rewind, take a safety snapshot and record it, so the rewind itself can be undone.
- **FR-11:** Rewind never changes HEAD, the branch, the real index or the stash.
- **FR-12:** Rewind requires explicit confirmation in the UI.

### Receipt and viewer
- **FR-13:** A receipt is a JSON file with the extension `.receipt`. It is written to `<repo>/.agent-receipts/`, which is added to `.git/info/exclude`.
- **FR-14:** The receipt embeds per-step diffs, capped per file, so it renders without a server.
- **FR-15:** **Level 1, modules:** cards for each touched top-level folder, with edit counts and agent colors.
- **FR-16:** **Level 2, files:** files in the module, with status and the steps that touched them.
- **FR-17:** **Level 3, code:** the diff for the selected step and file, with a rewind button.
- **FR-18:** A timeline lists turns and steps. Selecting a step highlights its files on the map.
- **FR-19:** An agent tree shows main agent → subagents, with step counts. Clicking an agent filters the view.
- **FR-20:** Failed steps are flagged in red.
- **FR-21:** "Explain this run" sends a compact summary to the ChatGPT conversation with `ui/message`.

### Integration
- **FR-22:** MCP tool `receipts.open`, a file viewer for `.receipt` files.
- **FR-23:** MCP tool `receipts.show`, callable by the model, which renders the latest receipt for a repo inline.
- **FR-24:** MCP tool `receipts.rewind`, app-only, destructive, used by the viewer.
- **FR-25:** A skill teaches Codex when to show receipts and how to rewind.
- **FR-26:** CLI `agent-receipts` with `list`, `export`, `view`, `rewind`, `install` and `simulate`.
- **FR-27:** `view` serves the same UI in a browser. This is the demo fallback when plugin extensions aren't available.

---

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | A PostToolUse hook adds under 300 ms on a small repo |
| NFR-2 | Zero runtime network calls. Everything stays local. |
| NFR-3 | Safe under parallel subagents: no shared lock files, one file per event |
| NFR-4 | Secrets: output previews are truncated, and ignored files like `.env` are never snapshotted |
| NFR-5 | Works on macOS and Linux with git ≥ 2.30 and Node ≥ 22 |
| NFR-6 | UI matches ChatGPT light and dark themes |

---

## 7. Acceptance criteria (demo-ready)

- [ ] A simulated multi-agent run produces a receipt with at least 2 subagents, 8 steps and 1 failure.
- [ ] The receipt opens in the browser viewer, and all three map levels work.
- [ ] Rewinding to a step restores files exactly, verified with `git diff` against that snapshot.
- [ ] Undoing the rewind restores the pre-rewind state.
- [ ] HEAD, the branch and `git status --porcelain` of the index are unchanged by recording and rewind.
- [ ] The MCP server starts over stdio and lists `receipts.open`, `receipts.show` and `receipts.rewind`.
- [ ] The plugin folder matches the Codex plugin layout: `.codex-plugin/plugin.json`, `hooks/hooks.json`, `skills/`, `.mcp.json`.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| No plugin extension access at the venue | The browser viewer is the same UI. Demo works either way. |
| Codex hook payload differs from the schema | The hook stores raw payloads, and the parser is defensive |
| Parallel subagents edit at the same time | Attribute files from `apply_patch` input. The diff-based fallback is labelled. |
| Large repos make snapshots slow | Persistent private index per session, so git only rehashes changed files |
| Live demo Wi-Fi | Simulator and recorded video. No network needed. |
