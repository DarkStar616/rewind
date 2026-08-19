# Publishing Rewind to npm

The three packages (`@rewind/core`, `@rewind/gateway`, `@rewind/mcp`) are packaged and ready. This is
the exact sequence to publish them. **You run these** (publishing needs your npm login); everything
else is already wired.

## 0. One-time prerequisite — claim the `@rewind` scope

The packages are scoped `@rewind/*`, and that scope is **baked into the product** (the Claude Code
plugin, the Cursor deeplink, and every install snippet all launch `npx -y @rewind/mcp mcp`). To publish
under it you must own the `@rewind` npm **org**:

1. Go to <https://www.npmjs.com/org/create> and create an organization named **`rewind`** (the free
   "Unlimited public packages" plan is enough).
2. If the name `rewind` is **already taken**, stop — we need to pick a different scope (e.g.
   `@darkstar616/*`). That's a one-pass rename across the three `package.json`s, the plugin
   `.mcp.json`, the Cursor deeplink, and the docs — tell me and I'll do it in one commit.

> Scoped packages default to **private**; each `package.json` already sets
> `"publishConfig": { "access": "public" }`, so they publish publicly without an extra flag.

## 1. Log in

```bash
npm login          # or `npm login --scope=@rewind` — sign in as the account that owns the org
npm whoami         # confirm
```

## 2. Build and verify (from the repo root)

```bash
npm run build      # tsup → dist/ for all three packages (also runs automatically on publish)
npm run check      # 285 tests + typecheck, all green
```

## 3. Publish — in dependency order

`gateway` and `mcp` depend on `core`, so publish core first, then gateway, then mcp. (`prepublishOnly`
rebuilds `dist/` for each, so the published tarball is always fresh.)

```bash
npm publish -w @rewind/core
npm publish -w @rewind/gateway
npm publish -w @rewind/mcp
```

If your account has 2FA on (recommended), npm will prompt for a one-time code each time, or use
`--otp=<code>`.

## 4. Verify it's live

```bash
npm view @rewind/mcp version                 # should print 0.1.0
npx -y @rewind/mcp@0.1.0 checkpoint --help   # runs the published CLI from a clean cache
```

Then the real end-to-end: in any git repo, `npx -y @rewind/mcp mcp` starts the MCP server, and the
Claude Code / Cursor / Codex snippets in `docs/install/README.md` wire it into your agent.

## 5. Tag the release

```bash
git tag v0.1.0
git push rewind v0.1.0
```

## Publishing later versions

Bump the version in all three `package.json`s (keep them in lockstep for a 0.x monorepo), and bump the
`@rewind/core` / `@rewind/gateway` dependency ranges in the dependents if you cross a minor. Then repeat
steps 2–5. A `changeset`-style tool can automate this later; it isn't needed for the first release.

## What's already done for you

- `dist/` build (ESM + `.d.ts`) via tsup, with `.ts`-specifier rewriting — **[verified]** the built CLI
  runs end-to-end (`checkpoint`, `list`, `analyze`) resolving the built `dist` of all three packages.
- `files` allow-lists (`dist`, plus the Claude Code plugin `dist-plugin/` for `@rewind/mcp`, plus each
  README) — **[verified]** via `npm pack --dry-run`: no `src`/tests leak into the tarball.
- `exports` with a `development` condition so the test suite still runs against source (no build needed
  for `npm run check`), while published consumers get `dist`.
- Per-package README (the npm landing page), keywords, repository, homepage, and `engines: ">=20"`.
- `publishConfig.access = public` on all three.
