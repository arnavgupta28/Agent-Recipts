# Agent Receipts for Codex

A live run graph and receipt for Codex agent runs, in a panel next to the Codex chat.

- **Run graph:** one lane per agent, one node per step. It shows spawn and hand-back lines, failed steps in red, and the step that is running right now.
- **Drill down:** modules, then files, then diffs. **Open diff in editor** uses VS Code's native diff.
- **Rewind:** put your files back to how they were after any step. Every rewind can be undone. Your HEAD, branch, index and ignored files are never touched.
- **Status bar:** shows what Codex is doing right now.

## Setup

1. Run **Agent Receipts: Set Up Recording for Codex** from the command palette.
2. Run **Agent Receipts: Review & Trust Codex Hooks**. Type `/hooks` in the terminal that opens and trust the Agent Receipts hooks.
3. Start a new Codex chat. The run graph opens beside your editor as soon as Codex starts working.

Try **Agent Receipts: Run Live Demo** to watch a recorded 3-agent run without using Codex.
