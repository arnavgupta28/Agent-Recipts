// Builds the VS Code extension: bundles extension.ts and copies the shared hook + viewer.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
execFileSync("node", [join(root, "scripts/build.mjs")], { stdio: "inherit" });
mkdirSync(join(here, "dist"), { recursive: true });
await build({
  entryPoints: [join(here, "src/extension.ts")],
  outfile: join(here, "dist/extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  logLevel: "warning",
});
copyFileSync(join(root, "dist/hook.js"), join(here, "dist/hook.mjs"));
copyFileSync(join(root, "dist/viewer.html"), join(here, "dist/viewer.html"));
console.log("built vscode/dist (extension.js, hook.mjs, viewer.html)");
