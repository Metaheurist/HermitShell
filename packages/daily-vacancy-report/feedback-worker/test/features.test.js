import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { featureOn } from "../src/settings.js";
import { BASE, testEnv, valuesWith } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const OWNER = { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true };
const STATUS = { profiles: [OWNER], features: { alerts: true, prep_auto: false } };

function post(path, fields, headers = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
  return new Request(`${BASE}${path}`, { method: "POST", body, headers });
}

async function setup(status = STATUS) {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify(status) }), env);
  const res = await worker.fetch(post("/admin/login", { username: "admin", password: ADMIN.ADMIN_PASSWORD }, { "CF-Connecting-IP": "203.0.113.9" }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  const get = async (path) => (await worker.fetch(new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }), env)).text();
  const csrf = (await get("/admin")).match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const act = (fields) => worker.fetch(post("/admin/action", { csrf, ...fields }, { Cookie: cookie }), env);
  return { env, get, act };
}

describe("Global settings, Features", () => {
  it("shows only the switches HermitShell reports, as it reports them", async () => {
    const { get } = await setup();
    const body = await get("/admin/settings");
    expect(body).toContain('<h2 id="features">Features</h2>');
    expect(body).toContain('name="alerts" value="1" checked>');
    expect(body).toContain('name="prep_auto" value="1">');
    expect(body).not.toContain('name="word_copies"');
    expect(body).not.toContain('name="self_service"');
  });

  it("has no Features section for a HermitShell that reports none", async () => {
    const { get } = await setup({ profiles: [OWNER] });
    expect(await get("/admin/settings")).not.toContain('id="features"');
  });

  it("queues the shown switches as true or false, and nothing else", async () => {
    const { env, act, get } = await setup();
    const res = await act({ action: "features", shown: ["alerts", "prep_auto", "HERMES_DATA_KEY"], prep_auto: "1",
      HERMES_DATA_KEY: "x", word_copies: "1" });
    expect(res.headers.get("Location")).toBe("/admin/settings?done=queued#features");
    const [item] = valuesWith(env, "queue:");
    expect(item).toMatchObject({ type: "admin", action: "features", alerts: false, prep_auto: true });
    expect(Object.keys(item)).not.toContain("HERMES_DATA_KEY");
    expect(Object.keys(item)).not.toContain("word_copies");
    const body = await get("/admin/settings");
    expect(body).toContain('name="prep_auto" value="1" checked>');
    expect(body).toContain('name="alerts" value="1">');
    expect(body).toContain("the features");
  });

  it("queues nothing when no switch was on the form", async () => {
    const { env, act } = await setup();
    const res = await act({ action: "features", alerts: "1" });
    expect(res.headers.get("Location")).toBe("/admin/settings?done=nochange#features");
    expect(valuesWith(env, "queue:")).toEqual([]);
  });

  it("featureOn falls back to the default for missing or odd values", () => {
    expect(featureOn({}, "alerts")).toBe(true);
    expect(featureOn({ features: { alerts: "no" } }, "alerts")).toBe(true);
    expect(featureOn({ features: { self_service: true } }, "self_service")).toBe(true);
    expect(featureOn(null, "self_service")).toBe(false);
  });
});
