# Publishing Agent Rewind to npm

The three packages (`@agent-rewind/core`, `@agent-rewind/gateway`, `@agent-rewind/mcp`) are packaged and
ready. This is the exact sequence to publish them. **You run these** (publishing needs your npm login);
everything else is already wired.

## 0. Prerequisite — the `@agent-rewind` org (already created ✅)

The packages are scoped `@agent-rewind/*`, and that scope is **baked into the product** (the Claude Code
plugin, the Cursor deeplink, and every install snippet launch `npx -y @agent-rewind/mcp mcp`). You've
already created the **`agent-rewind`** npm org, so you're set — just make sure you're logged in as a
member of it (step 1).

> Scoped packages default to **private**; each `package.json` already sets
> `"publishConfig": { "access": "public" }`, so they publish publicly without an extra flag.

## 1. Log in

```bash
npm login          # sign in as the account that owns/belongs to the @agent-rewind org
npm whoami         # confirm
```

## 2. Build and verify (from the repo root)

```bash
npm run build      # tsup → dist/ for all three packages (also runs automatically on publish)
npm run check      # 334 tests + typecheck, all green
```

## 3. Publish — in dependency order

`gateway` and `mcp` depend on `core`, so publish core first, then gateway, then mcp. (`prepublishOnly`
rebuilds `dist/` for each, so the published tarball is always fresh.)

```bash
npm publish -w @agent-rewind/core
npm publish -w @agent-rewind/gateway
npm publish -w @agent-rewind/mcp
```

If your account has 2FA on (recommended), npm will prompt for a one-time code each time, or use
`--otp=<code>`.

## 4. Verify it's live

```bash
npm view @agent-rewind/mcp version                 # should print 1.0.0
npx -y @agent-rewind/mcp@1.0.0 checkpoint --help   # runs the published CLI from a clean cache
```

Then the real end-to-end: in any git repo, `npx -y @agent-rewind/mcp mcp` starts the MCP server, and the
Claude Code / Cursor / Codex snippets in `docs/install/README.md` wire it into your agent.

## 5. Tag the release

```bash
git tag v1.0.0
git push rewind v1.0.0
```

## Publishing later versions

Bump the version in all three `package.json`s (keep them in lockstep across the monorepo), and bump the
`@agent-rewind/core` / `@agent-rewind/gateway` dependency ranges in the dependents when you cross a major (or a minor with new surface). Then repeat
steps 2–5. A `changeset`-style tool can automate this later; it isn't needed for the first release.

## What's already done for you

- `dist/` build (ESM + `.d.ts`) via tsup, with `.ts`-specifier rewriting — **[verified]** the built CLI
  runs end-to-end (`checkpoint`, `list`, `analyze`) resolving the built `dist` of all three packages.
- `files` allow-lists (`dist`, plus the Claude Code plugin `dist-plugin/` for `@agent-rewind/mcp`, plus each
  README) — **[verified]** via `npm pack --dry-run`: no `src`/tests leak into the tarball.
- `exports` with a `development` condition so the test suite still runs against source (no build needed
  for `npm run check`), while published consumers get `dist`.
- Per-package README (the npm landing page), keywords, repository, homepage, and `engines: ">=20"`.
- `publishConfig.access = public` on all three.
