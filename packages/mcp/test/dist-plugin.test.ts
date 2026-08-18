/**
 * Distribution-artifact conformance (Task 11).
 *
 * These are not "does the code run" tests — they make the *distribution invariants* executable
 * (CLAUDE.md §4: executable over prose). A config snippet or a deeplink is prose that a human
 * pastes into another tool; the one that is easy to get wrong and impossible to eyeball is the
 * base64-encoded Cursor deeplink, so this suite DECODES it and asserts it reconstructs the exact
 * stdio launch (`npx -y @rewind/mcp mcp`). It also pins the plugin manifest, the bundled `.mcp.json`,
 * the PreToolUse hook wiring, and the executable bit on `guard.sh`, so a later edit that breaks the
 * shipped install surface fails here instead of in a user's editor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const HERE = import.meta.dirname;
const PLUGIN = join(HERE, "..", "dist-plugin");
const DOCS = join(HERE, "..", "..", "..", "docs", "install", "README.md");

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("plugin.json is a valid manifest named 'rewind'", async () => {
  const manifest = await readJson(join(PLUGIN, ".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, "rewind", "plugin name must be the kebab-case id 'rewind'");
  assert.equal(typeof manifest.description, "string");
  assert.match(manifest.description, /reversibility/i, "the manifest must carry the Tier-0 honesty line");
});

test(".mcp.json launches the stdio server via npx", async () => {
  const cfg = await readJson(join(PLUGIN, ".mcp.json"));
  const server = cfg.mcpServers?.rewind;
  assert.ok(server, ".mcp.json must define an mcpServers.rewind entry");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "@rewind/mcp", "mcp"]);
});

test("hooks.json wires a PreToolUse guard on Bash|Write|Edit to guard.sh", async () => {
  const hooks = await readJson(join(PLUGIN, "hooks", "hooks.json"));
  const pre = hooks.hooks?.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length === 1, "exactly one PreToolUse matcher");
  assert.equal(pre[0].matcher, "Bash|Write|Edit");
  const cmd = pre[0].hooks?.[0];
  assert.equal(cmd.type, "command");
  assert.match(cmd.command, /guard\.sh/, "the hook command must invoke guard.sh");
  assert.match(cmd.command, /CLAUDE_PLUGIN_ROOT/, "the path must be plugin-root-relative");
});

test("guard.sh exists, is a shell script, and is executable", async () => {
  const path = join(PLUGIN, "scripts", "guard.sh");
  const body = await readFile(path, "utf8");
  assert.match(body, /^#!/, "guard.sh must start with a shebang");
  assert.match(body, /rewind|@rewind\/mcp/, "guard.sh must invoke the rewind guard");
  const st = await stat(path);
  assert.ok(st.mode & 0o111, "guard.sh must have the executable bit set");
});

test("the install docs carry the Claude Code, Codex, and Cursor snippets", async () => {
  const doc = await readFile(DOCS, "utf8");
  assert.match(doc, /"mcpServers"/, "a JSON mcpServers block for Claude Code / Cursor / Cline / Windsurf");
  assert.match(doc, /\[mcp_servers\.rewind\]/, "a TOML block for Codex CLI");
  assert.match(doc, /claude mcp add/, "the claude mcp add one-liner");
  assert.match(doc, /npx -y @rewind\/mcp mcp/, "the zero-install launch command");
});

test("the Cursor deeplink's base64 config decodes to the exact stdio launch", async () => {
  const doc = await readFile(DOCS, "utf8");
  const m = doc.match(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=([^&\s)]+)&config=([A-Za-z0-9+/=]+)/);
  assert.ok(m, "the docs must contain a well-formed Cursor install deeplink");
  const [, name, b64] = m;
  assert.equal(name, "rewind");
  const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  // The deeplink config is the INNER server-config object (confirmed against Cursor's own
  // in-the-wild deeplinks, which decode to `{"url":...}` with no name wrapper).
  assert.equal(decoded.command, "npx");
  assert.deepEqual(decoded.args, ["-y", "@rewind/mcp", "mcp"]);
});
