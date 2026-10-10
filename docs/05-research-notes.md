# Agent Receipts: Verified Platform Facts

Checked on Oct 10 2026 against official docs and OpenAI's open-source repos.

## Codex plugins
- Manifest: `.codex-plugin/plugin.json` with `name`, `version`, `skills`, `mcpServers`, `hooks`, `interface`.
- MCP servers: `.mcp.json`, e.g. `{"mcpServers": {"x": {"command": "node", "args": ["./dist/server.js"], "cwd": "."}}}`.
- Reference plugin: [openai/mcp-extensions › plugins/bits-and-bolts](https://github.com/openai/mcp-extensions/tree/main/plugins/bits-and-bolts).

## Codex hooks ([docs](https://learn.chatgpt.com/docs/hooks))
- Plugin hooks default to `hooks/hooks.json` in the plugin root. `PLUGIN_ROOT` and `PLUGIN_DATA` are set.
- Events: `SessionStart`, `SessionEnd`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `Interrupt`.
- `PostToolUse` input: `session_id`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, `cwd`, `model`, `permission_mode`, `transcript_path`, and optional `agent_id` and `agent_type`.
- Subagent hooks use the parent session id.
- `"async": true` runs a hook in the background. Exit 0 with no output means success.
- Hooks must be trusted by the user with `/hooks` before they run.
- For `apply_patch`, `tool_input.command` holds the patch text.

## Plugin extensions ([docs](https://developers.openai.com/plugins/build/extensions))
- Declared via `_meta["openai/ui"].entrypoints` on an MCP tool. Types: `global` (sidebar), `thread` (side panel), `file` with `extensions: [".x"]`.
- The file viewer tool receives `{ file: { name, resourceUri } }` (`OpenAIFileEntrypointInputSchema`).
- The app reads the file with `openaiExtensions.resources.read({ uri })`.
- The app calls server tools with `app.callServerTool({ name, arguments })`.
- The app posts to chat with `openaiExtensions.message.send({ role: "user", content: [...] })`.
- The UI resource MIME type is `text/html;profile=mcp-app`. CSS must be inlined.
- Packages: `@openai/mcp-extensions@0.1.0`, `@modelcontextprotocol/server@^2`, `@modelcontextprotocol/ext-apps@^1.7.5`, `@modelcontextprotocol/sdk@^1`.
- Web support for extensions is "coming soon" for Free and Go. Composer mentions only work in the desktop app.

## Local Codex state (for reference only, not used)
- `~/.codex/state_5.sqlite` has `threads` (with `rollout_path`, `agent_role`, `agent_path`) and `thread_spawn_edges(parent_thread_id, child_thread_id, status)`.
- Internal and unstable, so Agent Receipts relies on hooks instead.
