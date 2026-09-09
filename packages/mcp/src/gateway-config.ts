import { readFileSync } from "node:fs";

export interface GatewayConfig {
  port: number;
  upstream: string;
  profile: "compat" | "lean";
  preserveCache: boolean;
  pruneContext: boolean;
}
const FIELDS = ["port", "upstream", "profile", "preserveCache", "pruneContext"] as const;
const ENV_FIELDS = ["REWIND_PORT", "REWIND_UPSTREAM", "REWIND_PROFILE", "REWIND_PRESERVE_CACHE", "REWIND_PRUNE_CONTEXT"] as const;

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
    const switches: Record<string, [string, boolean]> = {
      "--preserve-cache": ["preserveCache", true], "--no-preserve-cache": ["preserveCache", false],
      "--prune-context": ["pruneContext", true], "--no-prune-context": ["pruneContext", false],
    };
    const names: Record<string, string> = { "--port": "port", "--upstream": "upstream", "--profile": "profile", "--config": "config" };
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
  let file: unknown = fileConfig ?? {};
  if (fileConfig === undefined && configPath !== undefined) {
    try { file = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("gateway: config file must be readable JSON"); }
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("gateway: config must be an object");
  for (const key of Object.keys(file)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new Error("gateway: unknown config field");
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
  return { port: Number(port), upstream: upstream as string, profile, preserveCache: boolean("preserveCache", profile === "lean"), pruneContext: boolean("pruneContext", false) };
}

export function gatewayManifest(config: GatewayConfig): unknown {
  return {
    schema: "rewind.gateway-config/v1", profile: config.profile,
    preserveCache: config.preserveCache, pruneContext: config.pruneContext,
    capabilities: {
      preserveCache: { available: true, providers: ["anthropic"], otherProviders: "skipped" },
      pruneContext: { available: true, format: "anthropic-tool-result", otherFormats: "skipped" },
      observationRetrieval: { available: false },
      max: { available: false },
    },
    replayStorage: "memory; cleared on restart",
    savingsReceipt: "replay only; cache/prune dollar attribution not yet available",
  };
}
