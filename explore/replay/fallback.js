// The answer to a request replay has no recording for: the smallest reply that fits the JSON schema it asked for (so
// the backend carries on), or a short plain-text note. Every fallback is counted as a miss.

export const NOTE = "This is a demo answer: the replay has no recording for this request yet.";

export function fromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 8) return null;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ("const" in schema) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) out[k] = fromSchema(v, depth + 1);
      return out;
    }
    case "array": {
      const n = Math.max(0, schema.minItems || 0);
      return Array.from({ length: n }, () => fromSchema(schema.items || {}, depth + 1));
    }
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return false;
    case "string": {
      const min = schema.minLength || 0;
      return min ? "demo".padEnd(min, ".") : "";
    }
    default:
      return null;
  }
}

export function fallback(body) {
  if (body?.format === "json") return "{}";
  return body?.format && typeof body.format === "object" ? JSON.stringify(fromSchema(body.format)) : NOTE;
}
