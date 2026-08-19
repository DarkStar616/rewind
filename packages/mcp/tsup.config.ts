import { defineConfig } from "tsup";

// Build the `rewind` CLI (the bin) into one self-contained ESM file. cli.ts's local imports (server,
// build-engine, durable stores, savings) are bundled in; the runtime deps `@agent-rewind/core`,
// `@agent-rewind/gateway`, `@modelcontextprotocol/sdk` and `zod` (all package.json dependencies) are
// auto-externalized and installed by npm. The `#!/usr/bin/env node` shebang is preserved by tsup, and
// npm sets the exec bit on the bin at install time. No d.ts — this package has no library entry.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: false,
  sourcemap: true,
  clean: true,
});
