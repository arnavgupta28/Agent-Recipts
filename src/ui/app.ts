// Agent Receipts viewer. Runs inside ChatGPT / Codex as an MCP App (file viewer
// or inline widget), or standalone in a browser served by `agent-receipts view`.
import type { Receipt, ReceiptStep, ReceiptFile, ReceiptModule, ReceiptPending } from "../receipt.js";
import { avatar, avatarAt, avatarDefs, charOf, type Mood } from "./avatars.js";

type Boot = { mode?: "http" | "mcp" | "vscode"; token?: string };
type Api = {
  load(): Promise<void>;
  refresh?(): Promise<void>;
  rewind(snapshot: string): Promise<{ receipt: Receipt; safety: string; deleted: string[] }>;
  explain(prompt: string): Promise<"sent" | "manual" | "copied">;
  openDiff?(step: number, path: string): void;
  openFile?(path: string): void;
  pickSession?(): void;
};

const boot: Boot = (window as unknown as { __AGENT_RECEIPTS__?: Boot }).__AGENT_RECEIPTS__ ?? {};
const isVsc = boot.mode === "vscode";

type View = { level: "modules" } | { level: "module"; module: string } | { level: "file"; module: string; file: string; step: number | null } | { level: "step"; step: number };
const state: { receipt: Receipt | null; view: View; selected: number | null; agentFilter: string | null; error: string | null } = {
  receipt: null,
  view: { level: "modules" },
  selected: null,
  agentFilter: null,
  error: null,
};

// ---------- helpers ----------
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
function agentIdx(id: string): number {
  const i = state.receipt?.agents.findIndex((a) => a.id === id) ?? 0;
  return i < 0 ? 0 : i;
}
function agentColor(id: string): string {
  return charOf(agentIdx(id)).color;
}
/** How an agent's avatar should feel right now. */
function moodOf(id: string): Mood {
  const r = state.receipt;
  if (!r) return "idle";
  if (r.pending.some((p) => p.agent === id)) return "busy";
  const a = r.agents.find((x) => x.id === id);
  if (a?.failures) return "sad";
  if (r.status === "done" || a?.stoppedAt) return "happy";
  return "idle";
}
const av = (id: string, size: number, mood: Mood = moodOf(id)) => avatar(agentIdx(id), mood, size, agentName(id));
function agentName(id: string): string {
  const a = state.receipt?.agents.find((x) => x.id === id);
  return a ? (a.id === "main" ? "main" : a.type || a.id) : id;
}
const dot = (id: string) => `<span class="dot" style="--c:${agentColor(id)}" title="${esc(agentName(id))}"></span>`;
const stepBy = (n: number) => state.receipt!.steps.find((s) => s.n === n)!;
const text = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
function ioText(v: unknown): string {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.output === "string") return o.output;
  }
  return text(v);
}
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}
const visible = (s: ReceiptStep) => !state.agentFilter || s.agent === state.agentFilter;
const firstFailure = () => state.receipt?.steps.find((s) => s.failed) ?? null;
/** The edit steps that most plausibly caused a failure: changed steps since the last passing run of a similar command. */
function suspects(fail: ReceiptStep): ReceiptStep[] {
  const steps = state.receipt!.steps;
  const idx = steps.indexOf(fail);
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (steps[i].kind === "command" && !steps[i].failed && steps[i].exitCode === 0 && /test|spec|jest|vitest|pytest|cargo|go test/.test(steps[i].title)) {
      start = i + 1;
      break;
    }
  }
  return steps.slice(start, idx).filter((s) => s.files.length > 0);
}

function lastGood(fail: ReceiptStep): ReceiptStep | null {
  const steps = state.receipt!.steps;
  for (let i = steps.indexOf(fail) - 1; i >= 0; i--) {
    const st = steps[i];
    if (st.kind === "command" && !st.failed && st.exitCode === 0 && /test|spec|jest|vitest|pytest|cargo|go test/.test(st.title)) return st;
  }
  return null;
}

function fixBar(fail: ReceiptStep): string {
  const good = lastGood(fail);
  if (!good?.snapshot) return "";
  return `<div class="rewind-bar"><span class="grow"><b>Fastest fix:</b> tests last passed at step #${good.n}. Rewind to there and keep everything before it.</span>
    <button class="btn danger" data-rewind="${esc(good.snapshot)}" data-rewind-step="${good.n}">↺ Rewind to after #${good.n}</button></div>`;
}

// ---------- render ----------
const SCROLLERS = [".graph-wrap", "aside.left", ".detail-area"];
let firstPaint = true;
function render(): void {
  const saved = SCROLLERS.map((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    return el ? { top: el.scrollTop, left: el.scrollLeft, atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 } : null;
  });
  paint();
  SCROLLERS.forEach((sel, i) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    const prev = saved[i];
    if (!el) return;
    if (prev) {
      el.scrollTop = prev.top;
      el.scrollLeft = prev.left;
    }
    // Keep the graph pinned to "now" while the run is live and the user hasn't scrolled away.
    if (sel === ".graph-wrap" && (firstPaint || (state.receipt?.status === "running" && (!prev || prev.atEnd)))) el.scrollLeft = el.scrollWidth;
  });
  if (state.receipt) firstPaint = false;
}

function statusChip(r: Receipt): string {
  if (r.status === "running") {
    const cur = r.pending[r.pending.length - 1];
    return `<span class="chip live"><span class="pulse"></span>Running${cur ? ` · ${esc(agentName(cur.agent))}: ${esc(cur.title.slice(0, 40))}` : ""}</span>`;
  }
  if (r.status === "idle") return `<span class="chip">Idle</span>`;
  return `<span class="chip">Finished</span>`;
}

function paint(): void {
  const root = $("#app");
  const r = state.receipt;
  if (state.error && !r) {
    root.innerHTML = `<div class="empty">${esc(state.error)}</div>`;
    return;
  }
  if (!r) {
    root.innerHTML = `<div class="waiting"><div><div class="crew">${[0, 1, 2, 3, 4, 5, 6].map((i) => avatar(i, "busy", 54)).join("")}</div><h2>receipts</h2><p>Waiting for Codex to start working…</p></div></div>`;
    return;
  }
  const s = r.stats;
  root.innerHTML = `
  <div class="shell${firstPaint ? " enter" : ""}">
    <header class="top">
      ${friends(r)}
      <div class="titles">
        <div class="brand"><span class="wordmark">receipts</span><span class="by">for Codex agents</span></div>
        <h1>${esc(r.session.title)}</h1>
        <div class="chips">
          ${statusChip(r)}
          <span class="chip">📁 ${esc(r.repo.name)}</span>
          ${r.repo.branch ? `<span class="chip">⎇ ${esc(r.repo.branch)}</span>` : ""}
          ${r.session.model ? `<span class="chip">${esc(r.session.model)}</span>` : ""}
          <span class="chip">${s.steps} steps</span>
          <span class="chip">${s.agents} agents</span>
          <span class="chip">${s.filesChanged} files <span class="add">+${s.add}</span> <span class="del">−${s.del}</span></span>
          ${s.failures ? `<span class="chip fail">✕ ${s.failures} failed</span>` : `<span class="chip ok">✓ no failures</span>`}
          ${r.rewinds.length ? `<span class="chip">↺ ${r.rewinds.length} rewind${r.rewinds.length > 1 ? "s" : ""}</span>` : ""}
        </div>
      </div>
      <div class="actions">
        ${isVsc ? `<button class="btn" data-act="pick">Runs ▾</button>` : ""}
        ${r.rewinds.length ? `<button class="btn" data-act="undo-last">↺ Undo last rewind</button>` : ""}
        <button class="btn primary" data-act="explain">✦ Explain this run</button>
      </div>
    </header>
    <div class="body">
      <aside class="left">${renderAgents(r)}${renderTimeline(r)}</aside>
      <main class="right"><section class="graph-panel">${renderGraph(r)}</section><div class="detail-area">${renderMain(r)}</div></main>
    </div>
  </div>`;
}

function friends(r: Receipt): string {
  // Characters float along a dotted orbit arc in the header's right corner.
  // Kept below the action buttons (top-right) so nobody hides behind them.
  const spots = [
    [338, 62],
    [270, 74],
    [206, 82],
    [142, 88],
    [80, 92],
  ];
  const crew = r.agents
    .slice(0, 5)
    .map((a, k) => av(a.id, k === 0 ? 56 : 44).replace('<svg class="av', `<svg style="left:${spots[k][0]}px;top:${spots[k][1]}px" class="av`))
    .join("");
  return `<div class="friends" aria-hidden="true"><svg class="orbit" viewBox="0 0 420 130" preserveAspectRatio="none"><path d="M10 128 C120 118 300 92 440 40"/></svg><div class="crew">${crew}</div></div>`;
}

function renderAgents(r: Receipt): string {
  const items = r.agents
    .map((a) => {
      const cls = ["agent", a.parent ? "child" : "", state.agentFilter === a.id ? "active" : "", state.agentFilter && state.agentFilter !== a.id ? "dim" : ""].join(" ");
      const role = a.id === "main" ? "orchestrator" : moodOf(a.id) === "busy" ? "working…" : a.stoppedAt ? "handed back" : "subagent";
      return `<li class="${cls}" data-agent="${esc(a.id)}" title="${esc(a.lastMessage ?? "")}" style="--c:${agentColor(a.id)}">
        ${av(a.id, 36)}<span class="who-col"><span class="name">${esc(a.id === "main" ? "Main agent" : a.type)}</span><span class="role">${role}</span></span>
        <span class="meta">${a.steps} steps ${a.failures ? `<span class="badge fail">${a.failures} failed</span>` : ""}</span></li>`;
    })
    .join("");
  return `<div class="section-title"><span>Agents</span>${state.agentFilter ? `<button class="btn small" data-act="clear-filter">Show all</button>` : ""}</div><ul class="agents">${items}</ul>`;
}

function renderTimeline(r: Receipt): string {
  const byTurn = new Map<string, ReceiptStep[]>();
  for (const st of r.steps) {
    const k = st.turn ?? "_";
    byTurn.set(k, [...(byTurn.get(k) ?? []), st]);
  }
  const turnBlocks: string[] = [];
  const seen = new Set<string>();
  for (const t of r.turns) {
    seen.add(t.id);
    turnBlocks.push(`<div class="turn"><b>Turn ${t.n} · ${esc(fmtTime(t.at))}</b>${esc(t.prompt)}</div>${renderSteps(byTurn.get(t.id) ?? [])}`);
  }
  const orphans = r.steps.filter((st) => !seen.has(st.turn ?? "_"));
  if (orphans.length) turnBlocks.push(renderSteps(orphans));
  if (r.pending.length)
    turnBlocks.push(`<ul class="steps">${r.pending
      .map((p, i) => `<li class="step running" title="${esc(agentName(p.agent))} · ${esc(p.tool)}"><span class="n">#${r.steps.length + i + 1}</span>${dot(p.agent)}<span class="t">${p.kind === "edit" ? "✎" : "❯"} ${esc(p.title)}</span><span class="badge run">running</span></li>`)
      .join("")}</ul>`);
  const rewinds = r.rewinds.length
    ? `<div class="section-title"><span>Rewinds</span></div><ul class="steps">${r.rewinds
        .map((w) => `<li class="step" data-act="noop"><span class="n">↺</span><span></span><span class="t">${w.undo ? "Undid a rewind" : `Restored to ${w.toStep ? `after #${w.toStep}` : w.toSnapshot.slice(0, 8)}`} · ${esc(fmtTime(w.at))}</span><button class="btn small" data-undo="${esc(w.safety)}">Undo</button></li>`)
        .join("")}</ul>`
    : "";
  return `<div class="section-title"><span>Timeline</span><span>${r.steps.length}</span></div>${turnBlocks.join("")}${rewinds}`;
}

function renderSteps(steps: ReceiptStep[]): string {
  return `<ul class="steps">${steps
    .map((st) => {
      const icon = st.kind === "edit" ? "✎" : st.kind === "command" ? "❯" : "⚙";
      const cls = ["step", st.failed ? "failed" : "", state.selected === st.n ? "sel" : "", visible(st) ? "" : "dim"].join(" ");
      return `<li class="${cls}" data-step="${st.n}" title="${esc(agentName(st.agent))} · ${esc(st.tool)}">
        <span class="n">#${st.n}</span>${dot(st.agent)}<span class="t">${icon} ${esc(st.title)}</span>
        ${st.failed ? `<span class="badge fail">fail</span>` : st.files.length ? `<span class="k">${st.files.length} file${st.files.length > 1 ? "s" : ""}</span>` : `<span></span>`}
      </li>`;
    })
    .join("")}</ul>`;
}

// ---------- run graph ----------
function renderGraph(r: Receipt): string {
  const COL = 50, LANE = 56, LABEL = 168, TOP = 26, R = 13;
  const lanes = r.agents.map((a) => a.id);
  const laneOf = (id: string) => Math.max(0, lanes.indexOf(id));
  const steps = r.steps;
  const total = steps.length + r.pending.length;
  const width = LABEL + Math.max(total + 1.5, 8) * COL;
  const height = TOP + lanes.length * LANE + 6;
  const x = (n: number) => LABEL + (n - 0.5) * COL;
  const y = (lane: number) => TOP + lane * LANE + LANE / 2;
  // x position of a moment in time: the boundary after the last step that happened before it.
  const xAt = (iso: string | null) => (iso ? LABEL + steps.filter((st) => st.at <= iso).length * COL : LABEL);
  const parts: string[] = [];

  // turn + rewind markers
  for (const t of r.turns) {
    const tx = xAt(t.at) + 2;
    parts.push(`<line class="turn-line" x1="${tx}" y1="${TOP - 6}" x2="${tx}" y2="${height}"/><text class="turn-label" x="${tx + 4}" y="${TOP - 10}">Turn ${t.n}</text>`);
  }
  for (const w of r.rewinds) {
    const wx = xAt(w.at) + 6;
    parts.push(`<line class="rewind-line" x1="${wx}" y1="${TOP - 6}" x2="${wx}" y2="${height}"/><text class="rewind-label" x="${wx + 4}" y="${TOP - 10}">↺ ${w.undo ? "undo" : `#${w.toStep ?? "?"}`}</text>`);
  }

  // lane tracks + labels
  r.agents.forEach((a, i) => {
    const ly = y(i);
    const start = a.id === "main" ? LABEL : Math.max(LABEL, xAt(a.startedAt));
    const end = a.stoppedAt ? xAt(a.stoppedAt) : width - COL / 2;
    const dim = state.agentFilter && state.agentFilter !== a.id ? " dim" : "";
    parts.push(`<rect class="lane-bg" x="4" y="${ly - LANE / 2 + 4}" width="${width - 8}" height="${LANE - 8}" rx="${(LANE - 8) / 2}"/>`);
    parts.push(`<line class="lane-track${dim}" x1="${start}" y1="${ly}" x2="${end}" y2="${ly}" style="stroke:${agentColor(a.id)}"/>`);
    parts.push(`<g class="lane-label${dim}" data-agent="${esc(a.id)}">${avatarAt(i, moodOf(a.id), 12, ly - 17, 40, agentName(a.id))}<text x="60" y="${ly - 2}" class="lane-name">${esc(a.id === "main" ? "Main agent" : a.type)}</text><text x="60" y="${ly + 13}" class="lane-meta">${a.steps} steps${a.failures ? ` · ${a.failures} failed` : ""}</text></g>`);
  });

  // spawn + return edges
  for (const a of r.agents) {
    if (!a.parent) continue;
    const li = laneOf(a.id), pi = laneOf(a.parent);
    const mine = steps.filter((st) => st.agent === a.id);
    const sx = Math.max(LABEL + 6, xAt(a.startedAt));
    const firstX = mine.length ? x(mine[0].n) - R : sx + COL * 0.6;
    parts.push(`<path class="edge spawn" d="M${sx},${y(pi)} C${sx + 18},${y(pi)} ${firstX - 22},${y(li)} ${firstX},${y(li)}" style="stroke:${agentColor(a.id)}"/><circle class="spawn-dot" cx="${sx}" cy="${y(pi)}" r="4.5" style="fill:${agentColor(a.id)};filter:drop-shadow(0 0 5px ${agentColor(a.id)})"><title>${esc(agentName(a.id))} spawned</title></circle>`);
    if (a.stoppedAt && mine.length) {
      const lx = x(mine[mine.length - 1].n) + R;
      const rx = Math.max(lx + 20, xAt(a.stoppedAt));
      parts.push(`<path class="edge ret" d="M${lx},${y(li)} C${lx + 22},${y(li)} ${rx - 18},${y(pi)} ${rx},${y(pi)}" style="stroke:${agentColor(a.id)}"><title>${esc(a.lastMessage ?? "finished")}</title></path>`);
    }
  }

  // in-lane sequence links
  const lastX = new Map<string, number>();
  for (const st of steps) {
    const px = lastX.get(st.agent);
    if (px !== undefined) parts.push(`<line class="seq" x1="${px + R}" y1="${y(laneOf(st.agent))}" x2="${x(st.n) - R}" y2="${y(laneOf(st.agent))}" style="stroke:${agentColor(st.agent)}"/>`);
    lastX.set(st.agent, x(st.n));
  }

  // nodes
  for (const st of steps) parts.push(graphNode(st, x(st.n), y(laneOf(st.agent)), R));
  r.pending.forEach((p, i) => parts.push(pendingNode(p, x(steps.length + i + 1), y(laneOf(p.agent)), R)));

  if (r.status === "running") {
    const nx = x(total) + COL * 0.75;
    parts.push(`<line class="now-line" x1="${nx}" y1="${TOP - 6}" x2="${nx}" y2="${height}"/><text class="now-label" x="${nx + 4}" y="${TOP - 10}">now</text>`);
  }

  const legend = `<span class="lg"><svg width="14" height="14"><circle cx="7" cy="7" r="6" fill="url(#orb-0)"/></svg>edit</span>
    <span class="lg"><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="url(#orb-glass)" stroke="#7fb0ff" stroke-width="2"/></svg>command</span>
    <span class="lg"><svg width="14" height="14"><circle cx="7" cy="7" r="6" fill="url(#orb-fail)"/></svg>failed</span>
    <span class="lg"><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="#7ff0bf" stroke-width="2" stroke-dasharray="2 2"/></svg>running</span>`;
  return `<div class="graph-head"><b>Run graph</b><span class="note">${steps.length} steps${r.pending.length ? ` · ${r.pending.length} running` : ""} · click a node for details</span><span class="legend">${legend}</span></div>
    <div class="graph-wrap"><svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Agent run graph">${parts.join("")}</svg></div>`;
}

function graphNode(st: ReceiptStep, cx: number, cy: number, R: number): string {
  const idx = agentIdx(st.agent) % 7;
  const c = agentColor(st.agent);
  const sel = state.selected === st.n;
  const dim = visible(st) ? "" : " dim";
  const glow = st.failed ? "#ff5b7f" : c;
  const solid = st.failed || st.kind === "edit";
  const fill = st.failed ? "url(#orb-fail)" : solid ? `url(#orb-${idx})` : "url(#orb-glass)";
  const stroke = solid ? "none" : c;
  const txt = solid ? "#16132b" : "#fff";
  const tip = `#${st.n} ${agentName(st.agent)} · ${st.title}${st.failed ? " (failed)" : ""}${st.files.length ? `\n${st.files.map((f) => `${f.status} ${f.path}`).join("\n")}` : ""}`;
  return `<g class="node${dim}${sel ? " sel" : ""}" data-step="${st.n}" style="--glow:${glow}">${sel ? `<circle cx="${cx}" cy="${cy}" r="${R + 5}" class="sel-ring"/>` : ""}
    <circle class="orb" cx="${cx}" cy="${cy}" r="${R}" fill="${fill}" stroke="${stroke}" stroke-width="2.2"/>
    <text x="${cx}" y="${cy + 4}" class="node-n" style="fill:${txt}">${st.failed ? "✕" : st.n}</text><title>${esc(tip)}</title></g>`;
}

function pendingNode(p: ReceiptPending, cx: number, cy: number, R: number): string {
  const c = agentColor(p.agent);
  return `<g class="node running" style="--glow:${c}"><circle cx="${cx}" cy="${cy}" r="${R + 4}" class="pulse-ring" style="stroke:${c}"/><circle class="orb" cx="${cx}" cy="${cy}" r="${R}" fill="url(#orb-glass)" stroke="${c}" stroke-width="2.2" stroke-dasharray="4 3"/><text x="${cx}" y="${cy + 4}" class="node-n" style="fill:#fff">…</text><title>${esc(`Running: ${agentName(p.agent)} · ${p.title}`)}</title></g>`;
}

function crumbs(parts: { label: string; act?: string }[]): string {
  return `<nav class="crumbs">${parts
    .map((p, i) => (i < parts.length - 1 ? `<button data-nav="${esc(p.act)}">${esc(p.label)}</button><span class="sep">/</span>` : `<span class="cur">${esc(p.label)}</span>`))
    .join("")}</nav>`;
}

function renderMain(r: Receipt): string {
  const v = state.view;
  if (v.level === "modules") return renderModules(r);
  if (v.level === "module") return renderModule(r, v.module);
  if (v.level === "file") return renderFile(r, v.module, v.file, v.step);
  return renderStep(r, v.step);
}

function failureSummary(r: Receipt): string {
  const f = firstFailure();
  const last = r.session.lastMessage ? `<br/><b>Agent's last word:</b> ${esc(r.session.lastMessage)}` : "";
  if (!f) {
    if (r.status === "running") return `<div class="summary">${av("main", 46, "busy")}<div><b>Working on it…</b> ${r.stats.steps} steps so far, nothing has failed.</div></div>`;
    return `<div class="summary happy">${av("main", 46, "happy")}<div><b>All good!</b> No failing steps in this run.${last}</div></div>`;
  }
  const sus = suspects(f);
  return `<div class="summary fail">${av(f.agent, 46, "sad")}<div><b>Step #${f.n} failed</b> · ${esc(agentName(f.agent))} ran <code>${esc(f.title)}</code>.
    ${sus.length ? `<br/>Changed since tests last passed: ${sus.map((s) => `<button class="sc ${state.selected === s.n ? "sel" : ""}" data-step="${s.n}">${dot(s.agent)}#${s.n} ${esc(agentName(s.agent))}</button>`).join(" ")}` : ""}
    ${last}</div></div>
    ${fixBar(f) ? `<div class="fix">${fixBar(f)}</div>` : ""}`;
}

function renderModules(r: Receipt): string {
  const sel = state.selected ? stepBy(state.selected) : null;
  const selFiles = new Set(sel?.files.map((f) => f.path) ?? []);
  const maxSteps = Math.max(1, ...r.modules.map((m) => m.steps.length));
  const failingFiles = new Set(firstFailure() ? suspects(firstFailure()!).flatMap((s) => s.files.map((f) => f.path)) : []);
  const cards = r.modules
    .map((m) => {
      const steps = m.steps.filter((n) => visible(stepBy(n)));
      if (state.agentFilter && !steps.length) return "";
      const hl = m.files.some((f) => selFiles.has(f));
      const fail = m.files.some((f) => failingFiles.has(f));
      return `<button class="card ${hl ? "hl" : ""} ${fail ? "has-fail" : ""}" data-module="${esc(m.path)}">
        <h3>${esc(m.path)}</h3>
        <div class="row">${m.files.length} file${m.files.length > 1 ? "s" : ""} · <span class="add">+${m.add}</span> <span class="del">−${m.del}</span><span class="crew-mini">${m.agents.map((a) => av(a, 22)).join("")}</span></div>
        <div class="heat"><span style="width:${Math.round((m.steps.length / maxSteps) * 100)}%"></span></div>
        <div class="stepchips">${steps.map((n) => stepChip(n)).join("")}</div>
      </button>`;
    })
    .join("");
  return `${crumbs([{ label: r.repo.name }])}<div class="level-hint">Level 1 · modules touched by this run. Click one to see its files.</div>
    ${failureSummary(r)}
    ${r.modules.length ? `<div class="grid">${cards}</div>` : `<div class="empty">This run didn't change any files.</div>`}`;
}

function stepChip(n: number, active = false): string {
  const st = stepBy(n);
  return `<span class="sc ${st.failed ? "fail" : ""} ${active || state.selected === n ? "sel" : ""}" data-step="${n}">${dot(st.agent)}#${n}</span>`;
}

function fileHistory(r: Receipt, path: string): { step: ReceiptStep; file: ReceiptFile }[] {
  const out: { step: ReceiptStep; file: ReceiptFile }[] = [];
  for (const st of r.steps) for (const f of st.files) if (f.path === path) out.push({ step: st, file: f });
  return out;
}

function renderModule(r: Receipt, modPath: string): string {
  const m = r.modules.find((x) => x.path === modPath) as ReceiptModule | undefined;
  if (!m) return renderModules(r);
  const sel = state.selected ? stepBy(state.selected) : null;
  const rows = m.files
    .map((path) => {
      const hist = fileHistory(r, path).filter((h) => visible(h.step));
      if (!hist.length) return "";
      const last = hist[hist.length - 1].file;
      const first = hist[0].file;
      const status = first.status === "A" ? "A" : last.status;
      const add = hist.reduce((t, h) => t + h.file.add, 0);
      const del = hist.reduce((t, h) => t + h.file.del, 0);
      const hl = sel?.files.some((f) => f.path === path);
      return `<button class="file ${hl ? "hl" : ""}" data-file="${esc(path)}">
        <span class="st ${esc(status)}">${esc(status)}</span>
        <span><span class="p">${esc(path.slice(modPath === "(root)" ? 0 : modPath.length + 1))}</span><br/><span class="note"><span class="add">+${add}</span> <span class="del">−${del}</span> · ${hist.length} change${hist.length > 1 ? "s" : ""}</span></span>
        <span class="stepchips">${hist.map((h) => stepChip(h.step.n)).join("")}</span>
      </button>`;
    })
    .join("");
  return `${crumbs([{ label: r.repo.name, act: "modules" }, { label: modPath }])}<div class="level-hint">Level 2 · files in this module and the steps that changed them.</div><div class="files">${rows}</div>`;
}

function renderDiff(diff: string): string {
  if (!diff.trim()) return `<div class="empty">No textual diff (binary or empty).</div>`;
  const lines = diff.split("\n").filter((l) => !/^(diff --git|index |new file mode|deleted file mode|similarity index|rename (from|to))/.test(l));
  return `<pre class="diff">${lines
    .map((l) => {
      const c = l.startsWith("@@") ? "h" : l.startsWith("+++") || l.startsWith("---") ? "m" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "";
      return `<span class="l ${c}">${esc(l) || " "}</span>`;
    })
    .join("")}</pre>`;
}

function rewindBar(st: ReceiptStep): string {
  if (!st.snapshot) return "";
  return `<div class="rewind-bar"><span class="grow">Restore every file to exactly how it was right after step #${st.n}. A safety snapshot is taken first, so you can undo.</span>
    <button class="btn danger" data-rewind="${esc(st.snapshot)}" data-rewind-step="${st.n}">↺ Rewind to after #${st.n}</button></div>`;
}

function renderFile(r: Receipt, modPath: string, path: string, stepN: number | null): string {
  const hist = fileHistory(r, path);
  if (!hist.length) return renderModule(r, modPath);
  const cur = hist.find((h) => h.step.n === stepN) ?? hist[hist.length - 1];
  const st = cur.step;
  const tabs = hist.map((h) => `<span class="sc ${h.step.n === st.n ? "sel" : ""} ${h.step.failed ? "fail" : ""}" data-filestep="${h.step.n}">${dot(h.step.agent)}#${h.step.n} ${esc(agentName(h.step.agent))}</span>`).join("");
  return `${crumbs([{ label: r.repo.name, act: "modules" }, { label: modPath, act: `module:${modPath}` }, { label: path.split("/").pop()! }])}
    <div class="level-hint">Level 3 · the code. Pick a step to see exactly what it changed in <code>${esc(path)}</code>.</div>
    <div class="detail">
      <div class="detail-head"><span class="st ${esc(cur.file.status)}">${esc(cur.file.status)}</span>
        <div class="grow"><b>Step #${st.n}</b> · ${esc(st.title)}</div>
        <div class="who">${av(st.agent, 24)} ${esc(agentName(st.agent))} · ${esc(fmtTime(st.at))}</div>
        ${isVsc ? `<button class="btn small" data-vsc-diff="${esc(path)}" data-vsc-step="${st.n}">Open diff in editor</button><button class="btn small" data-vsc-open="${esc(path)}">Open file</button>` : ""}</div>
      <div class="tabs">${tabs}</div>
      ${cur.file.foreign ? `<div class="io-label">Note: this step's own patch didn't name this file. Another agent may have changed it at the same time.</div>` : ""}
      ${renderDiff(cur.file.diff)}
      ${rewindBar(st)}
    </div>`;
}

function renderStep(r: Receipt, n: number): string {
  const st = stepBy(n);
  const files = st.files.length
    ? `<div class="io-label">Files changed</div><div style="padding:8px 12px" class="files">${st.files
        .map((f) => `<button class="file" data-file="${esc(f.path)}" data-filestep-open="${st.n}"><span class="st ${esc(f.status)}">${esc(f.status)}</span><span class="p">${esc(f.path)}</span><span class="note"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span></button>`)
        .join("")}</div>`
    : "";
  return `${crumbs([{ label: r.repo.name, act: "modules" }, { label: `Step #${st.n}` }])}
    <div class="detail">
      <div class="detail-head"><div class="grow"><b>Step #${st.n}</b> · ${esc(st.tool)} ${st.failed ? `<span class="badge fail">failed${st.exitCode != null ? ` · exit ${st.exitCode}` : ""}</span>` : ""}</div>
        <div class="who">${av(st.agent, 24)} ${esc(agentName(st.agent))} · ${esc(fmtTime(st.at))}</div></div>
      <div class="io-block"><div class="io-label">Input</div><pre class="io">${esc(ioText(st.input))}</pre></div>
      <div class="io-block ${st.failed ? "fail" : ""}"><div class="io-label">Output</div><pre class="io">${esc(ioText(st.output))}</pre></div>
      ${files}
      ${st.failed ? fixBar(st) || rewindBar(st) : rewindBar(st)}
    </div>`;
}

// ---------- interactions ----------
function selectStep(n: number): void {
  const st = stepBy(n);
  state.selected = n;
  if (st.files.length === 1) {
    const f = st.files[0].path;
    const mod = state.receipt!.modules.find((m) => m.files.includes(f));
    state.view = { level: "file", module: mod?.path ?? "(root)", file: f, step: n };
  } else state.view = { level: "step", step: n };
  render();
}

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("[data-vsc-diff],[data-vsc-open],[data-step],[data-module],[data-file],[data-nav],[data-agent],[data-act],[data-rewind],[data-filestep],[data-undo]") as HTMLElement | null;
  if (!el || !state.receipt) return;
  const d = el.dataset;
  if (d.vscDiff) return api.openDiff?.(Number(d.vscStep), d.vscDiff);
  if (d.vscOpen) return api.openFile?.(d.vscOpen);
  if (d.act === "pick") return api.pickSession?.();
  if (d.undo) return confirmRewind(d.undo, null, true);
  if (d.rewind) return confirmRewind(d.rewind, Number(d.rewindStep), false);
  if (d.filestep && state.view.level === "file") {
    state.selected = Number(d.filestep);
    state.view = { ...state.view, step: Number(d.filestep) };
    return render();
  }
  if (d.file) {
    const mod = state.receipt.modules.find((m) => m.files.includes(d.file!));
    const step = d.filestepOpen ? Number(d.filestepOpen) : state.selected && stepBy(state.selected).files.some((f) => f.path === d.file) ? state.selected : null;
    state.view = { level: "file", module: mod?.path ?? "(root)", file: d.file, step };
    return render();
  }
  if (d.step) {
    e.stopPropagation();
    return selectStep(Number(d.step));
  }
  if (d.module) {
    state.view = { level: "module", module: d.module };
    return render();
  }
  if (d.nav) {
    state.view = d.nav === "modules" ? { level: "modules" } : { level: "module", module: d.nav.slice("module:".length) };
    return render();
  }
  if (d.agent) {
    state.agentFilter = state.agentFilter === d.agent ? null : d.agent;
    return render();
  }
  if (d.act === "clear-filter") {
    state.agentFilter = null;
    return render();
  }
  if (d.act === "explain") return void explain();
  if (d.act === "undo-last") {
    const last = state.receipt.rewinds[state.receipt.rewinds.length - 1];
    if (last) confirmRewind(last.safety, null, true);
  }
});

function modal(html: string, onMount?: (root: HTMLElement, close: () => void) => void): void {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true"><div class="modal-av">${avatar(0, "busy", 60)}</div>${html}</div></div>`;
  const close = () => (root.innerHTML = "");
  root.querySelector(".modal-back")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  onMount?.(root, close);
}

function toast(msg: string, action?: { label: string; run: () => void }, ms = 8000): void {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  if (action) el.querySelector("button")!.addEventListener("click", () => {
    el.remove();
    action.run();
  });
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function confirmRewind(snapshot: string, step: number | null, isUndo: boolean): void {
  const title = isUndo ? "Undo rewind?" : `Rewind to after step #${step}?`;
  const body = isUndo
    ? "Your files go back to exactly how they were before that rewind."
    : `Every file goes back to how it was right after step #${step}. Later changes by any agent are reverted, and files created later are removed. Ignored files are never touched. Git HEAD, branch and index stay as they are.`;
  modal(
    `<h2>${esc(title)}</h2><p>${esc(body)}</p><p class="note">A safety snapshot is taken first, so this can be undone.</p>
     <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn danger" data-go>${isUndo ? "Undo rewind" : "Rewind files"}</button></div>`,
    (root, close) => {
      root.querySelector("[data-go]")!.addEventListener("click", async () => {
        close();
        try {
          const res = await api.rewind(snapshot);
          state.receipt = res.receipt;
          render();
          toast(isUndo ? "Rewind undone." : `Files restored to after step #${step}.${res.deleted.length ? ` Removed ${res.deleted.length} file(s).` : ""}`, isUndo ? undefined : { label: "Undo", run: () => confirmRewind(res.safety, null, true) });
        } catch (err) {
          toast(`Rewind failed: ${(err as Error).message}`);
        }
      });
    },
  );
}

function buildExplainPrompt(r: Receipt): string {
  const lines: string[] = [];
  lines.push(`Here is an Agent Receipt for a Codex run in repo "${r.repo.name}" (${r.session.model ?? "unknown model"}).`);
  lines.push(`Task: ${r.turns.map((t) => t.prompt).join(" / ") || r.session.title}`);
  lines.push(`Agents: ${r.agents.map((a) => `${a.id === "main" ? "main" : a.type} (${a.steps} steps${a.failures ? `, ${a.failures} failed` : ""})`).join(", ")}`);
  lines.push("", "Steps:");
  for (const s of r.steps) lines.push(`#${s.n} [${agentName(s.agent)}] ${s.tool}: ${s.title}${s.failed ? `  <-- FAILED${s.exitCode != null ? ` (exit ${s.exitCode})` : ""}` : ""}${s.files.length ? `  files: ${s.files.map((f) => `${f.status} ${f.path}`).join(", ")}` : ""}`);
  const f = firstFailure();
  if (f) {
    lines.push("", `Output of failed step #${f.n}:`, "```", ioText(f.output).slice(-1800), "```");
    const sus = suspects(f);
    if (sus.length) {
      lines.push("", "Diffs since the last passing test run:");
      for (const s of sus) for (const file of s.files) lines.push(`Step #${s.n} by ${agentName(s.agent)} — ${file.path}`, "```diff", file.diff.slice(0, 1500), "```");
    }
  }
  if (r.session.lastMessage) lines.push("", `Agent's final message: ${r.session.lastMessage}`);
  lines.push(
    "",
    "In under 150 words: explain where this run went wrong, naming the exact step and agent that caused it, give the minimal fix, and say which step I should rewind to. Then suggest one AGENTS.md rule that would have prevented it.",
  );
  return lines.join("\n");
}

async function explain(): Promise<void> {
  const prompt = buildExplainPrompt(state.receipt!);
  const res = await api.explain(prompt).catch(() => "manual" as const);
  if (res === "sent") return toast("Sent to ChatGPT. The explanation will appear in the conversation.");
  if (res === "copied") return toast("Prompt copied. Paste it into the Codex chat (⌘V).");
  modal(
    `<h2>Explain this run</h2><p>Paste this into ChatGPT or Codex. It's already copied to your clipboard if your browser allowed it.</p>
     <textarea readonly>${esc(prompt)}</textarea>
     <div class="actions"><button class="btn" data-copy>Copy</button><button class="btn primary" data-close>Done</button></div>`,
    (root) => {
      root.querySelector("[data-copy]")!.addEventListener("click", () => void navigator.clipboard?.writeText(prompt).then(() => toast("Copied.")));
    },
  );
  void navigator.clipboard?.writeText(prompt).catch(() => {});
}

// ---------- transports ----------
const signature = (r: Receipt) => `${r.status}|${r.steps.length}|${r.pending.map((p) => p.id).join(",")}|${r.rewinds.length}|${r.agents.map((a) => `${a.id}:${a.steps}:${a.stoppedAt ?? ""}`).join(",")}`;
function setReceipt(r: unknown): void {
  if (r && typeof r === "object" && (r as Receipt).version === 1) {
    const rec = r as Receipt;
    rec.pending ??= [];
    rec.status ??= "done";
    const first = !state.receipt;
    const changed = first || signature(state.receipt!) !== signature(rec);
    state.receipt = rec;
    state.error = null;
    if (first) applyHash();
    if (changed) render();
  }
}
const applyLive = setReceipt;

/** Deep links: #module=src/api, #file=src/api/limiter.js&step=8, #step=9, #agent=agent-tests */
function applyHash(): void {
  const r = state.receipt;
  if (!r || !location.hash) return;
  const q = new URLSearchParams(location.hash.slice(1));
  const step = q.get("step") ? Number(q.get("step")) : null;
  if (q.get("agent")) state.agentFilter = q.get("agent");
  if (q.get("file")) {
    const file = q.get("file")!;
    const mod = r.modules.find((m) => m.files.includes(file));
    state.view = { level: "file", module: mod?.path ?? "(root)", file, step };
    state.selected = step;
  } else if (q.get("module")) state.view = { level: "module", module: q.get("module")! };
  else if (step && r.steps.some((s) => s.n === step)) {
    state.selected = step;
    state.view = { level: "step", step };
  }
}

function httpApi(): Api {
  const headers = { "content-type": "application/json", "x-agent-receipts-token": boot.token ?? "" };
  return {
    async load() {
      const res = await fetch("/api/receipt", { headers });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setReceipt(body.receipt);
    },
    async rewind(snapshot) {
      const res = await fetch("/api/rewind", { method: "POST", headers, body: JSON.stringify({ snapshot }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      return body;
    },
    async explain() {
      return "manual";
    },
    async refresh() {
      await this.load();
    },
  };
}

async function mcpApi(): Promise<Api> {
  const { App, applyDocumentTheme, applyHostStyleVariables } = await import("@modelcontextprotocol/ext-apps");
  const { OpenAIExtensions, OpenAIFileEntrypointInputSchema } = await import("@openai/mcp-extensions/app");
  const app = new App({ name: "agent-receipts", version: "0.1.0" });
  const ext = new OpenAIExtensions(app);
  let fileUri: string | null = null;

  const fromResult = (result: { structuredContent?: unknown; isError?: boolean; content?: unknown }) => {
    const sc = result?.structuredContent as { receipt?: Receipt; error?: string } | undefined;
    if (sc?.receipt) setReceipt(sc.receipt);
    else if (sc?.error) {
      state.error = sc.error;
      render();
    }
  };
  const readFile = async (uri: string) => {
    const res = await ext.resources?.read({ uri });
    const c = res?.contents?.[0] as { text?: string; blob?: string } | undefined;
    const raw = c?.text ?? (c?.blob ? atob(c.blob) : null);
    if (raw) setReceipt(JSON.parse(raw));
  };
  app.ontoolresult = (result) => fromResult(result as never);
  app.ontoolinput = (params) => {
    const parsed = OpenAIFileEntrypointInputSchema.safeParse(params?.arguments);
    if (parsed.success) {
      fileUri = parsed.data.file.resourceUri;
      if (!state.receipt) void readFile(fileUri).catch((err) => console.warn("read failed", err));
    }
  };
  const applyCtx = (ctx: ReturnType<typeof app.getHostContext>) => {
    if (ctx?.theme) {
      applyDocumentTheme(ctx.theme);
      document.documentElement.dataset.theme = ctx.theme;
    }
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  };
  app.addEventListener("hostcontextchanged", applyCtx as never);
  await app.connect();
  applyCtx(app.getHostContext());

  return {
    async load() {
      /* data arrives via ontoolresult / ontoolinput */
    },
    async rewind(snapshot) {
      const r = state.receipt!;
      const res = await app.callServerTool({ name: "receipts.rewind", arguments: { root: r.repo.root, session: r.session.id, snapshot } });
      const sc = res.structuredContent as { receipt?: Receipt; safety?: string; deleted?: string[]; error?: string } | undefined;
      if (res.isError || !sc?.receipt) throw new Error(sc?.error ?? "Rewind failed");
      return { receipt: sc.receipt, safety: sc.safety!, deleted: sc.deleted ?? [] };
    },
    async refresh() {
      const r = state.receipt;
      if (!r) return;
      const res = await app.callServerTool({ name: "receipts.show", arguments: { cwd: r.repo.root, session: r.session.id } });
      const sc = res.structuredContent as { receipt?: Receipt } | undefined;
      if (!res.isError && sc?.receipt) applyLive(sc.receipt);
    },
    async explain(prompt) {
      if (!ext.message) return "manual";
      await ext.message.send({ role: "user", content: [{ type: "text", text: prompt }] });
      return "sent";
    },
  };
}

function vscodeApi(): Api {
  const vsc = (window as unknown as { acquireVsCodeApi: () => { postMessage(m: unknown): void } }).acquireVsCodeApi();
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as { type: string; receipt?: Receipt; id?: number; ok?: boolean; data?: unknown; error?: string };
    if (m.type === "receipt") setReceipt(m.receipt);
    if (m.type === "reply" && m.id != null) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.ok) w?.resolve(m.data);
      else w?.reject(new Error(m.error ?? "failed"));
    }
  });
  const request = <T>(msg: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      vsc.postMessage({ ...msg, id });
    });
  // Follow VS Code's theme.
  const syncTheme = () => {
    const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.classList.add("vsc");
  };
  syncTheme();
  new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return {
    async load() {
      vsc.postMessage({ type: "ready" });
    },
    rewind: (snapshot) => request({ type: "rewind", snapshot }),
    explain: (prompt) => request({ type: "explain", prompt }),
    openDiff: (step, path) => vsc.postMessage({ type: "openDiff", step, path }),
    openFile: (path) => vsc.postMessage({ type: "openFile", path }),
    pickSession: () => vsc.postMessage({ type: "pickSession" }),
  };
}

document.body.insertAdjacentHTML("afterbegin", avatarDefs());
let api: Api;
(async () => {
  try {
    api = boot.mode === "http" ? httpApi() : boot.mode === "vscode" ? vscodeApi() : await mcpApi();
    await api.load();
  } catch (err) {
    state.error = `Could not load receipt: ${(err as Error).message}`;
  }
  render();
  // Live updates: poll quickly while the run is going, slowly once it's finished.
  let busy = false;
  const tick = async () => {
    if (!busy && api?.refresh && state.receipt && !document.hidden) {
      busy = true;
      try {
        await api.refresh();
      } catch {
        /* transient; try again next tick */
      } finally {
        busy = false;
      }
    }
    setTimeout(tick, state.receipt?.status === "running" ? 1200 : 5000);
  };
  setTimeout(tick, 1200);
})();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#modal-root").innerHTML = "";
});
