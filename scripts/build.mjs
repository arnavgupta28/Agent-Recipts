// Bundles hook/cli/server for Node and inlines the viewer UI into dist/viewer.html.
import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const nodeCommon = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "warning",
  // Some MCP deps are CommonJS; give the ESM bundle a real `require`.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

await Promise.all([
  build({ ...nodeCommon, entryPoints: [join(root, "src/hook.ts")], outfile: join(dist, "hook.js") }),
  build({ ...nodeCommon, entryPoints: [join(root, "src/cli.ts")], outfile: join(dist, "cli.js")}),
  build({ ...nodeCommon, entryPoints: [join(root, "src/server.ts")], outfile: join(dist, "server.js") }),
]);

const ui = await build({
  entryPoints: [join(root, "src/ui/app.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  logLevel: "warning",
});
const js = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const font = readFileSync(join(root, "node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2")).toString("base64");
const css = readFileSync(join(root, "src/ui/styles.css"), "utf8").replace("/*FONT*/", () => font);
const template = readFileSync(join(root, "src/ui/index.html"), "utf8");
const html = template.replace("/*CSS*/", () => css).replace("/*JS*/", () => js);
writeFileSync(join(dist, "viewer.html"), html);
chmodSync(join(dist, "cli.js"), 0o755);
console.log(`built dist/ (viewer.html ${(html.length / 1024).toFixed(0)} KB)`);
