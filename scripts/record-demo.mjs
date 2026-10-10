// Records a captioned walkthrough of every Agent Receipts feature.
// Usage: npm run build && node scripts/record-demo.mjs [outFile]
// Needs Google Chrome (or set CHROME_PATH) and playwright-core (dev dependency).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "demo", "agent-receipts-demo.webm"));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4800 + Math.floor(Math.random() * 100);
const W = 1440, H = 900;
const work = mkdtempSync(join(tmpdir(), "ar-record-"));
const demoDir = join(work, "shop-api");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { NODE_TEST_CONTEXT: _c, ...CLEAN_ENV } = process.env;

// 1. Start the live replay + viewer.
const sim = spawn("node", [join(ROOT, "dist/cli.js"), "simulate", "--live", "1400", "--dir", demoDir, "--port", String(PORT), "--no-open"], { cwd: ROOT, env: CLEAN_ENV });
let simLog = "";
const url = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`viewer did not start:\n${simLog}`)), 20000);
  sim.stdout.on("data", (d) => {
    simLog += d;
    const m = simLog.match(/viewer: (http:\/\/\S+)/);
    if (m) {
      clearTimeout(t);
      res(m[1]);
    }
  });
  sim.stderr.on("data", (d) => (simLog += d));
});

// 2. Browser with video recording.
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: work, size: { width: W, height: H } } });
const page = await context.newPage();
await page.goto(url);
await page.waitForSelector(".shell");

// Overlay: caption pill + fake cursor with click ripples (headless video has no cursor).
await page.addStyleTag({
  content: `
  #demo-cap { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(10px); z-index: 99; opacity: 0;
    padding: 12px 22px; border-radius: 999px; font: 800 17px/1.3 var(--round); color: #fff; letter-spacing: .005em;
    background: rgba(22, 24, 48, .86); border: 1px solid rgba(255,255,255,.16); backdrop-filter: blur(14px);
    box-shadow: 0 18px 50px rgba(0,0,0,.55), 0 0 40px rgba(165,139,255,.25); transition: opacity .45s var(--ease), transform .45s var(--ease); max-width: 1100px; text-align: center; }
  #demo-cap.on { opacity: 1; transform: translateX(-50%) translateY(0); }
  #demo-cap .k { background: linear-gradient(90deg,#d8ecff,#dcffd9,#fff3c4,#ffd0d8); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 100; pointer-events: none;
    transition: transform .7s cubic-bezier(.2,.8,.2,1); transform: translate(${W / 2}px, ${H / 2}px); }
  #demo-cursor svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
  .demo-ripple { position: fixed; z-index: 99; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; pointer-events: none;
    border: 2px solid #fff; animation: demoRipple .6s ease-out forwards; }
  @keyframes demoRipple { to { transform: scale(3.2); opacity: 0; } }`,
});
await page.evaluate(() => {
  const cap = document.createElement("div");
  cap.id = "demo-cap";
  document.body.appendChild(cap);
  const cur = document.createElement("div");
  cur.id = "demo-cursor";
  cur.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.5 L14.4 20.3 L11.4 13.8 L17.5 13.6 Z" fill="#fff" stroke="#14141c" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(cur);
});

async function caption(text, holdMs = 0) {
  await page.evaluate((t) => {
    const el = document.getElementById("demo-cap");
    el.classList.remove("on");
    setTimeout(() => {
      el.innerHTML = t;
      el.classList.add("on");
    }, 250);
  }, text);
  if (holdMs) await sleep(holdMs);
}

async function moveTo(selector) {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.evaluate(([x, y]) => (document.getElementById("demo-cursor").style.transform = `translate(${x - 4}px, ${y - 2}px)`), [x, y]);
  await sleep(800);
  return { x, y };
}

async function click(selector, after = 900) {
  const { x, y } = await moveTo(selector);
  await page.evaluate(([x, y]) => {
    const r = document.createElement("div");
    r.className = "demo-ripple";
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }, [x, y]);
  await page.locator(selector).first().click({ force: true });
  await sleep(after);
}

const stepCount = () => page.evaluate(() => document.querySelectorAll("svg.graph g.node[data-step]").length);
async function waitFor(fn, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error("timed out");
}

try {
  // Scene 1–3: live run
  await caption(`<span class="k">Agent Receipts</span> · see what your Codex agents did, and rewind any step`, 3500);
  await caption("Codex is working. Every step appears live, in its agent's lane");
  await waitFor(async () => (await stepCount()) >= 2);
  await caption("Nova, the main agent, hands work to two subagents: Pip refactors, Comet writes tests");
  await waitFor(async () => (await stepCount()) >= 6);
  await caption("The pulsing node is the step running right now. The status chip says what each agent is doing");
  await waitFor(async () => page.evaluate(() => !!document.querySelector('g.node[data-step="9"]')));
  await caption("A test fails. Comet looks worried, and the banner points at the refactor steps since tests last passed", 3800);
  await waitFor(async () => page.evaluate(() => /Finished/.test(document.querySelector(".chip")?.textContent ?? "")));
  await sleep(800);

  // Scene 5: graph node → step details
  await caption("Click any node to see exactly what ran");
  await click('g.node[data-step="9"]', 2600);

  // Scene 6: drill-down modules → files → diff
  await caption("Drill down: modules → files → the exact diff");
  await click('.crumbs button[data-nav="modules"]', 1200);
  await click('.card[data-module="src/api"]', 1300);
  await click('.file[data-file="src/api/limiter.js"]', 1300);
  await click('.sc[data-filestep="4"]', 1400);
  await caption("Step #8: Pip “optimised” the limit check. That's the off-by-one that broke the tests");
  await click('.sc[data-filestep="8"]', 3200);

  // Scene 7: agent filter
  await caption("Filter by agent to see only what one agent did");
  await click('.lane-label[data-agent="agent-refactor"]', 2200);
  await click('.lane-label[data-agent="agent-refactor"]', 900);

  // Scene 8–9: rewind + proof
  await click('.crumbs button[data-nav="modules"]', 900);
  await caption("Fastest fix: rewind every file to the last passing test run");
  await click('.fix button[data-rewind-step="6"]', 1200);
  await caption("A safety snapshot is taken first, so this can be undone");
  await click(".modal [data-go]", 1500);
  const r = spawnSync("node", ["--test"], { cwd: demoDir, encoding: "utf8", env: CLEAN_ENV });
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1] ?? "?";
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1] ?? "?";
  await caption(`Real check after rewind: <b>node --test</b> → ${pass} passed, ${fail} failed. HEAD, branch and index untouched`, 4200);

  // Scene 10: undo
  await caption("Changed your mind? Every rewind is undoable");
  await click('[data-act="undo-last"]', 1100);
  await click(".modal [data-go]", 2200);

  // Scene 11: explain
  await caption("One click builds a root-cause prompt for Codex");
  await click('[data-act="explain"]', 3200);
  await click(".modal [data-close]", 1000);

  // Scene 12: outro
  await caption(`<span class="k">Codex hooks + hidden git snapshots + a live run graph</span> · right beside the Codex chat in VS Code`, 4500);
} finally {
  await context.close();
  const video = page.video();
  const raw = video ? await video.path() : null;
  await browser.close();
  sim.kill();
  if (raw && existsSync(raw)) {
    mkdirSync(dirname(OUT), { recursive: true });
    renameSync(raw, OUT);
    console.log(`Saved ${OUT}`);
  }
  rmSync(work, { recursive: true, force: true });
}
