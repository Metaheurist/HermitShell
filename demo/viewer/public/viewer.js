// The viewer page: tiles for each window from the server's event stream, and the test panel.
(() => {
  const $ = (id) => document.getElementById(id);
  const tiles = new Map();
  let config = {};

  function tile(key, role) {
    let t = tiles.get(key);
    if (!t) {
      const fig = document.createElement("figure");
      const cap = document.createElement("figcaption");
      const who = document.createElement("strong");
      const said = document.createElement("span");
      const img = document.createElement("img");
      who.textContent = key.startsWith("recruit-") ? `Recruit (${key.slice(8)})` : role || key;
      img.alt = `${who.textContent} window`;
      cap.append(who, said);
      fig.append(cap, img);
      $("tiles").append(fig);
      $("empty").hidden = true;
      t = { fig, img, said, role };
      tiles.set(key, t);
      layout();
    }
    return t;
  }

  // Pick the column count that shows every window biggest, so the tiles fill the screen whatever its shape.
  let aspect = 0;
  function layout() {
    const box = $("tiles");
    const n = tiles.size;
    if (!n) return;
    const gap = 10;
    const caption = 32;
    const w = box.clientWidth - 2 * gap;
    const h = box.clientHeight - 2 * gap;
    const ratio = aspect || 16 / 10;
    let best = { cols: 1, rows: n, size: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = (w - gap * (cols - 1)) / cols;
      const ch = (h - gap * (rows - 1)) / rows - caption;
      const size = Math.min(cw, ch * ratio);
      if (size > best.size) best = { cols, rows, size };
    }
    box.style.gridTemplateColumns = `repeat(${best.cols}, minmax(0, 1fr))`;
    box.style.gridTemplateRows = `repeat(${best.rows}, minmax(0, 1fr))`;
  }
  window.addEventListener("resize", layout);

  function setStatus(s) {
    $("status").textContent = s.text;
    $("status").className = s.state;
    $("run-button").disabled = s.state === "running" || s.state === "starting";
    const report = $("report");
    report.textContent = "";
    for (const [label, href] of Object.entries(s.links || {})) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = label;
      a.target = "_blank";
      a.rel = "noopener";
      report.append(a);
    }
  }

  function addLog(line) {
    const log = $("log");
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.append(`${line}\n`);
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function hello(data) {
    config = data.config;
    $("mode").textContent = `${config.mode} mode`;
    const nav = $("links");
    nav.textContent = "";
    for (const [label, href] of Object.entries(config.links || {})) {
      const a = document.createElement("a");
      a.href = href.replace("{host}", location.hostname);
      a.textContent = label;
      a.target = "_blank";
      a.rel = "noopener";
      nav.append(a);
    }
    $("panel").hidden = !config.panel;
    $("run").hidden = !config.canRun;
    const list = $("journeys");
    list.textContent = "";
    for (const j of config.journeys) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = j;
      label.append(box, ` ${j}`);
      list.append(label);
    }
    $("log").textContent = "";
    data.log.forEach(addLog);
    for (const [key, role] of data.windows) tile(key, role);
    setStatus(data.status);
  }

  const events = new EventSource("/events");
  events.addEventListener("hello", (e) => hello(JSON.parse(e.data)));
  events.addEventListener("status", (e) => setStatus(JSON.parse(e.data)));
  events.addEventListener("log", (e) => addLog(JSON.parse(e.data)));
  events.addEventListener("reset", () => {
    tiles.forEach((t) => t.fig.remove());
    tiles.clear();
    $("empty").hidden = false;
    $("tiles").style.gridTemplateColumns = $("tiles").style.gridTemplateRows = "";
  });
  events.addEventListener("window", (e) => {
    const w = JSON.parse(e.data);
    tile(w.key, w.role).fig.classList.toggle("closed", !w.open);
  });
  events.addEventListener("frame", (e) => {
    const f = JSON.parse(e.data);
    const t = tile(f.key, f.role);
    t.fig.classList.remove("closed");
    const first = !t.next && !t.img.src;
    t.next = f.data;
    if (!t.drawing) {
      t.drawing = true;
      requestAnimationFrame(() => {
        t.drawing = false;
        t.img.src = `data:image/jpeg;base64,${t.next}`;
        t.next = "";
      });
    }
    if (first && !aspect) t.img.addEventListener("load", () => {
      if (aspect || !t.img.naturalHeight) return;
      aspect = t.img.naturalWidth / t.img.naturalHeight;
      layout();
    }, { once: true });
  });
  events.addEventListener("caption", (e) => {
    const c = JSON.parse(e.data);
    for (const t of tiles.values()) if (t.role === c.role) t.said.textContent = c.text;
  });
  events.onerror = () => { $("status").textContent = "Reconnecting..."; };

  $("run").addEventListener("submit", async (e) => {
    e.preventDefault();
    const only = [...document.querySelectorAll("#journeys input:checked")].map((b) => b.value);
    const res = await fetch("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ only }) });
    if (res.status === 409) addLog("A walkthrough is already running.");
  });
})();
