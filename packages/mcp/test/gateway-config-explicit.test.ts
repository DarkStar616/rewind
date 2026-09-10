import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGatewayConfig } from "../src/gateway-config.ts";

test("explicit null configuration is rejected instead of changing provider or durability defaults", () => {
  assert.throws(() => parseGatewayConfig([], {}, null), /object/);
  for (const field of ["storage", "profile", "port", "upstream"]) {
    assert.throws(() => parseGatewayConfig([], {}, { [field]: null }), /null/);
  }
});

test("record-only explicitly overrides inherited cursors but cannot conflict with a CLI cursor", () => {
  const args = ["--storage", "sqlite", "--tenant", "t", "--epoch", "new", "--record-only"];
  const config = parseGatewayConfig(args, { REWIND_REPLAY_CURSOR: "old" }, { replayCursor: "older" });
  assert.equal(config.replayCursor, undefined);
  assert.equal(config.storage, "sqlite");
  for (const extra of [["--replay-cursor", "c"], ["--record-only"], ["--record-only=true"]]) {
    assert.throws(() => parseGatewayConfig([...args, ...extra], {}));
  }
  assert.throws(() => parseGatewayConfig(["--record-only"], {}), /sqlite/);
});
