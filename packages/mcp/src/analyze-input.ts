import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createTrafficAnalyzer, attestAnalysis, type AnalyzedCall } from "@agent-rewind/gateway";

/** Bounded input and summary output; request content never appears in parser errors. */
export async function analyzeInput(args: readonly string[], stdin: AsyncIterable<Uint8Array> = process.stdin) {
  let source: (() => AsyncIterable<Uint8Array>) | undefined, ndjson = false, legacy = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ndjson" && !ndjson) ndjson = true;
    else if (args[i] === "--legacy-json" && !legacy) legacy = true;
    else if (args[i] === "--stdin" && !source) source = () => stdin;
    else if (args[i] === "--file" && !source && args[i + 1] && !args[i + 1].startsWith("--")) { const path = args[++i]; source = () => createReadStream(path); }
    else if (!source && !args[i].startsWith("--")) { const json = args[i]; source = async function* () { yield Buffer.from(json); }; }
    else throw new Error("usage: analyze (--file PATH|--stdin|JSON) [--ndjson] [--legacy-json]");
  }
  if (!source) throw new Error("analyze requires a JSON array or --file/--stdin (optionally --ndjson)");
  const digest = createHash("sha256");
  let inputBytes = 0, pending = Buffer.alloc(0);
  const analyzer = createTrafficAnalyzer({ sample: legacy ? "full" : "none", maxKeys: 100_000, maxScopes: 1_000 });
  const parse = (bytes: Buffer): unknown => {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("invalid JSON"); }
  };
  const add = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a call object");
    analyzer.add(value as AnalyzedCall);
  };
  try {
    for await (const part of source()) {
      const chunk = Buffer.from(part);
      inputBytes += chunk.length;
      digest.update(chunk);
      if (inputBytes > 128 * 1024 * 1024) throw new Error("input size limit exceeded");
      pending = Buffer.concat([pending, chunk]);
      if (ndjson) {
        let end: number;
        while ((end = pending.indexOf(10)) !== -1) {
          if (end > 2 * 1024 * 1024) throw new Error("NDJSON record size limit exceeded");
          const line = pending.subarray(0, end);
          if (line.toString().trim()) add(parse(line));
          pending = pending.subarray(end + 1);
        }
      }
      if (pending.length > (ndjson ? 2 : 16) * 1024 * 1024) throw new Error("JSON buffer size limit exceeded");
    }
    if (ndjson) { if (pending.toString().trim()) add(parse(pending)); }
    else {
      const values = parse(pending);
      if (!Array.isArray(values)) throw new Error("expected a JSON array of calls");
      for (const value of values) add(value);
    }
  } catch (error) {
    const safeReasons = new Set([
      "invalid JSON", "expected a call object", "expected a JSON array of calls",
      "input size limit exceeded", "NDJSON record size limit exceeded", "JSON buffer size limit exceeded",
      "analysis scope cardinality limit exceeded", "analysis key cardinality limit exceeded",
      "analysis counter limit exceeded", "invalid analysis call/scope", "invalid analysis usage",
    ]);
    const reason = error instanceof Error && safeReasons.has(error.message)
      ? error.message : "input unavailable or invalid call";
    throw new Error(`analyze: ${reason}; bytes=${inputBytes}; sha256=${digest.digest("hex")}`);
  }
  const report = analyzer.result();
  const sourceEvidence = { bytes: inputBytes, sha256: digest.digest("hex"), format: ndjson ? "ndjson" : "json" };
  const result = legacy ? report : { ...report, perScope: [], scopeCount: report.perScope.length, source: sourceEvidence,
    sampleOmitted: true, interpretation: "Hypothetical exact-request repeat opportunities, not realized savings." };
  const attested = attestAnalysis(result);
  return { chain: attested.chain, rootHash: attested.rootHash };
}
