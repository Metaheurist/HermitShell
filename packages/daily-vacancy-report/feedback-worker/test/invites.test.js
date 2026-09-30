import { describe, expect, it } from "vitest";
import { createInvite, openInvites } from "../src/join.js";
import { testEnv } from "./helpers.js";

function counting(env) {
  const reads = [];
  const get = env.FEEDBACK.get;
  env.FEEDBACK.get = (key, type) => { reads.push(key); return get(key, type); };
  return reads;
}

describe("open invites", () => {
  it("come from one list, with no read per invite", async () => {
    const env = testEnv();
    const one = await createInvite(env, "Careers fair", "casey");
    const two = await createInvite(env, "Referral from Jamie Walsh");
    const reads = counting(env);
    const open = await openInvites(env);
    expect(open.map((i) => i.id).sort()).toEqual([one.id, two.id].sort());
    expect(open.find((i) => i.id === one.id)).toEqual(one);
    expect(reads).toEqual([]);
  });

  it("still include invites made before they carried themselves as metadata", async () => {
    const env = testEnv();
    const old = { id: "a".repeat(32), note: "Older invite", created: Date.now(), expires: Date.now() + 86400000 };
    await env.FEEDBACK.put(`invite:${old.id}`, JSON.stringify(old));
    const reads = counting(env);
    expect(await openInvites(env)).toEqual([old]);
    expect(reads).toEqual([`invite:${old.id}`]);
  });

  it("leave out an expired invite KV has not dropped yet, unless asked for everything", async () => {
    const env = testEnv();
    const invite = await createInvite(env, "Expiring");
    expect(await openInvites(env, invite.expires + 1)).toEqual([]);
    expect(await openInvites(env, 0)).toEqual([invite]);
  });
});
