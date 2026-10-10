# Agent Receipts: Demo Recording Plan

Two recordings. Part A is fully automated and shows every feature. Part B is a short screen capture in VS Code that only you can drive.

## Part A: automated feature walkthrough (about 2½ minutes)

Recorded with a scripted browser at 1440×900, with captions burned in. It uses the live simulator, so every test result shown is real.

| # | Time | Scene | What happens on screen | Caption |
|---|---|---|---|---|
| 1 | 0:00 | Intro | Viewer opens. Nova, Pip and Comet float on the orbit. | Agent Receipts: see what your Codex agents did, and rewind any step |
| 2 | 0:06 | Live run | The graph grows step by step. A pulsing node shows the step running now. The header says Running. | Codex is working. Every step appears live, in its agent's lane |
| 3 | 0:15 | Hand-off | Nova spawns Pip (refactor) and Comet (tests). Spawn lines curve into new lanes. | Nova, the main agent, hands work to two subagents |
| 4 | 0:40 | Failure | Step #9 turns red. Comet looks worried. The banner names the cause. | A test fails. Comet worries, and the banner points at steps #7 and #8 |
| 5 | 0:55 | Graph → step | Click node #9. The test output shows the failing assertion. | Click any node to see exactly what ran |
| 6 | 1:05 | Drill down | Modules, then src/api, then limiter.js, then step #8's diff. | Modules → files → the exact line the refactor agent broke |
| 7 | 1:25 | Agent filter | Click Pip's lane. The other lanes dim. Click again to clear. | Filter by agent to see only what Pip did |
| 8 | 1:35 | Rewind | Click "Rewind to after #6", confirm, toast. A rewind marker appears in the graph. | One click restores every file to the last passing state |
| 9 | 1:50 | Proof | The real `node --test` result is shown. | Tests pass again. HEAD, branch and index untouched |
| 10 | 2:00 | Undo | Undo from the toast. Files go back. | Every rewind is undoable |
| 11 | 2:10 | Explain | Click "Explain this run". The ready-made prompt shows. | One click asks Codex for the root cause |
| 12 | 2:20 | Outro | Back to the overview. | Codex hooks + hidden git snapshots + a live graph, right inside VS Code |

**Run:** `node scripts/record-demo.mjs`. Output: `demo/agent-receipts-demo.webm`.

## Part B: VS Code clip (about 45 seconds, recorded by you)

1. Press ⌘⇧5, choose **Record Selected Portion**, and frame the VS Code window.
2. Command Palette → **Agent Receipts: Run Live Demo** → **Run live demo**.
3. Show the panel opening beside the editor, and the status bar text changing.
4. Click a node, then **Open diff in editor** to show VS Code's native diff.
5. Click the status bar item to bring the panel back. Stop the recording.

## Checklist before recording
- [ ] Code pushed to GitHub
- [ ] `npm run build` is fresh
- [ ] Notifications off (Focus mode on)
- [ ] VS Code reloaded with the latest extension
