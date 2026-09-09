import { defineConfig } from "tsup";

// Compile to publishable ESM + d.ts. `@agent-rewind/core` (a package.json dependency) is auto-externalized,
// so the built gateway imports it as a normal package rather than inlining it.
export default defineConfig({
  entry: { index: "src/index.ts", "storage-worker": "src/storage/storage-worker.ts" },
  external: ["better-sqlite3"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
