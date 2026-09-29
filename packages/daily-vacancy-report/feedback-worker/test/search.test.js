import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { MAX_QUERY, matchesProfile, searchQuery } from "../src/search.js";
import { BASE, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const PROFILES = [
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, has_cv: true, provider: "firecrawl",
    details: { location: "Salford" } },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, provider: "tavily", scanning: 1,
    details: { location: "York" } },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "paused", has_cv: false, provider: "",
    details: { location: "Leeds" } },
];

async function setup(profiles = PROFILES) {
  const env = testEnv(ADMIN);
  await worker.fetch(new Request(`${BASE}/api/status`, { method: "POST", headers: API, body: JSON.stringify({ profiles }) }), env);
  const res = await worker.fetch(new Request(`${BASE}/admin/login`, { method: "POST",
    body: new URLSearchParams({ username: "admin", password: ADMIN.ADMIN_PASSWORD }), headers: { "CF-Connecting-IP": "203.0.113.9" } }), env);
  const cookie = (res.headers.get("Set-Cookie") || "").split(";")[0];
  return async (query = "") => (await worker.fetch(new Request(`${BASE}/admin${query}`, { headers: { Cookie: cookie } }), env)).text();
}

const listed = (body) => PROFILES.map((p) => p.id).filter((id) => body.includes(`/admin/profile?u=${id}"`));

describe("profile search", () => {
  it("shows the search button and the number of profiles", async () => {
    const body = await (await setup())();
    expect(body).toContain('<label for="profile-search" class="searchbtn" title="Search profiles">');
    expect(body).toContain('<form class="search" method="get" action="/admin" role="search">');
    expect(body).toContain('<span class="count">3 profiles</span>');
    expect(body).toContain("form.search:focus-within #profile-search");
    expect(listed(body)).toEqual(["owner", "sam-lee", "jordan-patel"]);
  });

  it("lists only the profiles whose details contain every word, whatever the case", async () => {
    const get = await setup();
    expect(listed(await get("?q=sam"))).toEqual(["sam-lee"]);
    expect(listed(await get("?q=LEEDS"))).toEqual(["jordan-patel"]);
    expect(listed(await get("?q=paused"))).toEqual(["jordan-patel"]);
    expect(listed(await get("?q=active+lee"))).toEqual(["sam-lee"]);
    expect(listed(await get("?q=contoso"))).toEqual(["jordan-patel"]);
    expect(listed(await get("?q=owner"))).toEqual(["owner"]);
    const some = await get("?q=example.com");
    expect(listed(some)).toEqual(["owner", "sam-lee"]);
    expect(some).toContain('<span class="count">2 of 3 profiles</span>');
    expect(some).toContain('<form class="search open"');
    expect(some).toContain('value="example.com"');
    expect(some).toContain('<a class="clear" href="/admin"');
  });

  it("only renders key modals for the profiles listed", async () => {
    const body = await (await setup())("?q=sam");
    expect(body).toContain('id="key-sam-lee"');
    expect(body).not.toContain('id="key-owner"');
  });

  it("says when nothing matches and links back to everyone", async () => {
    const body = await (await setup())("?q=nobody");
    expect(listed(body)).toEqual([]);
    expect(body).toContain("No profile matches &ldquo;nobody&rdquo;");
    expect(body).toContain('<a href="/admin">Show everyone</a>');
  });

  it("hides the search until HermitShell has reported profiles", async () => {
    const body = await (await setup([]))();
    expect(body).not.toContain('class="searchbtn"');
    expect(body).toContain("HermitShell has not reported any profiles yet.");
  });

  it("tidies the query and matches on the words alone", () => {
    expect(searchQuery(new URL(`${BASE}/admin?q=${encodeURIComponent("  sam \n\t lee ")}`))).toBe("sam lee");
    expect(searchQuery(new URL(`${BASE}/admin?q=${"x".repeat(200)}`))).toHaveLength(MAX_QUERY);
    expect(searchQuery(new URL(`${BASE}/admin`))).toBe("");
    expect(matchesProfile(PROFILES[2], "no cv")).toBe(true);
    expect(matchesProfile(PROFILES[1], "scanning york")).toBe(true);
    expect(matchesProfile({ id: "x" }, "")).toBe(true);
    expect(matchesProfile({ id: "x" }, "y")).toBe(false);
  });
});
