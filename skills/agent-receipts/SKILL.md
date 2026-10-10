---
name: agent-receipts
description: Show what a coding agent did in this repo and rewind files to any step. Use when the user asks what the agent (or a subagent) changed, why something broke during an agent run, wants an audit trail or receipt, or wants to undo, roll back or rewind agent changes.
---

# Agent Receipts

Agent Receipts records every tool call in this Codex session through hooks. For each step it stores the agent that made it, its input and output, and a hidden git snapshot of the working tree. Snapshots live in `refs/agent-receipts/*`. They never touch HEAD, the branch, the index or the stash.

## When the user asks what happened

1. Call the `receipts.show` tool with `cwd` set to the repository root. This renders the interactive receipt.
2. In one or two sentences, summarise what the tool returned: steps, agents, failures and the failing step.
3. Point the user at the viewer. They can drill from modules to files to diffs, filter by agent, and rewind.

If `receipts.show` says there are no sessions, the hooks are probably not trusted yet. Tell the user to run `/hooks` and trust the Agent Receipts hooks.

## When the user asks to undo or rewind

- Prefer the viewer's **Rewind** button, which asks for confirmation and offers undo.
- From the terminal, run:
  ```sh
  node "$PLUGIN_ROOT/dist/cli.js" rewind --to <snapshot-sha> --cwd <repo>
  ```
  The command prints an undo command. Always show it to the user.
- Never rewind without the user's explicit request. Never use `git reset --hard` or `git checkout .` for this.

## Other commands

```sh
node "$PLUGIN_ROOT/dist/cli.js" list   --cwd <repo>       # recorded sessions
node "$PLUGIN_ROOT/dist/cli.js" export --cwd <repo>       # write .agent-receipts/<session>.receipt
node "$PLUGIN_ROOT/dist/cli.js" view   --cwd <repo>       # open the viewer in a browser
```

Receipt files are written to `<repo>/.agent-receipts/`. That folder is added to `.git/info/exclude`, so it never shows up in commits.
