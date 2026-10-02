import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { MAX_QUERY, matchesProfile, matchesStatus, searchQuery, statusQuery } from "../src/search.js";
import { BASE, styled, testEnv } from "./helpers.js";

const ADMIN = { ADMIN_PASSWORD: "correct horse battery" };
const API = { Authorization: "Bearer api-token" };
const PROFILES = [
  { id: "riley-chen", name: "Riley Chen", email: "riley@example.com", status: "active", has_cv: true,
    details: { location: "Salford" } },
  { id: "sam-lee", name: "Sam Lee", email: "sam@example.com", status: "active", has_cv: true, scanning: 1,
    details: { location: "York" } },
  { id: "jordan-patel", name: "Jordan Patel", email: "jordan@contoso.example", status: "paused", has_cv: false,
    details: { location: "Leeds" } },
  { id: "owner", name: "Alex Morgan", email: "alex@example.com", status: "active", owner: true, recruiter: "", has_cv: false, recruit: "" },
];

const RECRUITER = { id: "casey", name: "Casey Quinn", roles: ["recruiter"], salt: "00".repeat(16), hash: "00".repeat(32), iter: 1000, v: "v1" };

async function setup(profiles = PROFILES, accounts = null) {
  const env = testEnv(ADMIN);
  if (accounts) await env.FEEDBACK.put("accounts", JSON.stringify(accounts));
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
    expect(body).toContain('<label for="profile-search" class="searchbtn" title="Search recruits">');
    expect(body).toContain('<form class="search" method="get" action="/admin" role="search">');
    expect(body).toContain('<span class="count">3 recruits</span>');
    expect(body).toContain("form.search:focus-within #profile-search");
    expect(listed(body)).toEqual(["riley-chen", "sam-lee", "jordan-patel"]);
  });

  it("lists only the profiles whose details contain every word, whatever the case", async () => {
    const get = await setup();
    expect(listed(await get("?q=sam"))).toEqual(["sam-lee"]);
    expect(listed(await get("?q=LEEDS"))).toEqual(["jordan-patel"]);
    expect(listed(await get("?q=sam+lee"))).toEqual(["sam-lee"]);
    expect(listed(await get("?q=contoso"))).toEqual(["jordan-patel"]);
    expect(listed(await get("?q=owner"))).toEqual([]);
    expect(listed(await get("?q=alex+morgan"))).toEqual([]);
    const some = await get("?q=example.com");
    expect(listed(some)).toEqual(["riley-chen", "sam-lee"]);
    expect(some).toContain('<span class="count">2 of 3 recruits</span>');
    expect(some).toContain('<form class="search open"');
    expect(some).toContain('value="example.com"');
    expect(some).toContain('<a class="clear" href="/admin"');
  });

  it("picks the status from a dropdown beside the search, not from the words typed", async () => {
    const get = await setup();
    const board = await get();
    expect(board).toContain('<select id="status-filter" name="s" aria-label="Status"><option value="" selected>Any status</option>'
      + '<option value="active">Active</option><option value="paused">Paused</option><option value="scanning">Scanning now</option>'
      + '<option value="nocv">No CV</option><option value="pending">Pending sign-up</option><option value="retired">Retired</option></select><button class="sgo">Show</button>');
    expect(board).toContain('placeholder="Name, email, place, recruiter or tag, then Enter"');
    for (const word of ["paused", "active", "scanning", "no+cv"]) expect(listed(await get(`?q=${word}`))).toEqual([]);
    expect(listed(await get("?s=paused"))).toEqual(["jordan-patel"]);
    expect(listed(await get("?s=active"))).toEqual(["riley-chen", "sam-lee"]);
    expect(listed(await get("?s=scanning"))).toEqual(["sam-lee"]);
    expect(listed(await get("?s=nocv"))).toEqual(["jordan-patel"]);
    expect(listed(await get("?s=pending"))).toEqual([]);
    const both = await get("?s=active&q=york");
    expect(listed(both)).toEqual(["sam-lee"]);
    expect(both).toContain('<option value="active" selected>Active</option>');
    expect(both).toContain('<form class="search open"');
    expect(both).toContain('<span class="count">1 of 3 recruits</span>');
    const alone = await get("?s=paused&q=");
    expect(alone).toContain('<form class="search open"');
    expect(alone).toContain('<a class="clear" href="/admin"');
    const none = await get("?s=paused&q=york");
    expect(listed(none)).toEqual([]);
    expect(none).toContain("No recruit matches &ldquo;york&rdquo; and paused");
    expect(await get("?s=pending")).toContain("No recruit matches pending sign-up");
  });

  it("ignores a status it doesn't know and never echoes it", async () => {
    const get = await setup();
    for (const s of ["bogus", "toString", "__proto__", "constructor", "<script>alert(1)</script>", "ACTIVE"]) {
      const body = await get(`?s=${encodeURIComponent(s)}`);
      expect(listed(body)).toEqual(["riley-chen", "sam-lee", "jordan-patel"]);
      expect(body).toContain('<option value="" selected>Any status</option>');
      expect(body).toContain('<form class="search" method="get"');
      expect(body).not.toContain("<script>alert(1)</script>");
    }
    expect(statusQuery(new URL(`${BASE}/admin?s=nocv`))).toBe("nocv");
    expect(statusQuery(new URL(`${BASE}/admin?s=hasOwnProperty`))).toBe("");
  });

  it("shows a pending sign-up under Pending sign-up only", () => {
    const signup = { pending: true, id: "", name: "Riley Chen", email: "riley@example.com" };
    expect(matchesStatus(signup, "pending")).toBe(true);
    for (const s of ["active", "paused", "scanning", "nocv"]) expect(matchesStatus(signup, s)).toBe(false);
    expect(matchesStatus(PROFILES[0], "pending")).toBe(false);
    expect(matchesStatus(PROFILES[0], "")).toBe(true);
  });

  it("lists a recruiter first, followed by all of their recruits, when the search names the recruiter", async () => {
    const pooled = PROFILES.map((p) => (p.owner ? p : { ...p, recruiter: "casey" }));
    const get = await setup(pooled, { users: [RECRUITER] });
    const body = await get("?q=casey+quinn");
    expect(listed(body)).toEqual(["riley-chen", "sam-lee", "jordan-patel"]);
    expect(body.indexOf('class="recrow"')).toBeGreaterThan(-1);
    expect(body.indexOf('class="recrow"')).toBeLessThan(body.indexOf("/admin/profile?u=riley-chen"));
    expect(body).toContain("<b>Casey Quinn</b> <span class=\"role recruiter\">Recruiter</span>");
    expect(body).toContain("<code>casey</code> &middot; 3 recruits");
    expect(body.match(/<tr class="inpool">/g)).toHaveLength(3);
    expect(body).toContain('<span class="count">3 of 3 recruits</span>');
  });

  it("finds a recruit by their recruiter and their own details together, still under the recruiter", async () => {
    const pooled = PROFILES.map((p) => (p.owner ? p : { ...p, recruiter: "casey" }));
    const get = await setup(pooled, { users: [RECRUITER] });
    const body = await get("?q=casey+jordan");
    expect(listed(body)).toEqual(["jordan-patel"]);
    expect(body).toContain('class="recrow"');
    expect(body.indexOf('class="recrow"')).toBeLessThan(body.indexOf("/admin/profile?u=jordan-patel"));
    const plain = await get("?q=york");
    expect(listed(plain)).toEqual(["sam-lee"]);
    expect(plain).not.toContain('class="recrow"');
  });

  it("says when nothing matches and links back to everyone", async () => {
    const body = await (await setup())("?q=nobody");
    expect(listed(body)).toEqual([]);
    expect(body).toContain("No recruit matches &ldquo;nobody&rdquo;");
    expect(body).toContain('<a href="/admin">Show everyone</a>');
  });

  it("hides the search until HermitShell has reported profiles", async () => {
    const body = await (await setup([]))();
    expect(body).not.toContain('class="searchbtn"');
    expect(body).toContain("HermitShell has not reported any recruits yet.");
  });

  it("calls the people on the dashboard recruits, on every admin page that names them", async () => {
    const get = await setup();
    const board = await get();
    expect(board).toContain("<title>Recruits</title>");
    expect(board).toContain('<a href="/admin" class="on" aria-current="page">Recruits</a>');
    expect(board).toContain("<th>Recruit</th><th>Status</th>");
    const manage = await get("/profile?u=sam-lee");
    expect(manage).toContain("Back to recruits</a>");
    expect(manage).toContain('class="on" aria-current="page">Manage</a>');
    expect(await get("/stats?u=sam-lee")).toContain("Manage recruit</a>");
    const missing = await get("/profile?u=nobody");
    expect(missing).toContain("<title>Recruit not found</title>");
    expect(missing).toContain("Back to recruits</a>");
    for (const page of [board, manage, missing]) expect(page).not.toMatch(/>\s*(Back to )?[Pp]rofiles\s*</);
  });

  it("widens the recruits card to the screen and stacks each row on narrow screens", async () => {
    const get = await setup();
    const board = styled(await get());
    expect(board).toContain('<main class="wide full">');
    expect(board).toContain('<table class="list stack recruits"><tr class="head"><th>Recruit</th>');
    expect(board).toContain("main.full{max-width:min(1320px,calc(100vw - 48px))}");
    expect(board).toContain("@media (max-width:900px){table.list.stack,table.list.stack tbody{display:block}table.list.stack tr.head{display:none}");
    expect(board).toContain("table.recruits .rowacts{justify-content:flex-start;flex-wrap:wrap}");
    expect(board).toContain("@media (max-width:1860px){body:has(main.full) .me{position:absolute");
    expect(board.match(/<div class="me"/g)).toHaveLength(1);
    expect(await get("/profile?u=sam-lee")).toContain('<main class="wide">');
  });

  it("tidies the query and matches on the words alone", () => {
    expect(searchQuery(new URL(`${BASE}/admin?q=${encodeURIComponent("  sam \n\t lee ")}`))).toBe("sam lee");
    expect(searchQuery(new URL(`${BASE}/admin?q=${"x".repeat(200)}`))).toHaveLength(MAX_QUERY);
    expect(searchQuery(new URL(`${BASE}/admin`))).toBe("");
    expect(matchesProfile(PROFILES[2], "no cv")).toBe(false);
    expect(matchesProfile(PROFILES[1], "scanning york")).toBe(false);
    expect(matchesProfile(PROFILES[2], "paused")).toBe(false);
    expect(matchesProfile(PROFILES[1], "york")).toBe(true);
    expect(matchesProfile({ ...PROFILES[1], tags: ["shortlist"] }, "shortlist")).toBe(true);
    expect(matchesProfile({ id: "x" }, "")).toBe(true);
    expect(matchesProfile({ id: "x" }, "y")).toBe(false);
    expect(matchesProfile(PROFILES[1], "tavily")).toBe(false);
    expect(matchesProfile(PROFILES[1], "casey york", { id: "casey", name: "Casey Quinn" })).toBe(true);
    expect(matchesProfile(PROFILES[1], "quinn", null)).toBe(false);
  });
});
