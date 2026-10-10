import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** dist/viewer.html with a boot config injected. */
export function viewerHtml(mode: "http" | "mcp", extra: Record<string, unknown> = {}): string {
  const html = readFileSync(join(HERE, "viewer.html"), "utf8");
  const boot = `<script>window.__AGENT_RECEIPTS__=${JSON.stringify({ mode, ...extra }).replace(/</g, "\\u003c")};</script>`;
  return html.replace("<!--BOOT-->", () => boot);
}
