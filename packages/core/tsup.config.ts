import { defineConfig } from "tsup";

// Compile the source (which uses `.ts` import specifiers for the Node-native dev workflow) into
// publishable ESM + type declarations. tsup (esbuild) rewrites the `.ts` extensions to `.js` on emit —
// something plain `tsc` cannot do with `allowImportingTsExtensions`. Workspace/runtime deps listed in
// package.json are auto-externalized, so only this package's own code is bundled.
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
