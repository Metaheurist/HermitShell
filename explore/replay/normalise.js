// Replay keys: a model request is looked up by a hash of its prompt with everything that changes from run to run
// (today's date, clock times, random profile ids and hashes) replaced by a token, so a recording made on one day
// answers the same request on any other. The model name is left out, so changing it doesn't miss.

import { createHash } from "node:crypto";

const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
const WEEKDAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const RULES = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TIME>"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>"],
  [new RegExp(`\\b(?:${WEEKDAY},?\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{4}\\b`, "g"), "<DATE>"],
  [new RegExp(`\\b(?:${WEEKDAY},?\\s+)?${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "g"), "<DATE>"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<DATE>"],
  [new RegExp(`\\b${WEEKDAY}\\b`, "g"), "<DAY>"],
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|AM|PM))?\b/g, "<TIME>"],
  [/\b[a-z]+(?:-[a-z]+)*-[0-9a-f]{6}\b/g, "<ID>"],
  [/\b[0-9a-f]{16,64}\b/g, "<HEX>"],
  [/\b(?:BST|GMT|UTC)\b/g, "<TZ>"],
];

export function normalise(text) {
  let out = String(text ?? "");
  for (const [re, token] of RULES) out = out.replace(re, token);
  return out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

// The key of an Ollama /api/chat body: its messages and output format, normalised.
export function requestKey(body) {
  const messages = (body?.messages || []).map((m) => `${m.role}\n${normalise(m.content)}`).join("\n\u0000\n");
  const format = body?.format ? JSON.stringify(body.format) : "";
  return createHash("sha256").update(`${messages}\n\u0001\n${format}`).digest("hex").slice(0, 32);
}

// What kind of request it is, for the miss report and the fallback: the first words of the system prompt.
export function taskOf(body) {
  const system = (body?.messages || []).find((m) => m.role === "system")?.content || "";
  return normalise(system).split(/\s+/).slice(0, 8).join(" ").slice(0, 80) || "unknown";
}
