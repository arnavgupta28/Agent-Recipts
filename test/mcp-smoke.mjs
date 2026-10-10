// Starts dist/server.js over stdio and exercises its tools with a real MCP client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const demo = process.argv[2];
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"] }));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => `${t.name}${t._meta?.["openai/ui"] ? " " + JSON.stringify(t._meta["openai/ui"]) : ""}`).join(" | "));
const res = await client.listResources();
console.log("resources:", res.resources.map((r) => `${r.uri} ${r.mimeType}`).join(", "));
const html = await client.readResource({ uri: "ui://agent-receipts/viewer-v1" });
console.log("viewer html bytes:", html.contents[0].text.length, html.contents[0].text.includes('"mode":"mcp"'));
const show = await client.callTool({ name: "receipts.show", arguments: { cwd: demo } });
console.log("show:", show.isError ? "ERROR" : "ok", "|", show.content[0].text.split("\n").slice(0, 3).join(" / "));
console.log("structured steps:", show.structuredContent?.receipt?.steps?.length);
await client.close();
