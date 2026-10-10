# Agent Receipts: Build Plan

Code lives in `agent-receipts/` next to `Assets/`. Stack: TypeScript, Node ≥ 22, esbuild, no UI framework.

## Status (Oct 10, 11:40)

P1 to P9 are built. All 6 end-to-end tests pass. Not yet tested inside a real Codex session or the ChatGPT host, because Codex CLI isn't installed on this machine.

## Pre-hackathon (done)

| # | Task | Done when |
|---|---|---|
| P1 | Scaffold plugin layout and build | `npm run build` emits `dist/` |
| P2 | Git snapshot and restore module | Unit test: snapshot, edit, restore matches |
| P3 | Hook recorder | Fixture payloads produce event files and refs |
| P4 | Receipt builder | Simulated run produces a valid `.receipt` |
| P5 | Simulator | `agent-receipts simulate` builds a demo repo with a multi-agent run and one failure |
| P6 | Viewer UI | Three map levels, timeline, agent tree, rewind, explain |
| P7 | Browser viewer and CLI | `agent-receipts view` opens the receipt and rewind works |
| P8 | MCP server | Lists 3 tools and serves the UI resource over stdio |
| P9 | Skill and plugin manifest | Layout matches Codex plugin format |

## At the venue (10:00 to 1:00)

| Time | Task |
|---|---|
| 9:00 – 10:00 | Install Codex CLI. Confirm plugin extension access. Install the plugin locally and trust its hooks with `/hooks`. |
| 10:00 – 10:45 | Run a real multi-agent Codex task on the demo repo. Fix any payload differences in the hook parser. |
| 10:45 – 11:30 | Load the file viewer in ChatGPT or the Codex app. Fix host integration issues. |
| 11:30 – 12:15 | Polish: agent colors, failure highlighting, explain prompt quality. |
| 12:15 – 12:45 | Full demo run twice. Record a backup video. |
| 12:45 – 1:00 | Pitch rehearsal |

## Cut list, in order

1. Stretch: chat context rewind
2. Module grouping by import graph. Folders are enough.
3. Inline widget from `receipts.show`. Keep the file viewer.
4. **Never cut:** recording, rewind, three-level drill-down.
