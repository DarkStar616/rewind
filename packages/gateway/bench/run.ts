/** `node packages/gateway/bench/run.ts` — print the deterministic savings report. No API key. */
import { runBench, formatReport } from "./bench.ts";

const report = await runBench();
console.log(formatReport(report));
