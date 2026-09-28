"""Indeed job source for the Daily Vacancy Report, via the Indeed MCP server connected to Hermes.

Hermes owns the OAuth tokens (authorise once with ``hermes mcp login indeed`` or from the
dashboard's MCP page). This module reuses Hermes' OAuth provider so token refreshes stay
coordinated with the gateway; it never reads or stores credentials itself.

Tool names and argument names are discovered from the server's tool list, so small changes
on Indeed's side (renamed arguments, extra optional fields) don't need a code change.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from contextlib import asynccontextmanager, nullcontext
from pathlib import Path

from hermes_common import HERMES_HOME, env, html_to_text, log

QUERY_ARGS = ("query", "keywords", "keyword", "q", "search", "search_query", "searchQuery", "what",
              "title", "job_title", "jobTitle")
LOCATION_ARGS = ("location", "where", "l", "city", "loc")
LIMIT_ARGS = ("limit", "max_results", "maxResults", "num_results", "numResults", "count", "page_size",
              "pageSize", "size", "per_page")
COUNTRY_ARGS = ("country", "country_code", "countryCode", "co")
DAYS_ARGS = ("fromage", "days", "days_ago", "daysAgo", "max_age_days", "posted_within_days")
JOB_ID_ARGS = ("job_id", "jobId", "id", "job_key", "jobKey", "jobkey", "jk")

TITLE_KEYS = ("title", "jobTitle", "job_title", "displayTitle", "name", "positionTitle")
COMPANY_KEYS = ("company", "companyName", "company_name", "employer", "employerName", "hiringOrganization")
LOCATION_KEYS = ("location", "formattedLocation", "jobLocation", "job_location", "locationName", "city")
URL_KEYS = ("url", "jobUrl", "job_url", "viewJobUrl", "view_job_url", "link", "applyUrl", "apply_url",
            "applicationUrl", "application_url")
ID_KEYS = ("jobKey", "job_key", "jobkey", "jk", "jobId", "job_id", "id", "key")
SALARY_KEYS = ("salary", "salarySnippet", "salary_snippet", "compensation", "pay", "salaryText",
               "estimatedSalary", "baseSalary")
SNIPPET_KEYS = ("snippet", "summary", "shortDescription", "short_description", "description")
DESCRIPTION_KEYS = ("description", "jobDescription", "job_description", "fullDescription", "descriptionText",
                    "description_text", "text", "details", "content")
TYPE_KEYS = ("jobType", "job_type", "jobTypes", "employmentType", "employment_type", "type", "contractType")
DATE_KEYS = ("datePosted", "date_posted", "postedAt", "posted", "pubDate", "formattedRelativeTime", "date")
NAME_KEYS = ("name", "text", "formatted", "display", "displayName", "label", "value")


def _flat(value) -> str:
    """Render a scalar / nested field (e.g. {"name": ...} or a list of job types) as one line."""
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (str, int, float)):
        return re.sub(r"\s+", " ", str(value)).strip()
    if isinstance(value, dict):
        for k in NAME_KEYS:
            if value.get(k):
                return _flat(value[k])
        parts = [_flat(v) for v in value.values() if isinstance(v, (str, int, float)) and v]
        return ", ".join(dict.fromkeys(p for p in parts if p))
    if isinstance(value, list):
        return ", ".join(dict.fromkeys(p for p in (_flat(v) for v in value) if p))
    return ""


def _pick(data: dict, keys: tuple[str, ...]) -> str:
    for k in keys:
        text = _flat(data.get(k))
        if text:
            return text
    return ""


def _find_jobs(obj, depth: int = 0) -> list[dict]:
    """The first list of job-like dicts anywhere in a tool payload."""
    if depth > 4:
        return []
    if isinstance(obj, list):
        items = [o for o in obj if isinstance(o, dict)]
        if items and any(_pick(o, TITLE_KEYS) for o in items):
            return items
        for o in items:
            found = _find_jobs(o, depth + 1)
            if found:
                return found
    elif isinstance(obj, dict):
        for k in ("jobs", "results", "data", "items", "hits", "jobResults", "job_results", "postings"):
            if k in obj:
                found = _find_jobs(obj[k], depth + 1)
                if found:
                    return found
        for v in obj.values():
            if isinstance(v, (list, dict)):
                found = _find_jobs(v, depth + 1)
                if found:
                    return found
    return []


MD_JOB_LINK = re.compile(r"\[([^\]]{3,140})\]\((https?://[^)\s]*indeed\.[^)\s]*)\)")
JK_RE = re.compile(r"[?&](?:jk|vjk)=([0-9a-f]{8,})", re.I)


class IndeedMCP:
    """Search and fetch Indeed jobs through Hermes' authorised MCP connection."""

    def __init__(self, server: str | None = None):
        self.server = server or env("JOB_INDEED_MCP_SERVER", "indeed")
        self.domain = env("JOB_INDEED_DOMAIN", "www.indeed.com")
        self.timeout = float(env("JOB_INDEED_TIMEOUT", "90"))
        self.url, self.config = self._server_config()
        self.error = "" if self.url else f"MCP server '{self.server}' not found in config.yaml"
        self.calls = 0

    # ------------------------------------------------------------------ plumbing

    def _server_config(self) -> tuple[str, dict]:
        config: dict = {}
        try:
            import yaml
            data = yaml.safe_load((HERMES_HOME / "config.yaml").read_text(encoding="utf-8")) or {}
            config = (data.get("mcp_servers") or {}).get(self.server) or {}
        except (OSError, ImportError, ValueError) as exc:
            log(f"Indeed MCP: could not read config.yaml ({exc})")
        if config.get("enabled") is False:
            return "", {}
        return env("JOB_INDEED_MCP_URL") or config.get("url") or "", config

    @staticmethod
    def _hermes_path() -> None:
        agent_dir = env("HERMES_AGENT_DIR", "/opt/hermes")
        if Path(agent_dir).is_dir() and agent_dir not in sys.path:
            sys.path.append(agent_dir)

    def _auth(self):
        if str(self.config.get("auth", "")).lower() != "oauth":
            return None
        from tools.mcp_oauth_manager import get_manager
        return get_manager().get_or_build_provider(self.server, self.url, self.config.get("oauth"))

    @asynccontextmanager
    async def _session(self):
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        from tools.mcp_tool import sdk_httpx
        httpx = sdk_httpx()
        headers = {k: str(v) for k, v in (self.config.get("headers") or {}).items()}
        async with httpx.AsyncClient(auth=self._auth(), headers=headers or None, follow_redirects=True,
                                     timeout=httpx.Timeout(30.0, read=120.0)) as client:
            async with streamable_http_client(self.url, http_client=client) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    await session.initialize()
                    yield session

    def _run(self, work):
        """Open one MCP session, run ``work(session, tools)`` and close; errors are logged, not raised."""
        if self.error:
            return None
        self._hermes_path()

        async def go():
            async with self._session() as session:
                listed = await session.list_tools()
                tools = {t.name: t for t in listed.tools}
                return await work(session, tools)

        try:
            from tools.mcp_oauth import suppress_interactive_oauth
            guard = suppress_interactive_oauth()
        except ImportError as exc:
            self.error = f"Hermes MCP modules unavailable ({exc}); run inside the hermes-agent container"
            log(f"Indeed MCP: {self.error}")
            return None
        try:
            with guard if hasattr(guard, "__enter__") else nullcontext():
                return asyncio.run(asyncio.wait_for(go(), self.timeout))
        except Exception as exc:  # noqa: BLE001 - a missing source must never break the report
            self.error = self._describe(exc)
            log(f"Indeed MCP: {self.error}")
            return None

    def _describe(self, exc: BaseException) -> str:
        leaves, stack = [], [exc]
        while stack:
            e = stack.pop()
            subs = getattr(e, "exceptions", None)
            if subs:
                stack.extend(subs)
            else:
                leaves.append(e)
        for e in leaves:
            if type(e).__name__ == "OAuthNonInteractiveError" or "no cached tokens" in str(e).lower():
                return (f"not authorised yet; run `hermes mcp login {self.server}` (or authorise it on the "
                        "Hermes dashboard MCP page) and try again")
        e = leaves[0] if leaves else exc
        if isinstance(e, (asyncio.TimeoutError, TimeoutError)):
            return f"timed out after {self.timeout:.0f}s"
        return f"{type(e).__name__}: {str(e)[:200]}"

    # ------------------------------------------------------------------ tool selection / arguments

    @staticmethod
    def _choose(tools: dict, override: str, include: str, exclude: str = "") -> str | None:
        if override:
            return override if override in tools else None
        for name in tools:
            if re.search(include, name, re.I) and not (exclude and re.search(exclude, name, re.I)):
                return name
        return None

    @staticmethod
    def _props(tool) -> tuple[dict, list]:
        schema = getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None) or {}
        return schema.get("properties") or {}, schema.get("required") or []

    @staticmethod
    def _arg(props: dict, candidates: tuple[str, ...]) -> str | None:
        lowered = {p.lower(): p for p in props}
        for c in candidates:
            if c.lower() in lowered:
                return lowered[c.lower()]
        return None

    def _search_args(self, tool, query: str, location: str, limit: int, country: str, days: int) -> dict:
        props, required = self._props(tool)
        args: dict = {}
        q = self._arg(props, QUERY_ARGS) or next(
            (p for p in required if props.get(p, {}).get("type") == "string"), None)
        if q:
            args[q] = query
        for names, value in ((LOCATION_ARGS, location), (COUNTRY_ARGS, country)):
            key = self._arg(props, names)
            if key and value:
                args[key] = value
        for names, value in ((LIMIT_ARGS, limit), (DAYS_ARGS, days)):
            key = self._arg(props, names)
            if key and value:
                args[key] = value if props[key].get("type") in ("integer", "number") else str(value)
        return args

    # ------------------------------------------------------------------ payloads

    @staticmethod
    def _payload(result):
        if getattr(result, "is_error", False) or getattr(result, "isError", False):
            text = " ".join(getattr(c, "text", "") for c in result.content)
            raise RuntimeError(f"tool error: {text[:200]}")
        structured = getattr(result, "structured_content", None) or getattr(result, "structuredContent", None)
        if structured:
            return structured
        texts = [c.text for c in result.content if getattr(c, "text", None)]
        for chunk in ["\n".join(texts), *texts]:
            try:
                return json.loads(chunk)
            except ValueError:
                continue
        return "\n\n".join(texts)

    def _normalise(self, item: dict) -> dict | None:
        title = _pick(item, TITLE_KEYS)
        if not title:
            return None
        url = _pick(item, URL_KEYS)
        job_id = _pick(item, ID_KEYS)
        if not job_id and url:
            m = JK_RE.search(url)
            job_id = m.group(1) if m else ""
        if job_id and not url.startswith("http"):
            url = f"https://{self.domain}/viewjob?jk={job_id}"
        if not url:
            return None
        snippet = _pick(item, SNIPPET_KEYS)
        posted = _pick(item, DATE_KEYS)
        if re.match(r"\d{4}-\d{2}-\d{2}T", posted):
            posted = posted[:10]
        return {"title": title, "url": url, "job_id": job_id, "company": _pick(item, COMPANY_KEYS),
                "location": _pick(item, LOCATION_KEYS), "salary": _pick(item, SALARY_KEYS),
                "type_line": _pick(item, TYPE_KEYS),
                "published": posted if not posted or posted.lower().startswith("posted") else f"Posted {posted}",
                "snippet": html_to_text(snippet) if "<" in snippet else snippet}

    def _jobs_from(self, payload) -> list[dict]:
        if isinstance(payload, str):
            jobs = []
            for title, url in MD_JOB_LINK.findall(payload):
                m = JK_RE.search(url)
                jobs.append({"title": title.strip(), "url": url, "job_id": m.group(1) if m else "",
                             "company": "", "location": "", "salary": "", "type_line": "",
                             "published": "", "snippet": ""})
            return jobs
        return [j for j in (self._normalise(i) for i in _find_jobs(payload)) if j]

    # ------------------------------------------------------------------ public API

    def search(self, queries: list[str], location: str, limit: int = 15, country: str = "",
               days: int = 0) -> list[dict]:
        """Run every query in one session; returns normalised job dicts (deduplicated)."""
        async def work(session, tools):
            override = env("JOB_INDEED_SEARCH_TOOL", "")
            name = (self._choose(tools, override, r"search.*job|job.*search")
                    or self._choose(tools, override, r"search", r"company|resume"))
            if not name:
                raise RuntimeError(f"no search tool among {sorted(tools)}")
            found: dict[str, dict] = {}
            for query in queries:
                args = self._search_args(tools[name], query, location, limit, country, days)
                self.calls += 1
                try:
                    jobs = self._jobs_from(self._payload(await session.call_tool(name, args)))
                except RuntimeError as exc:
                    log(f"indeed '{query}': {exc}")
                    continue
                new = 0
                for job in jobs:
                    key = job["job_id"] or job["url"]
                    if key not in found:
                        found[key] = job
                        new += 1
                log(f"indeed '{query}' in {location or 'any location'}: {len(jobs)} postings, {new} new")
            return list(found.values())

        return self._run(work) or []

    def details(self, jobs: list[dict]) -> dict[str, tuple[dict, str]]:
        """Full descriptions for jobs from :meth:`search`, keyed by job_id: {id: (facts, text)}."""
        wanted = [j for j in jobs if j.get("job_id")]
        if not wanted:
            return {}

        async def work(session, tools):
            name = self._choose(tools, env("JOB_INDEED_DETAIL_TOOL", ""), r"job.*(detail|get)|get.*job|detail",
                                r"search|resume|company")
            if not name:
                log(f"Indeed MCP: no job-detail tool among {sorted(tools)}; using search snippets")
                return {}
            props, required = self._props(tools[name])
            id_arg = self._arg(props, JOB_ID_ARGS) or (required[0] if required else None)
            if not id_arg:
                return {}
            out: dict[str, tuple[dict, str]] = {}
            for job in wanted:
                self.calls += 1
                try:
                    payload = self._payload(await session.call_tool(name, {id_arg: job["job_id"]}))
                except RuntimeError as exc:
                    log(f"indeed detail {job['job_id']}: {exc}")
                    continue
                out[job["job_id"]] = self._detail(payload, job)
            return out

        return self._run(work) or {}

    def _detail(self, payload, job: dict) -> tuple[dict, str]:
        if isinstance(payload, str):
            return {}, f"# {job['title']}\n\n{payload.strip()}"
        data = payload
        if isinstance(data, dict):
            for k in ("job", "jobDetails", "job_details", "result", "data"):
                if isinstance(data.get(k), dict):
                    data = data[k]
                    break
        if not isinstance(data, dict):
            return {}, ""
        info = self._normalise({"title": job["title"], "url": job["url"], **data}) or {}
        facts = {k: info[k] for k in ("company", "location", "salary", "type_line", "published") if info.get(k)}
        description = _pick(data, DESCRIPTION_KEYS)
        if "<" in description:
            description = html_to_text(description)
        extra = [f"{label}: {_flat(data[k])}" for label, k in
                 (("Requirements", "requirements"), ("Qualifications", "qualifications"),
                  ("Benefits", "benefits")) if data.get(k)]
        text = "\n\n".join(p for p in [f"# {job['title']}", description, *extra] if p)
        return facts, text if description else ""
