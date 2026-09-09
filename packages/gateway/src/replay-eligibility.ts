/** Remote tools and provider-owned conversation/cache state are not captured by our tape.
 * Unknown tool kinds fail closed for replay; ordinary client-executed functions remain eligible.
 * This checks provider envelopes, never similarly named fields inside tool arguments.
 */
export function replayEligible(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const request = body as Record<string, unknown>;
  for (const field of ["previous_response_id", "conversation", "container", "mcp_servers", "cachedContent", "cached_content", "prompt", "web_search_options"]) {
    if (Object.hasOwn(request, field) && request[field] != null) return false;
  }
  if (typeof request.model === "string" && /search/i.test(request.model)) return false;
  // Walk protocol content slots only: schemas and client function arguments stay opaque.
  let remaining = 100_000;
  const localContent = (value: unknown, depth = 0): boolean => {
    if (--remaining < 0 || depth > 64) return false;
    if (Array.isArray(value)) return value.every(item => localContent(item, depth + 1));
    if (!value || typeof value !== "object") return true;
    const block = value as Record<string, unknown>;
    if (block.type === "item_reference") return false;
    if (block.audio && typeof block.audio === "object" && Object.hasOwn(block.audio, "id")) return false;
    for (const key of ["file_id", "file_url", "fileData", "file_data", "attachments"]) {
      // file_data on an OpenAI input_file is inline data, not a hosted reference.
      if (key === "file_data" && typeof block[key] === "string") continue;
      if (Object.hasOwn(block, key)) return false;
    }
    if (Object.hasOwn(block, "image_url")) {
      const image = block.image_url;
      const url = typeof image === "string" ? image : (image as { url?: unknown } | null)?.url;
      if (typeof url !== "string" || !url.startsWith("data:")) return false;
    }
    if (block.source && typeof block.source === "object") {
      const source = block.source as Record<string, unknown>;
      if (source.type !== "base64" && source.type !== "text" && source.type !== "content") return false;
      if (source.type === "content" && !localContent(source.content, depth + 1)) return false;
    }
    return ["content", "parts"].every(key => !Object.hasOwn(block, key) || localContent(block[key], depth + 1));
  };
  if (!["messages", "input", "contents", "system"].every(key => localContent(request[key]))) return false;
  if (request.tools === undefined) return true;
  if (!Array.isArray(request.tools)) return false;
  return request.tools.every((tool: unknown) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const t = tool as Record<string, unknown>;
    if (Object.hasOwn(t, "functionDeclarations")) {
      return Object.keys(t).every(key => key === "functionDeclarations") &&
        Array.isArray(t.functionDeclarations) && t.functionDeclarations.every(declaration =>
          declaration && typeof declaration === "object" && typeof declaration.name === "string");
    }
    if (t.type === "function") {
      const fn = t.function as Record<string, unknown> | undefined;
      return typeof t.name === "string" || (!!fn && typeof fn.name === "string");
    }
    return t.type === undefined && typeof t.name === "string";
  });
}
