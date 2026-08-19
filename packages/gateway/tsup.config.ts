import { defineConfig } from "tsup";

// Compile to publishable ESM + d.ts. `@rewind/core` (a package.json dependency) is auto-externalized,
// so the built gateway imports it as a normal package rather than inlining it.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
