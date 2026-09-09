const PROFILES = {
  lean: ["checkpoint", "rewind", "guard_effect"],
  recovery: ["checkpoint", "list", "rewind", "replay", "guard_effect", "backtrack_candidates", "backtrack_commit"],
  analytics: ["savings"],
  all: ["checkpoint", "list", "rewind", "replay", "guard_effect", "savings", "backtrack_candidates", "backtrack_commit"],
} as const;
export type McpProfile = keyof typeof PROFILES;

export function mcpProfile(value: unknown = "all"): { profile: McpProfile; tools: readonly string[]; instructions: string } {
  if (typeof value !== "string" || !Object.hasOwn(PROFILES, value)) throw new Error("MCP profile must be lean, recovery, analytics or all");
  const profile = value as McpProfile;
  const instructions = [
    `Rewind profile: ${profile}. Tier 0 is reversibility, not isolation or security.`,
    profile === "analytics" ? "Savings are estimates of avoided replay calls, not provider bills." :
      "Checkpoint before a meaningful risky change; keep its id. Rewind restores the workspace to that id. " +
      "Before an irreversible external effect, call guard_effect with a stable effectKey; never execute a refused effect. " +
      "The guard records admission; it does not execute or sandbox the effect.",
    profile === "lean" ? "Use the recovery profile for history and failure memory; analytics for savings." :
      profile === "recovery" || profile === "all" ? "Use list for history; backtrack_commit records a failure note while restoring. replay reports savings and does not execute code." : "",
  ].filter(Boolean).join(" ");
  return { profile, tools: PROFILES[profile], instructions };
}

export function parseMcpProfile(args: readonly string[], env: Readonly<Record<string, string | undefined>>): McpProfile {
  let value: unknown = env.REWIND_MCP_PROFILE ?? "all";
  if (args.length === 2 && args[0] === "--profile") value = args[1];
  else if (args.length === 1 && args[0].startsWith("--profile=")) value = args[0].slice(10);
  else if (args.length !== 0) throw new Error("usage: rewind mcp [--profile lean|recovery|analytics|all]");
  return mcpProfile(value).profile;
}
