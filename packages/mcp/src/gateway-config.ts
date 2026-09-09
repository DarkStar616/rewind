import { createFixedTenantResolver } from "@agent-rewind/gateway";
import { readFileSync } from "node:fs";

export interface GatewayConfig {
  tenant?: string;
  storage: "memory" | "sqlite";
  epoch?: string;
  replayCursor?: string;
  storageDirectory?: string;
  port: number;
  upstream: string;
  profile: "compat" | "lean";
  preserveCache: boolean;
  pruneContext: boolean;
}
const FIELDS = ["port", "upstream", "profile", "preserveCache", "pruneContext", "tenant", "storage", "epoch", "replayCursor", "storageDirectory"] as const;
const ENV_FIELDS = ["REWIND_PORT", "REWIND_UPSTREAM", "REWIND_PROFILE", "REWIND_PRESERVE_CACHE", "REWIND_PRUNE_CONTEXT", "REWIND_TENANT", "REWIND_STORAGE", "REWIND_EPOCH", "REWIND_REPLAY_CURSOR", "REWIND_STORAGE_DIRECTORY"] as const;

/** Strict, explicit opt-in: profile defaults < file overrides < environment < CLI. */
export function parseGatewayConfig(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fileConfig?: unknown,
): GatewayConfig {
  const cli: Record<string, unknown> = {};
  const seen = new Set<string>();
  let configPath = env.REWIND_CONFIG;
  for (let i = 0; i < args.length; i++) {
    const [flag, ...equalValue] = args[i].split("=");
    if (flag === "--record-only") {
      if (equalValue.length) throw new Error("gateway: --record-only takes no value");
      if (seen.has("replayCursor")) throw new Error("gateway: duplicate or conflicting replayCursor option");
      seen.add("replayCursor");
      cli.replayCursor = undefined;
      continue;
    }
    const switches: Record<string, [string, boolean]> = {
      "--preserve-cache": ["preserveCache", true], "--no-preserve-cache": ["preserveCache", false],
      "--prune-context": ["pruneContext", true], "--no-prune-context": ["pruneContext", false],
    };
    const names: Record<string, string> = { "--port": "port", "--upstream": "upstream", "--profile": "profile", "--config": "config", "--tenant": "tenant", "--storage": "storage", "--epoch": "epoch", "--replay-cursor": "replayCursor", "--storage-directory": "storageDirectory" };
    const toggle = Object.hasOwn(switches, flag) ? switches[flag] : undefined;
    const key = toggle?.[0] ?? (Object.hasOwn(names, flag) ? names[flag] : undefined);
    if (!key) throw new Error("gateway: unknown option (see --help)");
    if (seen.has(key)) throw new Error(`gateway: duplicate or conflicting ${key} option`);
    seen.add(key);
    if (toggle) {
      if (equalValue.length) throw new Error(`gateway: ${flag} takes no value; use its --no- switch to disable`);
      cli[key] = toggle[1];
    } else {
      const value = equalValue.length ? equalValue.join("=") : args[++i];
      if (!value || value.startsWith("--")) throw new Error(`gateway: ${flag} requires a value`);
      if (key === "config") configPath = value;
      else cli[key] = value;
    }
  }
  let file: unknown = fileConfig === undefined ? {} : fileConfig;
  if (fileConfig === undefined && configPath !== undefined) {
    try { file = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("gateway: config file must be readable JSON"); }
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("gateway: config must be an object");
  for (const key of Object.keys(file)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new Error("gateway: unknown config field");
    if ((file as Record<string, unknown>)[key] === null) throw new Error(`gateway: ${key} cannot be null; omit it to use the default`);
  }
  const environment = Object.fromEntries(FIELDS.flatMap((field, i) => env[ENV_FIELDS[i]] === undefined ? [] : [[field, env[ENV_FIELDS[i]]]]));
  const values: Record<string, unknown> = { ...file, ...environment, ...cli };
  const profile = values.profile ?? "compat";
  if (profile === "max") throw new Error("gateway: max profile unavailable until observation retrieval and shaping are ready; choose lean and opt in with --prune-context");
  if (profile !== "compat" && profile !== "lean") throw new Error("gateway: profile must be compat or lean (max unavailable)");
  const port = values.port ?? 8788;
  if ((typeof port !== "number" && (typeof port !== "string" || !/^\d+$/.test(port))) || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
    throw new Error("gateway: port must be an integer 0-65535");
  }
  const upstream = values.upstream ?? "https://api.anthropic.com";
  let url: URL;
  try { if (typeof upstream !== "string") throw new Error(); url = new URL(upstream); }
  catch { throw new Error("gateway: upstream must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("gateway: upstream must be HTTP(S), with a root path, without credentials, query or fragment");
  }
  const boolean = (key: string, fallback: boolean): boolean => {
    const value = values[key];
    if (value === undefined) return fallback;
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw new Error(`gateway: ${key} must be true or false`);
  };
  if (values.tenant !== undefined) createFixedTenantResolver(values.tenant as string);
  const storage = values.storage ?? "memory";
  if (storage !== "memory" && storage !== "sqlite") throw new Error("gateway: storage must be memory or sqlite");
  if (storage !== "sqlite" && seen.has("replayCursor")) throw new Error("gateway: replay cursor and record-only require sqlite");
  if (storage === "sqlite" && (values.tenant === undefined || values.epoch === undefined)) throw new Error("gateway: sqlite requires tenant and epoch");
  if (storage === "memory" && [values.epoch, values.replayCursor, values.storageDirectory].some(v => v !== undefined)) throw new Error("gateway: epoch, replay cursor and storage directory require sqlite");
  for (const key of ["epoch", "replayCursor"]) if (values[key] !== undefined && (typeof values[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(values[key] as string))) throw new Error(`gateway: invalid ${key}`);
  if (values.storageDirectory !== undefined && (typeof values.storageDirectory !== "string" || !values.storageDirectory || /[\x00-\x1f\x7f]/.test(values.storageDirectory))) throw new Error("gateway: invalid storage directory");
  return { storage, epoch: values.epoch as string | undefined, replayCursor: values.replayCursor as string | undefined, storageDirectory: values.storageDirectory as string | undefined, ...(values.tenant === undefined ? {} : { tenant: values.tenant as string }), port: Number(port), upstream: upstream as string, profile, preserveCache: boolean("preserveCache", profile === "lean"), pruneContext: boolean("pruneContext", false) };
}

export function gatewayManifest(config: GatewayConfig): unknown {
  return {
    schema: "rewind.gateway-config/v1", profile: config.profile,
    identity: config.tenant === undefined ? { mode: "legacy-caller-scope" } : { mode: "fixed-local-tenant", tenant: config.tenant },
    preserveCache: config.preserveCache, pruneContext: config.pruneContext,
    capabilities: {
      preserveCache: { available: true, providers: ["anthropic"], otherProviders: "skipped" },
      pruneContext: { available: true, format: "anthropic-tool-result", otherFormats: "skipped" },
      observationRetrieval: { available: false },
      max: { available: false },
    },
    replayStorage: config.storage === "sqlite" ? { engine: "encrypted-sqlite", mode: config.replayCursor ? "ordered-replay" : "record-only", epoch: config.epoch, cursor: config.replayCursor, directory: config.storageDirectory ?? ".rewind/storage" } : "memory; cleared on restart",
    savingsReceipt: config.storage === "sqlite" ? "ordered replay receipt integration pending; no savings booked" : "replay only; cache/prune dollar attribution not yet available",
  };
}
