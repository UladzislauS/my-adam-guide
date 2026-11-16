/* Guide editor: edits data/guide.json + data/areas.geojson and commits them to GitHub.
 * Vercel redeploys the site on every commit. No server: the GitHub token stays in this browser. */
(async function () {
  "use strict";

  /* ---------- Helpers ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  // Works from the first moment, even if the guide fails to load.
  $("#theme").addEventListener("click", () => window.cityTheme?.toggle());
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const slug = (s) =>
    String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const roundDeep = (g) => JSON.parse(JSON.stringify(g, (_, v) => (typeof v === "number" ? round6(v) : v)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (o) => structuredClone(o);
  const validHex = (c) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : null);
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
  // Same formatting as scripts/geocode.mjs: short arrays/objects (coordinates, tags) stay on one line.
  const pretty = (obj) =>
    JSON.stringify(obj, null, 2).replace(/[\[{][^\[\]{}]*[\]}]/g, (m) => {
      const flat = m.replace(/\s*\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]");
      return flat.length <= 90 ? flat : m;
    });
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const GUIDE_PATH = "data/guide.json";
  const AREAS_PATH = "data/areas.geojson";
  const SETTINGS_KEY = "cityGuide.admin.settings";
  const PALETTE = ["#F76707", "#1C7ED6", "#AE3EC9", "#E64980", "#2F9E44", "#0C8599", "#F59F00", "#5C7CFA", "#D6336C", "#37B24D", "#7048E8", "#1098AD"];

  // Two ways to connect: "Sign in with GitHub" (session, via /api/github) or a pasted token (settings).
  let settings = { repo: "", branch: "main", token: "", ...(store.get(SETTINGS_KEY) || {}) };
  let session = null; // { token, expiresAt, login, repo, branch }
  let signInAvailable = false; // false when /api/github isn't deployed or configured (e.g. npx serve)
  const creds = () => session?.token
    ? { repo: session.repo || settings.repo, branch: session.branch || "main", token: session.token }
    : settings;
  const connected = () => !!(creds().repo && creds().token);
  const phone = matchMedia("(max-width: 820px)");
  const touchOnly = matchMedia("(hover: none)").matches;

  /* ---------- DOM ---------- */
  const shell = $("#shell");
  const treeEl = $("#tree");
  const formEl = $("#form");
  const saveBtn = $("#save-btn");
  const sourceEl = $("#source");
  const bannerEl = $("#banner");
  const filterEl = $("#tree-filter");
  const mapPane = $(".map-pane");
  const mapHint = $("#map-hint");
  const settingsDlg = $("#settings");
  const saveDlg = $("#save-dlg");

  /* ---------- State ---------- */
  let base; // what's published: {source, commit, guideText, areasText, guide, areas, norm}
  let guide, areas; // working copy
  let selected = null;
  let mode = null; // location mode shown for the selected place: none | pin | shape
  let dirty = false;
  let report = { errors: [], warnings: [], per: new Map() };
  const fresh = new WeakSet(); // newly added places whose link id follows their name

  /* ---------- Tree helpers ---------- */
  function* walk(list, parent = null, depth = 0) {
    for (const node of list || []) {
      yield { node, parent, list, depth };
      yield* walk(node.places, node, depth + 1);
    }
  }
  const nodes = () => [...walk(guide.districts)];
  const locate = (n) => nodes().find((e) => e.node === n) || null;
  const isDistrict = (n) => guide.districts.includes(n);
  function ancestors(n) {
    const parentOf = new Map(nodes().map((e) => [e.node, e.parent]));
    const out = [];
    for (let p = parentOf.get(n); p; p = parentOf.get(p)) out.unshift(p);
    return out;
  }
  const fid = (f) => f.id ?? f.properties?.id;
  const areaById = (id) => areas.features.find((f) => fid(f) === id);
  const typeColor = (t) => guide.types[t]?.color || "#868e96";
  const nodeColor = (n) => (isDistrict(n) ? validHex(n.color) || "#868e96" : validHex(typeColor(n.type)) || "#868e96");
  const hasPin = (n) => Array.isArray(n.location) && n.location.length === 2;
  function geoKind(n) {
    const f = n.area && areaById(n.area);
    if (f) return /Line/.test(f.geometry.type) ? "line" : "shape";
    return hasPin(n) ? "pin" : "none";
  }
  function anchorOf(n) {
    for (const a of [n, ...ancestors(n).reverse()]) if (geoKind(a) !== "none") return a;
    return null;
  }
  const usedBy = (areaId, except) => nodes().filter((e) => e.node !== except && e.node.area === areaId).map((e) => e.node);
  function uniqueId(baseId, self) {
    const b = baseId || "place";
    const taken = new Set(nodes().filter((e) => e.node !== self).map((e) => e.node.id));
    let id = b;
    for (let i = 2; taken.has(id); i++) id = `${b}-${i}`;
    return id;
  }
  function uniqueAreaId(baseId) {
    const b = baseId || "shape";
    let id = b;
    for (let i = 2; areaById(id); i++) id = `${b}-${i}`;
    return id;
  }

  /* ---------- Serialising (stable key order, empty fields dropped) ---------- */
  const KEY_ORDER = ["id", "name", "description", "type", "tags", "location", "area", "mapsQuery", "color", "places"];
  function cleanNode(n) {
    const out = {};
    const keys = [...KEY_ORDER, ...Object.keys(n).filter((k) => !KEY_ORDER.includes(k))];
    for (const k of keys) {
      let v = n[k];
      if (typeof v === "string") v = v.trim();
      if (v === undefined || v === null || v === "") continue;
      if ((k === "tags" || k === "places") && Array.isArray(v) && !v.length) continue;
      if (k === "places") v = v.map(cleanNode);
      if (k === "location" && Array.isArray(v)) v = v.map(round6);
      out[k] = v;
    }
    return out;
  }
  function serialize(g, a) {
    const clean = { ...g, districts: g.districts.map(cleanNode) };
    const used = new Set([...walk(clean.districts)].map((e) => e.node.area).filter(Boolean));
    const feats = a.features.filter((f) => used.has(fid(f))); // shapes nothing uses any more are dropped
    return { guide: pretty(clean) + "\n", areas: JSON.stringify({ ...a, features: feats }) + "\n" };
  }
  function makeBase(l) {
    const g = JSON.parse(l.guideText), a = JSON.parse(l.areasText);
    return { ...l, guide: g, areas: a, norm: serialize(g, a) };
  }

  /* ---------- GitHub ---------- */
  const br = () => (creds().branch || "main").split("/").map(encodeURIComponent).join("/");
  async function fetchSession() {
    try {
      const r = await fetch("/api/github?step=token", { method: "POST", cache: "no-store" });
      signInAvailable = r.status === 200 || r.status === 401;
      session = r.status === 200 ? await r.json() : null;
    } catch {
      signInAvailable = false;
      session = null;
    }
    return session;
  }
  async function gh(path, opts = {}) {
    // Signed-in tokens last 8 hours; get a fresh one shortly before that.
    if (session?.expiresAt && session.expiresAt - Date.now() < 5 * 60e3) {
      if (!(await fetchSession())) {
        renderStatus();
        throw new Error("Your GitHub sign-in has expired. Sign in again (the gear button); your edits are kept.");
      }
    }
    const res = await fetch(`https://api.github.com/repos/${creds().repo}${path}`, {
      method: opts.method || "GET",
      body: opts.body,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${creds().token}`,
        Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.json()).message || ""; } catch { /* not JSON */ }
      throw new Error(ghError(res.status, msg));
    }
    return opts.raw ? res.text() : res.json();
  }
  const post = (body, method = "POST") => ({ method, body: JSON.stringify(body) });
  function ghError(status, msg) {
    if (status === 401) return session ? "Your GitHub sign-in is no longer valid. Sign out and sign in again." : "GitHub rejected the token. It may have expired or been mistyped.";
    if (status === 403) return `GitHub refused access${msg ? ` (${msg})` : ""}. The token needs Contents: Read and write for this repository.`;
    if (status === 404) return "Repository, branch or file not found, or the token has no access to this repository.";
    if (status === 409) return "The repository is empty. Push the site to GitHub first.";
    if (status === 422 && /fast.?forward/i.test(msg)) return "Someone saved at the same moment. Reload the page and try again.";
    return `GitHub error ${status}${msg ? `: ${msg}` : ""}`;
  }
  async function loadFromGitHub() {
    const commit = (await gh(`/git/ref/heads/${br()}`)).object.sha;
    const [guideText, areasText] = await Promise.all(
      [GUIDE_PATH, AREAS_PATH].map((p) => gh(`/contents/${p}?ref=${commit}`, { raw: true }))
    );
    return { source: "github", commit, guideText, areasText };
  }
  async function loadFromSite() {
    const [guideText, areasText] = await Promise.all(
      ["/" + GUIDE_PATH, "/" + AREAS_PATH].map(async (u) => {
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) throw new Error(`${u}: ${r.status}`);
        return r.text();
      })
    );
    return { source: "site", commit: null, guideText, areasText };
  }

  /* ---------- OpenStreetMap search (Nominatim, max 1 request/second) ---------- */
  let lastSearch = 0;
  async function nominatimFetch(params) {
    const wait = lastSearch + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastSearch = Date.now();
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "jsonv2", ...params })}`);
    if (!res.ok) throw new Error(`OpenStreetMap search failed (${res.status})`);
    return res.json();
  }
  async function nominatim(q, withShape) {
    const [lat, lng] = guide.map?.center || [52.372, 4.893];
    const p = { q, limit: withShape ? "8" : "6", viewbox: `${lng - 0.2},${lat + 0.12},${lng + 0.2},${lat - 0.12}`, bounded: "1" };
    if (withShape) Object.assign(p, { polygon_geojson: "1", polygon_threshold: "0.00002" });
    let r = await nominatimFetch(p);
    if (!r.length) r = await nominatimFetch({ ...p, bounded: "0" });
    // A street comes back once per postcode; keep one (the whole street is collected when it's used).
    const seen = new Set();
    return r.filter((x) => {
      const key = x.category === "highway" ? `street:${x.name}` : `${x.osm_type}:${x.osm_id}`;
      return !seen.has(key) && seen.add(key);
    });
  }
  // A street is many short pieces in OpenStreetMap; fetch them all and join them into one line.
  async function wholeStreet(name) {
    const r = await nominatimFetch({
      street: name, city: guide.city || "", polygon_geojson: "1", polygon_threshold: "0.00002", dedupe: "0", limit: "40",
    });
    const parts = r.filter((x) => x.category === "highway" && x.name === name && /LineString/.test(x.geojson?.type || ""));
    const roads = parts.filter((x) => !["footway", "cycleway", "path", "steps"].includes(x.type));
    const use = roads.length ? roads : parts;
    if (use.length < 2) return null;
    const lines = [];
    for (const x of use) {
      if (x.geojson.type === "LineString") lines.push(x.geojson.coordinates);
      else lines.push(...x.geojson.coordinates);
    }
    return { type: "MultiLineString", coordinates: lines };
  }

  function parseCoords(s) {
    let t = s;
    try { t = decodeURIComponent(s); } catch { /* keep as is */ }
    const pats = [
      /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, // the place's own pin in a Google Maps link
      /[?&](?:q|ll|query|destination|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
      /@(-?\d+\.\d+),(-?\d+\.\d+)/, // map centre in a Google Maps link
      /^\s*(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*$/, // "52.37, 4.89"
    ];
    for (const re of pats) {
      const m = t.match(re);
      if (m) {
        const lat = +m[1], lng = +m[2];
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return [lat, lng];
      }
    }
    return null;
  }
  function placeNameFromUrl(s) {
    const m = s.match(/\/maps\/place\/([^/@?]+)/);
    if (!m) return null;
    let name = m[1].replace(/\+/g, " ");
    try { name = decodeURIComponent(name); } catch { /* keep */ }
    return /\d/.test(name) ? null : name.trim(); // skip plain addresses
  }
  function parseGeoJSON(text) {
    const geoms = [];
    const take = (g) => {
      if (!g) return;
      if (g.type === "Feature") take(g.geometry);
      else if (g.type === "FeatureCollection") g.features.forEach(take);
      else if (g.type === "GeometryCollection") g.geometries.forEach(take);
      else geoms.push(g);
    };
    take(JSON.parse(text));
    const polys = [], lines = [];
    for (const g of geoms) {
      if (g.type === "Polygon") polys.push(g.coordinates);
      else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
      else if (g.type === "LineString") lines.push(g.coordinates);
      else if (g.type === "MultiLineString") lines.push(...g.coordinates);
    }
    if (polys.length && lines.length) throw new Error("Use either areas or lines, not both.");
    if (polys.length) return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
    if (lines.length) return lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
    throw new Error("No area or line found. For a single spot, use Pin instead.");
  }

  /* ---------- Validation ---------- */
  function validate() {
    const errors = [], warnings = [], per = new Map();
    const add = (n, level, msg) => {
      (level === "error" ? errors : warnings).push({ n, msg });
      const p = per.get(n) || { errors: [], warnings: [] };
      p[level + "s"].push(msg);
      per.set(n, p);
    };
    const [clat, clng] = guide.map?.center || [52.372, 4.893];
    const seen = new Map();
    for (const { node: n, parent } of walk(guide.districts)) {
      if (!String(n.name || "").trim()) add(n, "error", "Needs a name");
      if (!n.id) add(n, "error", "Needs a link id (under More settings)");
      else if (!/^[a-z0-9][a-z0-9-]*$/.test(n.id)) add(n, "error", "Link id can only use a–z, 0–9 and dashes");
      else if (seen.has(n.id)) add(n, "error", `Link id “${n.id}” is also used by ${seen.get(n.id).name || "another place"}`);
      else seen.set(n.id, n);
      if (parent && !guide.types[n.type]) add(n, "error", "Choose a type");
      if (!parent) {
        if (n.color && !validHex(n.color)) add(n, "error", "Colour must look like #F76707");
        if (!n.area) add(n, "warning", "No shape yet, so the district isn't highlighted on the map");
      }
      if (n.location !== undefined) {
        const ok = Array.isArray(n.location) && n.location.length === 2 && n.location.every((v) => typeof v === "number" && isFinite(v));
        if (!ok) add(n, "error", "The pin isn't valid. Place it again");
        else if (Math.abs(n.location[0] - clat) > 0.5 || Math.abs(n.location[1] - clng) > 0.8) add(n, "error", `The pin is far outside ${guide.city || "the city"}`);
      }
      if (n.area !== undefined && !areaById(n.area)) add(n, "error", "Its shape is missing. Choose it again");
    }
    return { errors, warnings, per };
  }
  const quiet = (n) => fresh.has(n) && !String(n.name || "").trim(); // don't nag about a place you've only just added

  /* ---------- Change tracking ---------- */
  function changed({ tree = true, map: redraw = true, form = false } = {}) {
    report = validate();
    const c = serialize(guide, areas);
    dirty = c.guide !== base.norm.guide || c.areas !== base.norm.areas;
    renderStatus();
    if (tree) renderTree();
    if (redraw) drawMap();
    if (form) renderForm();
    else renderProblems();
    scheduleDraft(c);
  }
  function renderStatus() {
    const who = session?.login ? `@${session.login} · ` : "";
    const where = base.source === "github"
      ? `${who}${creds().repo} · ${creds().branch || "main"} @ ${base.commit.slice(0, 7)}`
      : connected() ? "Published copy (GitHub didn't load)" : "Published copy · not connected to GitHub";
    sourceEl.innerHTML = esc(where) + (dirty ? ` · <span class="dirty">unsaved changes</span>` : "");
    saveBtn.disabled = !dirty;
  }

  // Drafts survive a closed tab or a phone reload until you save or discard them.
  const draftKey = () => "cityGuide.admin.draft";
  let draftTimer;
  function writeDraft(c = serialize(guide, areas)) {
    clearTimeout(draftTimer);
    if (dirty) store.set(draftKey(), { at: Date.now(), base: hash(base.norm.guide + base.norm.areas), guide: c.guide, areas: c.areas });
    else store.del(draftKey());
  }
  function scheduleDraft(c) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => writeDraft(c), 400);
  }
  function offerDraft() {
    const d = store.get(draftKey());
    if (!d?.guide) return;
    if (d.guide === base.norm.guide && d.areas === base.norm.areas) return store.del(draftKey());
    const stale = d.base !== hash(base.norm.guide + base.norm.areas);
    const when = new Date(d.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    showBanner(
      `You have unsaved edits from ${when}.` + (stale ? " The guide has been changed elsewhere since then, so restoring them replaces those changes." : ""),
      stale ? "error" : "",
      [
        ["Restore", () => {
          guide = JSON.parse(d.guide);
          areas = JSON.parse(d.areas);
          selected = null;
          hideBanner("draft");
          changed({ form: true });
          restoreSpot();
        }],
        ["Discard", () => { store.del(draftKey()); hideBanner("draft"); }],
      ],
      "draft"
    );
  }

  // Banners stack, one per topic: "conn" (GitHub connection), "draft" and "save".
  function showBanner(text, kind = "", actions = [], key = "conn") {
    let row = bannerEl.querySelector(`[data-key="${key}"]`);
    if (!row) {
      row = document.createElement("div");
      row.dataset.key = key;
      if (key === "conn") bannerEl.prepend(row); else bannerEl.append(row);
    }
    row.className = "banner" + (kind ? " " + kind : "");
    row.innerHTML = `<span>${esc(text)}</span>`;
    for (const [label, fn] of actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = label;
      b.addEventListener("click", fn);
      row.append(b);
    }
    bannerEl.hidden = false;
  }
  function hideBanner(key = "conn") {
    bannerEl.querySelector(`[data-key="${key}"]`)?.remove();
    bannerEl.hidden = !bannerEl.children.length;
  }

  /* ---------- Load ---------- */
  await fetchSession();
  let loaded, loadErr;
  if (connected()) {
    try { loaded = await loadFromGitHub(); } catch (e) { loadErr = e; }
  }
  if (!loaded) {
    try { loaded = await loadFromSite(); } catch (e) {
      formEl.innerHTML = `<div class="empty-state">Couldn't load the guide: ${esc(e.message)}</div>`;
      return;
    }
  }
  base = makeBase(loaded);
  guide = clone(base.guide);
  areas = clone(base.areas);

  /* ---------- Map ---------- */
  const home = { center: guide.map?.center || [52.372, 4.893], zoom: guide.map?.zoom || 13 };
  const map = L.map("map", { zoomControl: true }).setView(home.center, home.zoom);
  const styleUrl = () => `https://tiles.openfreemap.org/styles/${window.cityTheme?.isDark() ? "dark" : "positron"}`;
  const basemap = L.maplibreGL({
    style: styleUrl(),
    attribution:
      '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  }).addTo(map);
  window.addEventListener("themechange", () => { basemap.getMaplibreMap().setStyle(styleUrl()); drawMap(); });
  [["districts", 350], ["areas", 400], ["lines", 420], ["points", 450], ["sel", 460], ["preview", 470]].forEach(([n, z]) => {
    map.createPane(n).style.zIndex = z;
  });
  new ResizeObserver(() => map.invalidateSize()).observe($("#map"));

  const ctxLayer = L.layerGroup().addTo(map);
  const selLayer = L.layerGroup().addTo(map);
  const previewLayer = L.layerGroup().addTo(map);
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e8590c";
  const pinIcon = () => L.divIcon({
    className: "pin-icon",
    html: `<svg viewBox="0 0 30 40" aria-hidden="true"><path d="M15 38.5S27 25.2 27 15.5a12 12 0 0 0-24 0C3 25.2 15 38.5 15 38.5Z" fill="${accent()}" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15.5" r="4.5" fill="#fff"/></svg>`,
    iconSize: [30, 40],
    iconAnchor: [15, 39],
  });

  function drawMap() {
    ctxLayer.clearLayers();
    selLayer.clearLayers();
    for (const { node: n, depth } of nodes()) {
      const k = geoKind(n);
      if (k === "none" || n === selected) continue;
      const c = nodeColor(n);
      let layer;
      if (k === "pin") {
        layer = L.circleMarker(n.location, { pane: "points", radius: 6, color: "#fff", weight: 2, fillColor: c, fillOpacity: 1 });
      } else {
        const pane = depth === 0 ? "districts" : k === "line" ? "lines" : "areas";
        const style = depth === 0
          ? { color: c, weight: 1.5, opacity: 0.75, fillColor: c, fillOpacity: 0.06 }
          : k === "line"
            ? { color: c, weight: 5, opacity: 0.75, lineCap: "round", lineJoin: "round" }
            : { color: c, weight: 1.5, opacity: 0.85, fillColor: c, fillOpacity: 0.16 };
        layer = L.geoJSON(areaById(n.area), { pane, style });
      }
      if (!touchOnly) layer.bindTooltip(esc(n.name || "Untitled"), { className: "name-tip", sticky: k !== "pin" });
      layer.on("click", (ev) => {
        if (selected && mode === "pin") return; // let the click through to the map: it moves the pin
        L.DomEvent.stopPropagation(ev);
        select(n, { fly: false });
      });
      layer.addTo(ctxLayer);
    }

    const n = selected;
    if (!n) return;
    const k = geoKind(n);
    const a = accent();
    if (k === "pin") {
      const m = L.marker(n.location, { icon: pinIcon(), draggable: true, autoPan: true, zIndexOffset: 1000, keyboard: false });
      m.on("dragend", () => { const ll = m.getLatLng(); placePin([ll.lat, ll.lng], false); });
      m.addTo(selLayer);
    } else if (k !== "none") {
      L.geoJSON(areaById(n.area), {
        pane: "sel",
        interactive: false,
        style: k === "line"
          ? { color: a, weight: 8, opacity: 0.95, lineCap: "round", lineJoin: "round" }
          : { color: a, weight: 3, fillColor: a, fillOpacity: 0.18 },
      }).addTo(selLayer);
    } else {
      // No own spot: outline the parent it's shown at
      const an = anchorOf(n);
      if (an && geoKind(an) === "pin") {
        L.circleMarker(an.location, { pane: "sel", radius: 16, color: a, weight: 2, dashArray: "4 4", fill: false, interactive: false }).addTo(selLayer);
      } else if (an) {
        L.geoJSON(areaById(an.area), { pane: "sel", interactive: false, style: { color: a, weight: 2, dashArray: "6 6", fillOpacity: 0 } }).addTo(selLayer);
      }
    }
  }

  function flyTo(n) {
    const t = anchorOf(n);
    if (!t) return;
    map.invalidateSize();
    if (geoKind(t) === "pin") map.flyTo(t.location, Math.max(map.getZoom(), 16), { duration: 0.6 });
    else map.flyToBounds(L.geoJSON(areaById(t.area)).getBounds(), { padding: [30, 30], maxZoom: 17, duration: 0.6 });
  }
  function preview(geojson) {
    previewLayer.clearLayers();
    if (!geojson) return;
    const a = accent();
    const layer = geojson.type === "Point"
      ? L.circleMarker([geojson.coordinates[1], geojson.coordinates[0]], { pane: "preview", radius: 9, color: a, weight: 3, dashArray: "3 3", fillOpacity: 0.15, interactive: false })
      : L.geoJSON(geojson, { pane: "preview", interactive: false, style: { color: a, weight: 3, dashArray: "6 5", fillOpacity: 0.08 } });
    layer.addTo(previewLayer);
    if (geojson.type === "Point") map.panTo(layer.getLatLng());
    else map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 17 });
  }

  map.on("click", (e) => {
    if (selected && mode === "pin") placePin([e.latlng.lat, e.latlng.lng], false);
  });

  /* ---------- Tree ---------- */
  let rowNodes = [];
  function renderTree() {
    const q = filterEl.value.trim().toLowerCase();
    const all = nodes();
    let visible = null;
    if (q) {
      visible = new Set();
      const parentOf = new Map(all.map((e) => [e.node, e.parent]));
      for (const { node: n } of all) {
        const hay = [n.name, n.description, (n.tags || []).join(" "), n.id].join(" ").toLowerCase();
        if (!hay.includes(q)) continue;
        for (let p = n; p; p = parentOf.get(p)) visible.add(p);
      }
    }
    rowNodes = [];
    let html = "";
    for (const { node: n, depth } of all) {
      if (visible && !visible.has(n)) continue;
      const i = rowNodes.push(n) - 1;
      const name = String(n.name || "").trim();
      const errs = quiet(n) ? [] : report.per.get(n)?.errors || [];
      const k = geoKind(n);
      const geo = { pin: ["●", "Pin"], shape: ["▢", "Area"], line: ["━", "Street"], none: ["", ""] }[k];
      html += `<div class="t-line">
        <button type="button" class="t-row${depth === 0 ? " district" : ""}${n === selected ? " sel" : ""}" data-i="${i}" style="--d:${depth}">
          <span class="dot" style="background:${nodeColor(n)}"></span>
          <span class="t-name${name ? "" : " untitled"}">${esc(name || "Untitled")}</span>
          ${errs.length ? `<span class="t-bad" title="${esc(errs.join("\n"))}">!</span>` : ""}
          <span class="t-geo" title="${geo[1]}">${geo[0]}</span>
        </button>${depth === 0 ? `<button type="button" class="t-add" data-add="${i}" title="Add a place to ${esc(name)}" aria-label="Add a place to ${esc(name)}">+</button>` : ""}
      </div>`;
    }
    treeEl.innerHTML = html || `<div class="t-empty">${q ? "No matches." : "No districts yet."}</div>`;
    treeEl.querySelector(".t-row.sel")?.scrollIntoView({ block: "nearest" });
  }
  treeEl.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) return addPlace(rowNodes[+add.dataset.add]);
    const row = e.target.closest("[data-i]");
    if (row) select(rowNodes[+row.dataset.i]);
  });
  filterEl.addEventListener("input", renderTree);

  /* ---------- Selection & views ---------- */
  function setView(v, push = true) {
    if (shell.dataset.view === v) return;
    shell.dataset.view = v;
    if (v === "edit" && phone.matches && push) history.pushState({ edit: true }, "");
  }
  addEventListener("popstate", () => { if (shell.dataset.view === "edit") shell.dataset.view = "tree"; });
  $("#back").addEventListener("click", () => {
    if (history.state?.edit) history.back();
    else shell.dataset.view = "tree";
  });

  function dropIfEmpty(n) {
    if (!fresh.has(n) || String(n.name || "").trim() || n.description || hasPin(n) || n.area || n.places?.length) return;
    const e = locate(n);
    if (e) e.list.splice(e.list.indexOf(n), 1);
  }
  function geoMode(n) {
    const k = geoKind(n);
    if (k === "pin") return "pin";
    if (k !== "none" || n.area) return "shape";
    if (isDistrict(n)) return "shape";
    return fresh.has(n) ? "pin" : "none";
  }
  function select(n, { fly = true, push = true } = {}) {
    if (selected && selected !== n) dropIfEmpty(selected);
    selected = n || null;
    mode = n ? geoMode(n) : null;
    preview(null);
    if (n) {
      setView("edit", push);
      history.replaceState(history.state, "", n.id ? "#" + encodeURIComponent(n.id) : location.pathname);
    } else {
      setView("tree");
      history.replaceState(history.state, "", location.pathname);
    }
    changed({ form: true });
    if (n && fly) requestAnimationFrame(() => flyTo(n));
  }

  /* ---------- Form ---------- */
  function moveTargets(n) {
    const banned = new Set([n, ...[...walk(n.places)].map((e) => e.node)]);
    return nodes().filter((e) => !banned.has(e.node));
  }
  let moveList = [];

  function renderForm() {
    const n = selected;
    mapPane.classList.toggle("pin-mode", !!n && mode === "pin");
    if (!n) {
      mapHint.hidden = true;
      formEl.innerHTML = `<div class="empty-state">Choose a place in the list or on the map,<br />or add one with <b>+</b> next to a district.</div>`;
      return;
    }
    const dist = isDistrict(n);
    const anc = ancestors(n);
    const allTags = [...new Set(nodes().flatMap((e) => e.node.tags || []))].sort((a, b) => a.localeCompare(b));
    const parent = anc[anc.length - 1];
    moveList = dist ? [] : moveTargets(n);

    formEl.innerHTML = `
      <div class="crumbs">${anc.length
        ? anc.map((a, i) => `<button type="button" data-crumb="${i}">${esc(a.name || "Untitled")}</button>`).join("<span>›</span>")
        : "District"}</div>
      <h2 class="form-title" id="f-title"></h2>
      <ul class="problems" id="f-problems"></ul>

      <label class="field"><span>Name</span><input id="f-name" value="${esc(n.name || "")}" autocomplete="off" /></label>
      ${dist
        ? `<div class="field"><span class="field-label">Colour on the map</span>
             <div class="color-row">
               <input type="color" id="f-color" value="${esc(validHex(n.color) || "#868e96")}" aria-label="Pick colour" />
               <input type="text" id="f-color-hex" value="${esc(n.color || "")}" placeholder="#F76707" spellcheck="false" autocomplete="off" aria-label="Colour code" />
             </div></div>`
        : `<label class="field"><span>Type</span><select id="f-type">
             ${guide.types[n.type] ? "" : `<option value="" selected disabled>Choose…</option>`}
             ${Object.entries(guide.types).map(([k, t]) => `<option value="${esc(k)}"${k === n.type ? " selected" : ""}>${esc(t.label)}</option>`).join("")}
           </select></label>`}
      <label class="field"><span>Your notes</span><textarea id="f-desc" rows="5" placeholder="What should people know about it?">${esc(n.description || "")}</textarea></label>
      <div class="field"><span class="field-label">Tags</span>
        <div class="tags-input" id="f-tags"></div>
        <datalist id="tag-list">${allTags.map((t) => `<option value="${esc(t)}"></option>`).join("")}</datalist>
      </div>

      <fieldset class="field"><legend>On the map</legend>
        <div class="seg" role="group" aria-label="How it's shown on the map">
          ${dist ? "" : `<button type="button" data-mode="none">No own spot</button>`}
          <button type="button" data-mode="pin">Pin</button>
          <button type="button" data-mode="shape">Area or street</button>
        </div>
        <div class="loc-body" id="loc-body"></div>
      </fieldset>

      <details class="more"><summary>More settings</summary>
        <label class="field"><span>Link id</span>
          <div class="id-row"><span>/#</span><input id="f-id" value="${esc(n.id || "")}" spellcheck="false" autocomplete="off" autocapitalize="off" /></div>
          <small>${fresh.has(n) ? "Follows the name until you change it." : "Changing it breaks links you've already shared."}</small>
        </label>
        ${dist ? "" : `<label class="field"><span>Google Maps search</span>
          <input id="f-maps" value="${esc(n.mapsQuery || "")}" autocomplete="off" />
          <small>Used by the “Open in Google Maps” button. Add the address if the name alone finds the wrong place.</small>
        </label>`}
      </details>

      <div class="form-actions">
        <button type="button" class="btn small" id="a-child">+ Add place inside</button>
        <button type="button" class="btn small ghost" id="a-up" title="Move up" aria-label="Move up">↑</button>
        <button type="button" class="btn small ghost" id="a-down" title="Move down" aria-label="Move down">↓</button>
        <span class="spacer"></span>
        <button type="button" class="btn small ghost danger" id="a-del">Delete</button>
        ${dist ? "" : `<label class="move">Move into
          <select id="a-move">${moveList.map((e, i) =>
            `<option value="${i}"${e.node === parent ? " selected" : ""}>${"   ".repeat(e.depth)}${esc(e.node.name || "Untitled")}</option>`).join("")}
          </select></label>`}
      </div>`;

    updateTitle();
    renderTags();
    renderLoc();
    renderProblems();
    bindForm(n, anc);
  }
  function updateTitle() {
    const n = selected;
    $("#f-title").textContent = String(n.name || "").trim() || (isDistrict(n) ? "New district" : "New place");
    const maps = $("#f-maps");
    if (maps) maps.placeholder = `${String(n.name || "").trim() || "Name"}, ${guide.city || ""}`;
  }
  function renderProblems() {
    const el = $("#f-problems");
    if (!el || !selected) return;
    const p = report.per.get(selected);
    el.innerHTML = !p || quiet(selected) ? ""
      : [...p.errors.map((m) => `<li class="error">${esc(m)}</li>`), ...p.warnings.map((m) => `<li class="warning">${esc(m)}</li>`)].join("");
  }

  function bindForm(n, anc) {
    formEl.querySelectorAll("[data-crumb]").forEach((b) => b.addEventListener("click", () => select(anc[+b.dataset.crumb])));

    const name = $("#f-name"), idIn = $("#f-id");
    name.addEventListener("input", () => {
      n.name = name.value;
      if (fresh.has(n)) { n.id = uniqueId(slug(n.name), n); idIn.value = n.id; }
      updateTitle();
      changed({ map: false });
    });
    name.addEventListener("change", drawMap);
    idIn.addEventListener("input", () => { fresh.delete(n); n.id = idIn.value.trim(); changed({ map: false }); });
    idIn.addEventListener("change", () => history.replaceState(history.state, "", "#" + encodeURIComponent(n.id)));

    $("#f-desc").addEventListener("input", (e) => { n.description = e.target.value; changed({ tree: false, map: false }); });
    $("#f-maps")?.addEventListener("input", (e) => { n.mapsQuery = e.target.value; changed({ tree: false, map: false }); });
    $("#f-type")?.addEventListener("change", (e) => { n.type = e.target.value; changed(); });

    const color = $("#f-color"), hex = $("#f-color-hex");
    color?.addEventListener("input", () => { n.color = color.value.toUpperCase(); hex.value = n.color; changed(); });
    hex?.addEventListener("input", () => {
      n.color = hex.value.trim();
      if (validHex(n.color)) color.value = n.color.toLowerCase();
      changed();
    });

    const tags = $("#f-tags");
    tags.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-rm]");
      if (rm) {
        n.tags.splice(+rm.dataset.rm, 1);
        renderTags();
        $("#f-tag-new").focus();
        changed({ map: false });
      } else if (e.target === tags) $("#f-tag-new").focus();
    });
    tags.addEventListener("keydown", (e) => {
      const input = e.target.closest("#f-tag-new");
      if (!input) return;
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addTag(input.value);
      } else if (e.key === "Backspace" && !input.value && n.tags?.length) {
        n.tags.pop();
        renderTags();
        $("#f-tag-new").focus();
        changed({ map: false });
      }
    });
    tags.addEventListener("change", (e) => { if (e.target.id === "f-tag-new" && e.target.value.trim()) addTag(e.target.value, false); });

    formEl.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.mode;
      preview(null);
      renderLoc();
    }));

    $("#a-child").addEventListener("click", () => addPlace(n));
    $("#a-up").addEventListener("click", () => moveBy(n, -1));
    $("#a-down").addEventListener("click", () => moveBy(n, 1));
    $("#a-del").addEventListener("click", () => deleteNode(n));
    $("#a-move")?.addEventListener("change", (e) => moveInto(n, moveList[+e.target.value].node));
  }

  function renderTags() {
    const n = selected;
    const tags = n.tags || [];
    $("#f-tags").innerHTML =
      tags.map((t, i) => `<span class="tag">#${esc(t)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join("") +
      `<input id="f-tag-new" list="tag-list" placeholder="${tags.length ? "Add…" : "Add a tag…"}" autocomplete="off" enterkeyhint="done" />`;
  }
  function addTag(raw, refocus = true) {
    const n = selected;
    const v = String(raw).replace(/,/g, " ").replace(/^#/, "").trim().replace(/\s+/g, " ");
    if (!v) return;
    n.tags ||= [];
    if (!n.tags.some((t) => t.toLowerCase() === v.toLowerCase())) n.tags.push(v);
    renderTags();
    if (refocus) $("#f-tag-new").focus();
    changed({ map: false });
  }

  /* ---------- Location editor ---------- */
  function renderLoc() {
    const n = selected;
    const body = $("#loc-body");
    if (!body) return;
    formEl.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    mapPane.classList.toggle("pin-mode", mode === "pin");
    mapHint.hidden = mode !== "pin";
    mapHint.textContent = hasPin(n) ? "Tap the map or drag the pin to move it" : "Tap the map to place the pin";
    const k = geoKind(n);
    const zoomBtn = `<button type="button" class="btn small ghost" data-zoom>Show</button>`;

    if (mode === "none") {
      const own = k !== "none" || n.area;
      const an = anchorOf(n);
      body.innerHTML = own
        ? `<div class="loc-now">It has its own ${k === "pin" ? "pin" : "shape"} now. <button type="button" class="btn small" id="loc-clear">Remove it</button></div>`
        : `<p class="hint">${an ? `Shown at <b>${esc(an.name)}</b> on the map.` : "Not shown on the map."} Good for things inside a building, like a café in a station.</p>`;
    } else if (mode === "pin") {
      body.innerHTML = `
        ${k === "pin"
          ? `<div class="loc-now">📍 <code>${n.location[0].toFixed(5)}, ${n.location[1].toFixed(5)}</code>${zoomBtn}</div>`
          : n.area ? `<div class="loc-now">Now shown as an area. Placing a pin replaces it.</div>` : ""}
        <p class="hint">Tap the map to put the pin there, or search:</p>
        <div class="geo">
          <input id="geo-q" type="search" placeholder="Address, Google Maps link or coordinates" autocomplete="off" enterkeyhint="search" />
          <button type="button" class="btn" id="geo-go">Find</button>
        </div>
        <p class="msg" id="geo-msg" hidden></p>
        <div class="results" id="geo-results"></div>`;
    } else {
      const f = n.area && areaById(n.area);
      const options = areas.features.map((x) => {
        const id = fid(x);
        const users = usedBy(id, n).map((u) => u.name).filter(Boolean);
        return `<option value="${esc(id)}"${id === n.area ? " selected" : ""}>${esc(id)}${users.length ? ` (${esc(users.join(", "))})` : ""}</option>`;
      }).join("");
      body.innerHTML = `
        ${f ? `<div class="loc-now">${/Line/.test(f.geometry.type) ? "Street line" : "Area"} <code>${esc(n.area)}</code>${zoomBtn}</div>`
          : n.area ? `<div class="loc-now">The shape “${esc(n.area)}” is missing.</div>`
          : hasPin(n) ? `<div class="loc-now">Now shown as a pin. Choosing a shape replaces it.</div>` : ""}
        <div class="geo">
          <input id="shape-q" type="search" placeholder="Search OpenStreetMap, e.g. Westerpark or Rokin" autocomplete="off" enterkeyhint="search" />
          <button type="button" class="btn" id="shape-go">Find</button>
        </div>
        <p class="msg" id="shape-msg" hidden></p>
        <div class="results" id="shape-results"></div>
        <label class="field" style="margin:4px 0 0"><span>Or reuse a shape that's already in the guide</span>
          <select id="shape-pick"><option value="">Choose…</option>${options}</select></label>
        <details class="sub"><summary>Draw your own shape</summary>
          <p class="hint">Draw it at <a href="https://geojson.io" target="_blank" rel="noopener">geojson.io</a>, copy everything in the panel on the right and paste it here.</p>
          <textarea id="shape-json" placeholder='{"type": "FeatureCollection", …}' spellcheck="false"></textarea>
          <div style="margin-top:6px"><button type="button" class="btn small" id="shape-json-use">Use this shape</button></div>
          <p class="msg" id="shape-json-msg" hidden></p>
        </details>`;
    }
    bindLoc(n);
  }
  function setMsg(el, text, err = false) {
    el.hidden = !text;
    el.textContent = text;
    el.classList.toggle("err", err);
  }

  function bindLoc(n) {
    $("#loc-body [data-zoom]")?.addEventListener("click", () => flyTo(n));
    $("#loc-clear")?.addEventListener("click", () => {
      delete n.location;
      delete n.area;
      changed();
      renderLoc();
    });

    // Pin search
    const gq = $("#geo-q");
    if (gq) {
      const go = () => pinSearch(gq.value.trim());
      $("#geo-go").addEventListener("click", go);
      gq.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      gq.addEventListener("paste", () => setTimeout(() => { if (parseCoords(gq.value)) go(); }, 0));
    }

    // Shape search
    const sq = $("#shape-q");
    if (sq) {
      const go = () => shapeSearch(sq.value.trim());
      $("#shape-go").addEventListener("click", go);
      sq.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      $("#shape-pick").addEventListener("change", (e) => {
        if (!e.target.value) return;
        n.area = e.target.value;
        delete n.location;
        changed();
        renderLoc();
        flyTo(n);
      });
      $("#shape-json-use").addEventListener("click", () => {
        const msg = $("#shape-json-msg");
        try {
          applyShape(parseGeoJSON($("#shape-json").value));
        } catch (e) {
          setMsg(msg, e instanceof SyntaxError ? "That isn't valid GeoJSON. Copy all of it from geojson.io." : e.message, true);
        }
      });
    }
  }

  function placePin([lat, lng], fly) {
    const n = selected;
    n.location = [round6(lat), round6(lng)];
    delete n.area;
    mode = "pin";
    preview(null);
    changed();
    renderLoc();
    if (fly) map.flyTo(n.location, Math.max(map.getZoom(), 17), { duration: 0.6 });
  }

  let pinResults = [];
  async function pinSearch(q) {
    if (!q) return;
    const msg = $("#geo-msg"), out = $("#geo-results");
    out.innerHTML = "";
    const ll = parseCoords(q);
    if (ll) {
      const n = selected;
      const name = placeNameFromUrl(q);
      if (name && !String(n.name || "").trim()) {
        n.name = name;
        if (fresh.has(n)) n.id = uniqueId(slug(name), n);
        placePin(ll, true);
        renderForm();
      } else placePin(ll, true);
      return;
    }
    if (/^https?:\/\//i.test(q)) {
      return setMsg(msg, /goo\.gl|maps\.app/i.test(q)
        ? "Short links can't be read here. Open the link, then copy the long address from the browser's address bar (it contains @52.3…,4.8…)."
        : "There are no coordinates in that link.", true);
    }
    setMsg(msg, "Searching…");
    try {
      pinResults = await nominatim(q, false);
    } catch (e) {
      return setMsg(msg, e.message, true);
    }
    if (!$("#geo-results")) return; // the user moved on
    if (!pinResults.length) return setMsg(msg, "Nothing found. Try the street address, or paste a Google Maps link.", true);
    setMsg(msg, "");
    out.innerHTML = pinResults.map((x, i) => resultHtml(x, i, x.category === "highway" ? "street" : x.type)).join("");
    bindResults(out, pinResults, (x) => placePin([+x.lat, +x.lon], true), (x) => preview({ type: "Point", coordinates: [+x.lon, +x.lat] }));
  }

  let shapeResults = [];
  async function shapeSearch(q) {
    if (!q) return;
    const msg = $("#shape-msg"), out = $("#shape-results");
    out.innerHTML = "";
    setMsg(msg, "Searching…");
    try {
      shapeResults = await nominatim(q, true);
    } catch (e) {
      return setMsg(msg, e.message, true);
    }
    if (!$("#shape-results")) return;
    if (!shapeResults.length) return setMsg(msg, "Nothing found. Try another spelling, or draw the shape yourself below.", true);
    setMsg(msg, "");
    out.innerHTML = shapeResults.map((x, i) => {
      const point = !x.geojson || x.geojson.type === "Point";
      return resultHtml(x, i, point ? "only a point" : x.category === "highway" ? "street" : x.type, point);
    }).join("");
    bindResults(out, shapeResults, async (x) => {
      let geom = x.geojson;
      if (x.category === "highway" && x.name) {
        setMsg(msg, "Collecting the whole street…");
        try { geom = (await wholeStreet(x.name)) || geom; } catch { /* use the single piece */ }
      }
      applyShape(geom);
    }, (x) => preview(x.geojson));
  }

  function resultHtml(x, i, kind, disabled = false) {
    const title = x.name || x.display_name.split(",")[0];
    return `<button type="button" class="result" data-r="${i}"${disabled ? " disabled" : ""}>
      <span class="r-main"><div class="r-name">${esc(title)}</div><div class="r-sub">${esc(x.display_name)}</div></span>
      <span class="r-kind">${esc(String(kind || "").replace(/_/g, " "))}</span></button>`;
  }
  function bindResults(out, list, use, show) {
    out.querySelectorAll("[data-r]").forEach((b) => {
      const x = list[+b.dataset.r];
      if (!touchOnly) b.addEventListener("mouseenter", () => show(x));
      b.addEventListener("click", () => use(x));
    });
  }

  function applyShape(geometry) {
    const n = selected;
    const own = n.area && areaById(n.area) && !usedBy(n.area, n).length;
    const id = own ? n.area : uniqueAreaId(n.id || slug(n.name));
    areas.features = areas.features.filter((f) => fid(f) !== id);
    areas.features.push({ type: "Feature", id, properties: { id }, geometry: roundDeep(geometry) });
    n.area = id;
    delete n.location;
    mode = "shape";
    preview(null);
    changed();
    renderLoc();
    flyTo(n);
  }

  /* ---------- Adding, moving, deleting ---------- */
  function addPlace(parent) {
    const n = { id: "", name: "", description: "", type: !isDistrict(parent) && guide.types[parent.type] ? parent.type : "landmark", tags: [] };
    (parent.places ||= []).push(n);
    fresh.add(n);
    filterEl.value = "";
    select(n, { fly: false });
    $("#f-name").focus();
  }
  $("#add-district").addEventListener("click", () => {
    const used = new Set(guide.districts.map((d) => String(d.color || "").toUpperCase()));
    const n = { id: "", name: "", description: "", color: PALETTE.find((c) => !used.has(c)) || PALETTE[0], tags: [], places: [] };
    guide.districts.push(n);
    fresh.add(n);
    filterEl.value = "";
    select(n, { fly: false });
    $("#f-name").focus();
  });
  function moveBy(n, dir) {
    const e = locate(n);
    const i = e.list.indexOf(n), j = i + dir;
    if (j < 0 || j >= e.list.length) return;
    [e.list[i], e.list[j]] = [e.list[j], e.list[i]];
    changed({ map: false });
  }
  function moveInto(n, target) {
    const e = locate(n);
    e.list.splice(e.list.indexOf(n), 1);
    (target.places ||= []).push(n);
    changed({ form: true });
  }
  function deleteNode(n) {
    const e = locate(n);
    const inside = [...walk(n.places)].length;
    const label = String(n.name || "").trim() || "this place";
    if (!quiet(n) && !confirm(`Delete “${label}”${inside ? ` and the ${inside} place${inside > 1 ? "s" : ""} inside it` : ""}?\n\nNothing changes on the site until you press Save.`)) return;
    e.list.splice(e.list.indexOf(n), 1);
    fresh.delete(n);
    selected = null;
    select(e.parent, { fly: false, push: false });
  }

  /* ---------- Save ---------- */
  function diff() {
    const flat = (g, a) => {
      const m = new Map();
      for (const { node, parent } of walk(g.districts)) {
        const { places, ...rest } = cleanNode(node);
        const shape = node.area ? JSON.stringify(a.features.find((f) => fid(f) === node.area)?.geometry ?? null) : "";
        m.set(node.id || node, { name: String(node.name || "").trim() || "Untitled", sig: JSON.stringify(rest) + shape, parent: parent?.id ?? null });
      }
      return m;
    };
    const before = flat(base.guide, base.areas), after = flat(guide, areas);
    const added = [], edited = [], moved = [], removed = [];
    for (const [id, x] of after) {
      const b = before.get(id);
      if (!b) added.push(x.name);
      else {
        if (b.sig !== x.sig) edited.push(x.name);
        if (b.parent !== x.parent) moved.push(x.name);
      }
    }
    for (const [id, b] of before) if (!after.has(id)) removed.push(b.name);
    const items = [
      ...added.map((n) => ["Added", n]), ...edited.map((n) => ["Edited", n]),
      ...moved.map((n) => ["Moved", n]), ...removed.map((n) => ["Removed", n]),
    ];
    const list = (a) => (a.length <= 2 ? a.join(" and ") : `${a.length} places`);
    const parts = [];
    if (added.length) parts.push(`Add ${list(added)}`);
    if (edited.length) parts.push(`Update ${list(edited)}`);
    if (moved.length) parts.push(`Move ${list(moved)}`);
    if (removed.length) parts.push(`Remove ${list(removed)}`);
    let message = parts.join("; ") || "Reorder places";
    if (message.length > 72) message = `Update guide (${items.length} changes)`;
    return { items, message };
  }

  const saveStatus = (text, kind = "") => {
    const el = $("#save-status");
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  };
  function openSave() {
    if (!dirty) return;
    report = validate();
    const { items, message } = diff();
    $("#change-list").innerHTML = items.length
      ? items.map(([k, n]) => `<li><span class="k">${k}</span> ${esc(n)}</li>`).join("")
      : `<li>Changed the order of places</li>`;
    const probs = [...report.errors.map((p) => ["error", p]), ...report.warnings.map((p) => ["warning", p])];
    $("#save-problems").innerHTML = probs.length
      ? `<ul class="problems">${probs.map(([lvl, p], i) =>
          `<li class="${lvl}"><button type="button" data-fix="${i}">${esc(String(p.n.name || "").trim() || "Untitled")}</button>: ${esc(p.msg)}</li>`).join("")}</ul>`
      : "";
    $("#save-problems").querySelectorAll("[data-fix]").forEach((b) => b.addEventListener("click", () => {
      saveDlg.close();
      select(probs[+b.dataset.fix][1].n);
    }));
    $("#commit-msg").value = message;
    const blocked = report.errors.length > 0;
    $("#publish").disabled = blocked || !connected();
    saveStatus(
      blocked ? "Fix the problems marked in red first."
        : !connected() ? (signInAvailable
            ? "Sign in with GitHub (the gear button) to publish. Your edits are kept while you do."
            : "Connect to GitHub (the gear button) to publish, or download the two files and replace them in the data folder.")
        : `Publishes to ${creds().repo} (${creds().branch || "main"}). The site updates about a minute later.`,
      blocked ? "err" : ""
    );
    saveDlg.showModal();
  }
  saveBtn.addEventListener("click", openSave);
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); openSave(); }
  });

  $("#publish").addEventListener("click", async () => {
    const btn = $("#publish");
    btn.disabled = true;
    try {
      const out = serialize(guide, areas);
      const files = [];
      if (out.guide !== base.norm.guide) files.push({ path: GUIDE_PATH, content: out.guide });
      if (out.areas !== base.norm.areas) files.push({ path: AREAS_PATH, content: out.areas });
      if (!files.length) return saveStatus("Nothing to save.");

      saveStatus("Checking GitHub…");
      const head = (await gh(`/git/ref/heads/${br()}`)).object.sha;
      if (head !== base.commit) {
        // Other commits (code changes, say) are fine, as long as nobody changed the guide itself.
        const [g, a] = await Promise.all([GUIDE_PATH, AREAS_PATH].map((p) => gh(`/contents/${p}?ref=${head}`, { raw: true })));
        if (g !== base.guideText || a !== base.areasText) {
          throw new Error("The guide was changed somewhere else after you opened this page (another device?). Download your version to keep it, then reload the page.");
        }
      }
      saveStatus("Saving…");
      const commit = await gh(`/git/commits/${head}`);
      const tree = await gh(`/git/trees`, post({
        base_tree: commit.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      }));
      const message = $("#commit-msg").value.trim() || diff().message;
      const created = await gh(`/git/commits`, post({ message, tree: tree.sha, parents: [head] }));
      await gh(`/git/refs/heads/${br()}`, post({ sha: created.sha, force: false }, "PATCH"));

      store.del(draftKey());
      base = makeBase({
        source: "github",
        commit: created.sha,
        guideText: files.find((f) => f.path === GUIDE_PATH)?.content ?? base.guideText,
        areasText: files.find((f) => f.path === AREAS_PATH)?.content ?? base.areasText,
      });
      changed();
      saveDlg.close();
      watchLive(files[0], created.html_url);
    } catch (e) {
      saveStatus(e.message, "err");
    } finally {
      btn.disabled = report.errors.length > 0 || !connected();
    }
  });

  // After a save, wait until Vercel serves the new file, so you know it's live.
  async function watchLive(file, commitUrl) {
    const viewCommit = ["View commit", () => open(commitUrl, "_blank", "noopener")];
    if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
      return showBanner("Saved to GitHub. Vercel publishes it in about a minute.", "ok", [viewCommit], "save");
    }
    showBanner("Saved to GitHub. Publishing to the site…", "ok", [viewCommit], "save");
    const until = Date.now() + 5 * 60e3;
    while (Date.now() < until) {
      await sleep(5000);
      try {
        const r = await fetch(`/${file.path}?v=${Date.now()}`, { cache: "no-store" });
        if (r.ok && (await r.text()) === file.content) {
          showBanner("Live on the site ✓", "ok", [["Open site", () => open("/" + (selected?.id ? "#" + selected.id : ""), "_blank", "noopener")]], "save");
          setTimeout(() => hideBanner("save"), 15000);
          return;
        }
      } catch { /* keep waiting */ }
    }
    showBanner("Saved to GitHub, but the site still shows the old version after 5 minutes. Check the deployment in Vercel.", "error", [viewCommit], "save");
  }

  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $("#download").addEventListener("click", async () => {
    const c = serialize(guide, areas);
    download("guide.json", c.guide);
    await sleep(500);
    download("areas.geojson", c.areas);
  });

  /* ---------- Settings ---------- */
  const setStatus = (text, kind = "") => {
    const el = $("#set-status");
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  };
  function openSettings() {
    $("#signin-box").hidden = !signInAvailable || !!session;
    $("#signed-box").hidden = !session;
    $("#signed-login").textContent = session ? "@" + (session.login || "you") : "";
    $("#pat-box").hidden = !!session;
    $("#pat-box").open = !signInAvailable && !session;
    $("#set-repo").value = settings.repo;
    $("#set-branch").value = settings.branch || "main";
    $("#set-token").value = settings.token;
    $("#set-forget").hidden = !settings.token;
    setStatus(session ? `Saving to ${creds().repo || "?"} (${creds().branch}).` : connected() ? `Connected to ${settings.repo} with a token.` : "");
    settingsDlg.showModal();
  }

  let leaving = false;
  function signIn() {
    writeDraft(); // edits come back after GitHub returns you here
    try { sessionStorage.setItem("cityGuide.admin.return", location.hash); } catch { /* fine */ }
    leaving = true;
    location.href = "/api/github?step=login";
  }
  $("#signin-btn").addEventListener("click", signIn);
  $("#signout-btn").addEventListener("click", async () => {
    try { await fetch("/api/github?step=logout", { method: "POST" }); } catch { /* cookies expire anyway */ }
    session = null;
    settingsDlg.close();
    renderStatus();
    showBanner("Signed out of GitHub on this device.", "", [["Sign in", signIn]]);
  });
  $("#settings-btn").addEventListener("click", openSettings);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  $("#set-save").addEventListener("click", async () => {
    const repo = $("#set-repo").value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
    const branch = $("#set-branch").value.trim() || "main";
    const token = $("#set-token").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return setStatus("Repository should look like owner/name.", "err");
    if (!token) return setStatus("Paste the access token.", "err");
    const prev = settings;
    settings = { repo, branch, token };
    setStatus("Checking…");
    let fromGh;
    try {
      fromGh = makeBase(await loadFromGitHub());
    } catch (e) {
      settings = prev;
      return setStatus(e.message, "err");
    }
    store.set(SETTINGS_KEY, settings);
    settingsDlg.close();
    hideBanner();
    const same = fromGh.norm.guide === base.norm.guide && fromGh.norm.areas === base.norm.areas;
    if (same || !dirty) {
      base = fromGh;
      if (!same) { guide = clone(base.guide); areas = clone(base.areas); selected = null; }
      changed({ form: true });
      offerDraft();
    } else {
      renderStatus();
      showBanner("Connected. The copy on GitHub is different from the one you're editing.", "error", [
        ["Load the GitHub copy (drops your edits)", () => {
          base = fromGh;
          guide = clone(base.guide);
          areas = clone(base.areas);
          selected = null;
          hideBanner();
          changed({ form: true });
        }],
      ]);
    }
  });
  $("#set-forget").addEventListener("click", () => {
    settings = { ...settings, token: "" };
    store.set(SETTINGS_KEY, settings);
    settingsDlg.close();
    renderStatus();
    showBanner("Token removed from this browser. You can still edit, but saving needs a connection.", "", [["Connect", openSettings]]);
  });

  addEventListener("beforeunload", (e) => {
    if (dirty && !leaving) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------- Start ---------- */
  changed({ form: true });
  const signinFailed = new URLSearchParams(location.search).get("signin") === "failed";
  if (signinFailed) history.replaceState(null, "", location.pathname + location.hash);
  if (loadErr) showBanner(`Couldn't load from GitHub: ${loadErr.message} Showing the published copy instead.`, "error", [["Settings", openSettings]]);
  else if (session && !creds().repo) showBanner("Signed in, but the editor doesn't know which repository to save to. Set GUIDE_REPO in Vercel's environment variables.", "error");
  else if (signinFailed) showBanner("GitHub sign-in didn't complete. Please try again.", "error", [["Sign in", signIn]]);
  else if (!connected()) {
    showBanner("Not connected to GitHub yet. You can edit, but saving needs a connection.", "",
      [signInAvailable ? ["Sign in with GitHub", signIn] : ["Connect", openSettings]]);
  } else {
    // Make sure this account may actually save, so it doesn't fail only at the end.
    gh("").then((r) => {
      if (r.permissions && !r.permissions.push) {
        showBanner(`${session?.login ? "@" + session.login : "This token"} can read ${creds().repo} but can't save to it.`, "error");
      }
    }).catch(() => {});
  }
  offerDraft();

  // Open the place from the link (#id), or the one you were on before signing in.
  function restoreSpot() {
    let hashId = location.hash;
    try {
      hashId ||= sessionStorage.getItem("cityGuide.admin.return") || "";
      sessionStorage.removeItem("cityGuide.admin.return");
    } catch { /* fine */ }
    const id = decodeURIComponent(hashId.slice(1));
    const node = id && nodes().find((e) => e.node.id === id)?.node;
    if (node) select(node, { push: false });
  }
  restoreSpot();
})();
