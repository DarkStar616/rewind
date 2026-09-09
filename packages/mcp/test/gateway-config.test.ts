import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGatewayConfig } from "../src/gateway-config.ts";

test("gateway profiles preserve compatibility and explicit kill switches win", () => {
  assert.equal(parseGatewayConfig([], {}).preserveCache, false);
  assert.equal(parseGatewayConfig([], {}).pruneContext, false);
  const lean = parseGatewayConfig(["--profile", "lean", "--no-preserve-cache", "--prune-context"], {});
  assert.equal(lean.preserveCache, false);
  assert.equal(lean.pruneContext, true);
  assert.throws(() => parseGatewayConfig(["--profile", "max"], {}), /unavailable/);
});

test("gateway rejects unknown, missing, ambiguous and invalid options", () => {
  for (const args of [["toString"], ["constructor"], ["--upstream=https://example.com/ignored"], ["--unknown"], ["--port"], ["--upstream"], ["--profile"], ["--port", "-1"], ["--port=1e3"], ["--upstream=ftp://example.com"], ["--upstream=https://user:secret@example.com"], ["--preserve-cache=false"], ["--prune-context", "--no-prune-context"]]) {
    assert.throws(() => parseGatewayConfig(args, {}), Error, args.join(" "));
  }
  assert.throws(() => parseGatewayConfig([], { REWIND_PRESERVE_CACHE: "yes" }), /true or false/);
});

test("configuration resolves file then environment then explicit CLI", () => {
  const result = parseGatewayConfig(["--port", "0", "--no-prune-context"], {
    REWIND_PROFILE: "lean", REWIND_PORT: "9000", REWIND_PRUNE_CONTEXT: "true",
  }, { port: 8000, upstream: "http://localhost:8080", preserveCache: false });
  assert.equal(result.port, 0);
  assert.equal(result.upstream, "http://localhost:8080");
  assert.equal(result.preserveCache, false);
  assert.equal(result.pruneContext, false);
  assert.throws(() => parseGatewayConfig([], {}, { unknown: true }), /unknown/);
});


test("explicit config files are read strictly, without exposing invalid contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "rewind-config-"));
  const path = join(dir, "gateway.json");
  try {
    writeFileSync(path, JSON.stringify({ profile: "lean", pruneContext: true }));
    const config = parseGatewayConfig(["--config", path, "--no-prune-context"], {});
    assert.equal(config.preserveCache, true);
    assert.equal(config.pruneContext, false);
    writeFileSync(path, "secret-invalid-json");
    assert.throws(() => parseGatewayConfig([], { REWIND_CONFIG: path }), { message: "gateway: config file must be readable JSON" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("fixed tenant resolves through config, environment and CLI; invalid identity fails", () => {
  assert.equal(parseGatewayConfig(["--tenant", "cli"], { REWIND_TENANT: "env" }, { tenant: "file" }).tenant, "cli");
  assert.equal(parseGatewayConfig([], { REWIND_TENANT: "env" }, { tenant: "file" }).tenant, "env");
  assert.equal(parseGatewayConfig([], {}, { tenant: "file" }).tenant, "file");
  for (const tenant of ["", "bad tenant", "x".repeat(129), null]) assert.throws(() => parseGatewayConfig([], {}, { tenant }));
});
