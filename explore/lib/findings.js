// The run's findings: each step passes or fails, and anything odd is noted as a bug or a note, with a screenshot,
// into findings.md in the run's output folder (outside the repo).

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.EXPLORE_OUT || join(process.cwd(), "out", "adhoc");
const FILE = join(OUT, "findings.md");
let shot = 0;

function ensure() {
  mkdirSync(join(OUT, "shots"), { recursive: true });
  if (!existsSync(FILE)) writeFileSync(FILE, `# Exploratory run ${new Date().toISOString()}\n\n`);
}

// Masks anything that looks like a key or a password before it reaches the findings.
export function mask(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").replace(/\b(fc|tvly|sk|scp)-[A-Za-z0-9_-]{8,}/g, "$1-…").replace(/([A-Za-z0-9_-]{28,})/g, (m) => `${m.slice(0, 4)}…`);
}

async function screenshot(page, label) {
  if (!page) return "";
  ensure();
  const name = `${String(++shot).padStart(3, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png`;
  await page.screenshot({ path: join(OUT, "shots", name) }).catch(() => {});
  return `shots/${name}`;
}

export async function record(kind, journey, text, page) {
  ensure();
  const img = await screenshot(page, `${journey}-${kind}`);
  appendFileSync(FILE, `- **${kind}** [${journey}] ${mask(text)}${img ? ` ([screenshot](${img}))` : ""}\n`);
}

// One named step: recorded as pass or fail; a failure keeps its screenshot and rethrows so the journey pauses.
export async function step(journey, name, page, fn) {
  try {
    const out = await fn();
    ensure();
    appendFileSync(FILE, `- pass [${journey}] ${name}\n`);
    return out;
  } catch (err) {
    await record("FAIL", journey, `${name}: ${err.message.split("\n")[0]}`, page);
    throw err;
  }
}

export const bug = (journey, text, page) => record("BUG", journey, text, page);
export const note = (journey, text, page) => record("note", journey, text, page);
