import type { IncomingHttpHeaders } from "node:http";

export interface TrustedScope { tenant: string; scope: string }
export interface ScopeRequest { headers: Readonly<IncomingHttpHeaders>; method?: string; url?: string }
/** Application-owned identity decision, never an assertion supplied by the HTTP caller. */
export type ScopeResolver = (request: ScopeRequest) => TrustedScope | Promise<TrustedScope>;

function validateId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new Error("trusted scope identifiers must be 1-128 ASCII letters, digits or . _ : / -; begin with a letter or digit");
  }
}
/** Structural keying avoids delimiter collisions. Do not share a legacy untrusted-scope store. */
export function encodeTrustedScope(identity: TrustedScope): string {
  validateId(identity?.tenant); validateId(identity?.scope);
  return JSON.stringify([identity.tenant, identity.scope]);
}
/** Pilot: one listener/process/store per configured tenant; callers select subordinate scopes only. */
export function createFixedTenantResolver(tenant: string, scopeHeader = "x-rewind-scope"): (request: ScopeRequest) => TrustedScope {
  validateId(tenant);
  const header = scopeHeader.toLowerCase();
  return (request) => {
    const scope = request.headers[header] ?? "default";
    validateId(scope); // duplicate/array/comma-joined headers are refused, never silently selected
    return { tenant, scope };
  };
}
