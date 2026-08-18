export class CanonicalJsonError extends Error {}

export function canonicalize(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
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
    const parts: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new CanonicalJsonError("an array hole has no canonical form; represent absence with null");
      }
      parts.push(serialiseElement(value[index]));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) {
      throw new CanonicalJsonError(
        `only plain objects and arrays can be canonicalised; a ${proto.constructor?.name ?? "non-plain object"} cannot`,
      );
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialise(record[key])}`).join(",")}}`;
  }
  throw new CanonicalJsonError(`a value of type ${typeof value} has no canonical form`);
}

function serialiseElement(value: unknown): string {
  if (value === undefined) {
    throw new CanonicalJsonError("an array hole (undefined) has no canonical form; represent absence with null");
  }
  return serialise(value);
}
