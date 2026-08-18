export class CanonicalJsonError extends Error {}

export function canonicalize(value: unknown): string {
  return serialise(value, new Set());
}

// `ancestors` tracks the containers on the current path from the root, NOT every container ever
// visited. A value is added before recursing into its children and removed afterwards, so a DAG
// (the same object referenced by two sibling keys) still canonicalises, while a genuine cycle — a
// container that contains itself, directly or transitively — is caught before it overflows the
// stack. Detection changes nothing for acyclic input: no acyclic value is ever its own ancestor,
// so the emitted bytes (and therefore every entry hash) are identical to before.
function serialise(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`a non-finite number (${String(value)}) has no canonical form`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new CanonicalJsonError("a circular reference has no canonical form");
    }
    ancestors.add(value);
    const parts: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new CanonicalJsonError("an array hole has no canonical form; represent absence with null");
      }
      parts.push(serialiseElement(value[index], ancestors));
    }
    ancestors.delete(value);
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) {
      throw new CanonicalJsonError(
        `only plain objects and arrays can be canonicalised; a ${proto.constructor?.name ?? "non-plain object"} cannot`,
      );
    }
    if (ancestors.has(value)) {
      throw new CanonicalJsonError("a circular reference has no canonical form");
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${serialise(record[key], ancestors)}`).join(",");
    ancestors.delete(value);
    return `{${body}}`;
  }
  throw new CanonicalJsonError(`a value of type ${typeof value} has no canonical form`);
}

function serialiseElement(value: unknown, ancestors: Set<object>): string {
  if (value === undefined) {
    throw new CanonicalJsonError("an array hole (undefined) has no canonical form; represent absence with null");
  }
  return serialise(value, ancestors);
}
