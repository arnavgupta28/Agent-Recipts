#!/usr/bin/env node
// Codex hook entry point. Reads one JSON payload on stdin, records it, exits 0.
// It must never block or break the Codex run, so every error is swallowed and logged.
import { readFileSync } from "node:fs";
import { record, type HookPayload } from "./recorder.js";
import { logError } from "./store.js";
import { repoInfo } from "./git.js";

let payload: HookPayload | null = null;
try {
  const raw = readFileSync(0, "utf8");
  if (raw.trim()) payload = JSON.parse(raw) as HookPayload;
} catch (err) {
  logError(null, err);
}

if (payload && !process.env.AGENT_RECEIPTS_DISABLE) {
  try {
    record(payload);
  } catch (err) {
    let repo = null;
    try {
      repo = repoInfo(payload.cwd);
    } catch {
      /* ignore */
    }
    logError(repo, err);
  }
}
process.exit(0);
