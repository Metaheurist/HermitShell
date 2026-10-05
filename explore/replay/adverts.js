// The fictional job adverts replay-search serves in place of real search results. Every company, address and person
// here is made up (Northwind, Contoso, Fabrikam, Proseware, Litware), so recordings made against them can be published.
// The closing date is always three weeks from today, so an advert never goes stale; prompts tokenise dates anyway.

const DAY = 86400000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

export function closing(now = Date.now()) {
  const d = new Date(now + 21 * DAY);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const A = (id, company, host, title, location, salary, mode, body, skills) => ({
  id, company, title, location, salary, mode, skills,
  url: `https://careers.${host}.example/vacancies/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id}`,
  body,
});

export const ADVERTS = [
  A(1001, "Northwind Traders", "northwind", "Senior Data Analyst", "York, North Yorkshire", "£45,000 - £52,000", "Hybrid",
    "Northwind Traders runs 120 stores across the north of England. Our insight team turns sales, stock and staffing data "
    + "into the reports store and regional managers use every morning. You will own the weekly trading pack, build Power "
    + "BI dashboards on a governed semantic model, and work with finance on month-end reporting.",
    ["SQL", "Power BI", "DAX", "Python", "dbt", "stakeholder management", "data quality"]),
  A(1002, "Contoso Logistics", "contoso", "Analytics Engineer", "Leeds, West Yorkshire", "£50,000 - £58,000", "Hybrid",
    "Contoso Logistics moves 40,000 parcels a day. Our analytics engineers build the dbt models behind every dashboard, "
    + "write tests that catch late or missing feeds, and keep the warehouse tidy. You will model delivery, route and "
    + "carrier data, review pull requests and mentor two analysts moving into engineering.",
    ["dbt", "SQL", "Snowflake", "Python", "Git", "data modelling", "Airflow"]),
  A(1003, "Fabrikam Payments", "fabrikam", "BI Developer", "Harrogate, North Yorkshire", "£42,000 - £48,000", "On-site",
    "Fabrikam's finance systems team needs a BI developer to rebuild our reporting on SQL Server and Power BI. You will "
    + "gather requirements from finance and risk, design star schemas and automate the board pack. Experience with SSIS "
    + "or Azure Data Factory is useful.",
    ["SQL Server", "Power BI", "SSIS", "Azure Data Factory", "DAX", "data warehousing"]),
  A(1004, "Proseware", "proseware", "Data Analyst", "York, North Yorkshire", "£34,000 - £38,000", "Hybrid",
    "Proseware builds timetabling software for 900 schools. As a data analyst you will answer product questions with SQL "
    + "and Python, build Looker Studio dashboards for the customer success team and run A/B test analysis.",
    ["SQL", "Python", "pandas", "Looker Studio", "A/B testing", "Excel"]),
  A(1005, "Litware Retail", "litware", "Power BI Analyst", "Leeds, West Yorkshire", "£38,000 - £44,000", "Remote",
    "Litware Retail is replacing spreadsheet reporting with Power BI. You will build and support dashboards for buying, "
    + "merchandising and stores, write DAX measures, and train business users. A retail background is a plus.",
    ["Power BI", "DAX", "SQL", "Excel", "training", "retail analytics"]),
  A(2001, "Fabrikam Payments", "fabrikam", "Senior Backend Engineer (Python)", "Manchester", "£65,000 - £75,000", "Hybrid",
    "Fabrikam Payments authorises card payments for 3,000 merchants. Our platform team designs and runs FastAPI services "
    + "on Kubernetes with PostgreSQL and Redis, with Kafka between them. You will own services end to end, from design "
    + "to on-call, improve observability and mentor engineers.",
    ["Python", "FastAPI", "PostgreSQL", "Redis", "Kafka", "Kubernetes", "observability"]),
  A(2002, "Proseware", "proseware", "Data Engineer", "Salford, Greater Manchester", "£55,000 - £62,000", "Hybrid",
    "Proseware's data platform team builds the pipelines behind our product analytics. You will write Airflow DAGs in "
    + "Python, model data in PostgreSQL and BigQuery, and add tests and alerting so failures page the right team.",
    ["Python", "Airflow", "PostgreSQL", "BigQuery", "Terraform", "data pipelines"]),
  A(2003, "Contoso Logistics", "contoso", "Platform Engineer", "Stockport, Greater Manchester", "£60,000 - £68,000", "Remote",
    "Contoso is moving its routing services to containers. As a platform engineer you will build CI/CD with GitHub "
    + "Actions, run Kubernetes on AWS with Terraform and help teams adopt good observability practice.",
    ["Kubernetes", "Terraform", "AWS", "GitHub Actions", "Docker", "Prometheus"]),
  A(2004, "Northwind Traders", "northwind", "Python Developer", "Manchester", "£50,000 - £58,000", "Hybrid",
    "Northwind's e-commerce team needs a Python developer for our Django order service. You will build APIs, improve "
    + "test coverage and work with the data team on event streams.",
    ["Python", "Django", "PostgreSQL", "REST APIs", "pytest", "Celery"]),
  A(3001, "Litware Retail", "litware", "Digital Marketing Executive", "Leeds, West Yorkshire", "£30,000 - £34,000", "Hybrid",
    "Litware Retail's marketing team runs email, paid social and search for 60 stores. You will plan and run campaigns "
    + "end to end, report on performance in GA4 and Looker Studio, and manage a monthly paid social budget with our agency.",
    ["Google Analytics 4", "Looker Studio", "Mailchimp", "Meta Ads", "campaign planning", "copywriting"]),
  A(3002, "Contoso College", "contoso", "Marketing Analyst", "Bradford, West Yorkshire", "£32,000 - £36,000", "Hybrid",
    "Contoso College wants a marketing analyst to measure what brings students to open days. You will build dashboards, "
    + "run segmentation and A/B tests on email, and present findings to the marketing and admissions teams.",
    ["Google Analytics 4", "SQL", "Excel", "A/B testing", "HubSpot", "segmentation"]),
  A(3003, "Proseware", "proseware", "CRM and Email Marketing Executive", "Wakefield, West Yorkshire", "£29,000 - £33,000",
    "On-site",
    "Proseware's customer marketing team needs someone to run our HubSpot email programme: newsletters, onboarding "
    + "journeys and product announcements, with clean segments and monthly reporting.",
    ["HubSpot", "email marketing", "segmentation", "copywriting", "reporting", "Canva"]),
];

export function markdown(ad, now = Date.now()) {
  return [
    `# ${ad.title}`,
    "",
    `**${ad.company}** · ${ad.location} · ${ad.mode} · Permanent, full-time`,
    "",
    `Salary: ${ad.salary} per year`,
    `Closing date: ${closing(now)}`,
    "",
    "## About the role",
    ad.body,
    "",
    "## What you'll bring",
    ...ad.skills.map((s) => `- ${s}`),
    "- Clear written and spoken communication, and care for the people who use your work",
    "",
    "## What we offer",
    "- 25 days' holiday plus bank holidays, and a day off for your birthday",
    "- Pension matched up to 6%, private healthcare and a learning budget of £1,000 a year",
    "- Two days a week in the office for hybrid roles; flexible hours around core time",
    "",
    `To apply, send your CV through our careers site. ${ad.company} is an equal opportunities employer.`,
    "This advert is fictional and exists only for the HermitShell demo.",
  ].join("\n");
}

export function snippet(ad) {
  return `${ad.company} is hiring a ${ad.title} in ${ad.location} (${ad.mode}, ${ad.salary}). ${ad.body.slice(0, 140)}...`;
}

// The adverts a search query is about: its quoted phrases against titles and locations, best first.
export function matching(query, limit = 8) {
  const q = String(query || "").toLowerCase();
  if (/official website|homepage/.test(q)) return [];
  const phrases = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  const words = new Set(q.replace(/"[^"]*"/g, " ").split(/[^a-z0-9+#]+/).filter((w) => w.length > 2));
  const scored = ADVERTS.map((ad) => {
    const title = ad.title.toLowerCase();
    const place = ad.location.toLowerCase();
    let byTitle = 0;
    let byPlace = 0;
    for (const p of phrases) {
      const parts = p.split(/\s+/).filter((w) => w.length > 2);
      if (title.includes(p)) byTitle += 4;
      else if (place.includes(p)) byPlace += 2;
      else if (parts.length && parts.every((w) => title.includes(w))) byTitle += 3;
    }
    if (!phrases.length) for (const w of words) if (title.includes(w)) byTitle += 1;
    return [byTitle >= (phrases.length ? 3 : 2) ? byTitle + byPlace : 0, ad];
  }).filter(([score]) => score > 0);
  scored.sort((a, b) => b[0] - a[0] || a[1].id - b[1].id);
  return scored.slice(0, limit).map(([, ad]) => ad);
}

export function byUrl(url) {
  const clean = String(url || "").split(/[?#]/)[0].replace(/\/$/, "");
  return ADVERTS.find((ad) => ad.url === clean) || null;
}
