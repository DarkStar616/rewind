import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const correlationStore = new AsyncLocalStorage<string>();

export const UNBOUND_CORRELATION_PREFIX = "unbound:";

export function newCorrelationId(): string {
  return randomUUID();
}

export function currentCorrelationId(): string | undefined {
  return correlationStore.getStore();
}

export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStore.run(correlationId, fn);
}

export function withCorrelation<T>(fn: () => T): T {
  return withCorrelationId(newCorrelationId(), fn);
}

export function withoutCorrelation<T>(fn: () => T): T {
  return correlationStore.exit(fn);
}

export function correlationIdForEvent(): string {
  return correlationStore.getStore() ?? `${UNBOUND_CORRELATION_PREFIX}${randomUUID()}`;
}

export function isCorrelated(correlationId: string): boolean {
  return !correlationId.startsWith(UNBOUND_CORRELATION_PREFIX);
}

export const MAX_CORRELATION_ID_LENGTH = 200;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function resolveInboundCorrelation(inbound: string | string[] | undefined): string {
  const raw = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed && trimmed.length <= MAX_CORRELATION_ID_LENGTH && !hasControlChars(trimmed)) {
      return trimmed;
    }
  }
  return newCorrelationId();
}
