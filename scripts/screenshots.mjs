// Captures README screenshots of the viewer from a real simulated run.
// Usage: npm run build && node scripts/screenshots.mjs [outDir]
// Needs Google Chrome (or set CHROME_PATH) and playwright-core (dev dependency).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "docs", "images"));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4900 + Math.floor(Math.random() * 100);
const work = mkdtempSync(join(tmpdir(), "ar-shots-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { NODE_TEST_CONTEXT: _c, ...CLEAN_ENV } = process.env;
mkdirSync(OUT, { recursive: true });

const sim = spawn("node", [join(ROOT, "dist/cli.js"), "simulate", "--live", "50", "--dir", join(work, "shop-api"), "--port", String(PORT), "--no-open"], { cwd: ROOT, env: CLEAN_ENV });
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const shot = (name) => page.screenshot({ path: join(OUT, name), type: "jpeg", quality: 82 });
const click = async (selector, after = 700) => {
  await page.locator(selector).first().click({ force: true });
  await sleep(after);
};

try {
  await page.goto(url);
  await page.waitForSelector(".shell");
  const start = Date.now();
  while (!(await page.evaluate(() => /Finished/.test(document.querySelector(".chip")?.textContent ?? "")))) {
    if (Date.now() - start > 60000) throw new Error("run did not finish");
    await sleep(250);
  }
  await sleep(800);

  await click('.card[data-module="src/api"]');
  await shot("diff-files.jpg");

  await click('.file[data-file="src/api/limiter.js"]');
  await click('.sc[data-filestep="4"]');
  await shot("diff-step-4.jpg");
  await click('.sc[data-filestep="8"]');
  await shot("diff-step-8.jpg");

  await click('.lane-label[data-agent="agent-refactor"]', 1000);
  await shot("agent-filter.jpg");
  await click('.lane-label[data-agent="agent-refactor"]');

  await click('.crumbs button[data-nav="modules"]');
  await click('[data-act="explain"]', 1200);
  await shot("explain.jpg");
  console.log(`Saved screenshots to ${OUT}`);
} finally {
  await browser.close();
  sim.kill();
  rmSync(work, { recursive: true, force: true });
}
