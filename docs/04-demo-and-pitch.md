# Agent Receipts: Demo and Pitch

## Demo script (2 minutes)

1. **Hook (15s):** "Codex users have asked for /undo 525 times. Multi-agent runs lost their readable audit trail. We fixed both."
2. **Run live (20s):** Start `node dist/cli.js simulate --live`, or a real Codex run. The run graph grows as it happens: the main agent spawns a *refactor* and a *tests* lane, the running step pulses, and the failing test turns red.
3. **Receipt (30s):** Open the `.receipt` file. Show the agent tree, then the timeline with the red failed step.
4. **Drill down (25s):** Click the `src` module, then the file, then step #N's diff. "This is the exact line the refactor agent broke."
5. **Rewind (20s):** Click "Rewind to after step N−1". Run tests, which pass. Click "Undo rewind" to show it's safe.
6. **Explain (10s):** Click "Explain this run". ChatGPT names the root cause.
7. **Close (10s):** "One plugin: hooks record, git snapshots protect, a file viewer explains. Zero changes to how you use Codex."

## Pitch lines

- **Problem:** agents are fast, but you can't see or undo what they did.
- **Insight:** chat rewind isn't enough. The files are what matter.
- **How:** Codex hooks + hidden git snapshots + a live run graph + a ChatGPT file viewer + one skill.
- **No more scrolling:** you see what's running now, and which agent did what, in one glance.
- **Positioning:** "DeepWiki tells you what your codebase is. Agent Receipts tells you what your agent just did to it, and lets you undo it."

## Judge Q&A

| Question | Answer |
|---|---|
| Doesn't git already do this? | Git sees the end state. We record every step, attribute it to an agent, and capture untracked files, without touching your branch. |
| What about LangGraph checkpoints? | Those only cover LangGraph apps and agent state. They don't restore files on disk. |
| Does it slow Codex down? | Snapshots use a private incremental index. Each step adds milliseconds on small repos. |
| Is rewind dangerous? | Every rewind takes a safety snapshot first, so it can be undone. HEAD, branch and index are never touched. |
| What's next? | Chat context rewind, receipts attached to PRs, cost per step, team dashboards. |
