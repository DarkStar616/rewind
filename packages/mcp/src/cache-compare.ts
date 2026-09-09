import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { compareRequestPrefix } from "./prefix-compare.ts";

async function readRequest(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await file.close(); }
}

/** Read-only diagnostics: no model calls, request rewriting, or workspace initialization. */
export async function compareRequestFiles(args: readonly string[]) {
  if (args.length !== 2 || args.some(path => !path || path.startsWith("--"))) {
    throw new Error("usage: cache-compare <previous.json> <current.json>");
  }
  let previous: unknown, current: unknown;
  try {
    previous = await readRequest(args[0]);
    current = await readRequest(args[1]);
  } catch {
    throw new Error("cache-compare: inputs must be readable regular UTF-8 JSON files, at most 2 MiB each");
  }
  const report = compareRequestPrefix(previous, current);
  const recommendation = report.relation === "diverged"
    ? "Inspect firstChangedPath; changed history or settings may require a new cache write."
    : "Previous content is intact. Cache reuse still depends on the provider, model, routing and TTL.";
  return { ...report, recommendation };
}
