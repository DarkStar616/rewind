/** JSON only on stdout; redirect it to retain the versioned offline artifact. */
import { buildBenchArtifact } from "./artifact.ts";
process.stdout.write(`${JSON.stringify(await buildBenchArtifact(), null, 2)}\n`);
