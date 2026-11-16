/* City guide: map + filterable catalogue.
 * Content lives in data/guide.json, shapes for areas/streets in data/areas.geojson.
 * No build step: this file runs as-is in the browser. */
(async function () {
  "use strict";

  const [guide, areas] = await Promise.all([
    fetch("data/guide.json").then((r) => r.json()),
    fetch("data/areas.geojson").then((r) => r.json()),
  ]);

  const TYPES = guide.types;
  const DISTRICT_TYPE = "neighbourhood";
  const typeOf = (t) => TYPES[t] || { label: t || "Place", color: "#868e96" };
  const areaById = Object.fromEntries(areas.features.map((f) => [f.id ?? f.properties.id, f]));

  document.title = guide.title;
  document.getElementById("title").textContent = guide.title;
  document.getElementById("subtitle").textContent = guide.subtitle || "";

  /* ---------- Flatten the nested guide into one list of items ---------- */
  const items = [];
  const byId = {};

  function addItem(raw, { district, parent, depth }) {
    const item = {
      id: raw.id || slug(raw.name),
      name: raw.name,
      description: raw.description || "",
      type: raw.type || (parent ? "landmark" : DISTRICT_TYPE),
      tags: raw.tags || [],
      location: Array.isArray(raw.location) ? raw.location : null, // a string = not geocoded yet
      area: raw.area ? areaById[raw.area] : null,
      mapsQuery: raw.mapsQuery,
      color: raw.color,
      parent,
      depth,
      children: [],
    };
    if (raw.area && !item.area) console.warn(`[guide] area "${raw.area}" not found in areas.geojson`);
    item.district = district || item;
    item.isDistrict = !district;
    item.kind = item.area
      ? /Line/.test(item.area.geometry.type) ? "line" : "area"
      : item.location ? "point" : "none";
    item.search = [item.name, item.description, item.tags.join(" "), typeOf(item.type).label]
      .join(" ")
      .toLowerCase();

    if (byId[item.id]) console.warn(`[guide] duplicate id "${item.id}"`);
    byId[item.id] = item;
    items.push(item);
    if (parent) parent.children.push(item);

    for (const child of raw.places || []) {
      addItem(child, { district: item.district, parent: item, depth: depth + 1 });
    }
    return item;
  }

  const districts = guide.districts.map((d) => addItem(d, { district: null, parent: null, depth: 0 }));

  // Items with no geometry of their own are shown at their nearest ancestor that has one.
  for (const item of items) {
    let a = item;
    while (a && a.kind === "none") a = a.parent;
    item.anchor = a || null;
  }

  const state = { types: new Set(), tags: new Set(), district: "all", q: "", selected: null };

  const phone = window.matchMedia("(max-width: 820px)");
  const isPhone = () => phone.matches;
  const touchOnly = window.matchMedia("(hover: none)").matches;

  /* ---------- Map ---------- */
  const home = { center: guide.map?.center || [52.37, 4.895], zoom: guide.map?.zoom || 13 };
  const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(home.center, home.zoom);
  L.control.zoom({ position: "topright" }).addTo(map);
  window.cityGuide = { map }; // handy for debugging in the browser console

  const styleUrl = () => `https://tiles.openfreemap.org/styles/${window.cityTheme?.isDark() ? "dark" : "positron"}`;
  const base = L.maplibreGL({
    style: styleUrl(),
    attribution:
      '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  }).addTo(map);
  window.addEventListener("themechange", () => base.getMaplibreMap().setStyle(styleUrl()));
  document.getElementById("theme").addEventListener("click", () => window.cityTheme?.toggle());

  // Panes keep districts at the bottom, then areas, streets, and dots on top.
  [["districts", 350], ["areas", 400], ["lines", 420], ["points", 450]].forEach(([name, z]) => {
    map.createPane(name).style.zIndex = z;
  });

  // District looks: "base" = overview (nothing selected), "focus" = the chosen district,
  // "context" = the others while a district or filter is active.
  const districtLooks = {
    base: { weight: 2, opacity: 0.9, fillOpacity: 0.28 },
    focus: { weight: 3, opacity: 1, fillOpacity: 0.1 },
    context: { weight: 1.5, opacity: 0.45, fillOpacity: 0.07 },
  };
  const styles = {
    district: (c, look, on) => ({
      pane: "districts", color: c, fillColor: c, ...districtLooks[look],
      ...(on && look !== "focus" ? { weight: districtLooks[look].weight + 1, fillOpacity: districtLooks[look].fillOpacity + 0.1 } : {}),
    }),
    area: (c, on) => ({ pane: "areas", color: c, weight: on ? 3.5 : 2, opacity: 0.95, fillColor: c, fillOpacity: on ? 0.35 : 0.2 }),
    line: (c, on) => ({ pane: "lines", color: c, weight: on ? 9 : 6, opacity: on ? 1 : 0.8, lineCap: "round", lineJoin: "round" }),
    point: (c, on) => ({ pane: "points", radius: on ? 10 : 7, color: "#fff", weight: on ? 3 : 2, fillColor: c, fillOpacity: 1 }),
  };

  const colorOf = (item) => item.color || typeOf(item.type).color;
  const filtering = () => state.types.size > 0 || state.tags.size > 0 || !!state.q;

  function districtLook(item) {
    if (state.district === item.id) return "focus";
    if (state.selected && byId[state.selected].district === item && !byId[state.selected].isDistrict) return "focus";
    if (state.district !== "all" || (state.selected && !byId[state.selected].isDistrict)) return "context";
    return !filtering() || matches(item) ? "base" : "context";
  }

  function styleFor(item, on) {
    if (item.isDistrict) return styles.district(colorOf(item), districtLook(item), on);
    return styles[item.kind](colorOf(item), on);
  }

  for (const item of items) {
    if (item.kind === "none") continue;
    let layer;
    if (item.kind === "point") {
      layer = L.circleMarker(item.location, styleFor(item, false));
    } else {
      // Unwrap the single path layer that L.geoJSON creates.
      layer = L.geoJSON(item.area, { style: () => styleFor(item, false) }).getLayers()[0];
      layer.options.pane = styleFor(item, false).pane;
    }
    if (item.isDistrict) {
      layer.bindTooltip(escapeHtml(item.name), { permanent: true, direction: "center", className: "district-label" });
    } else if (!touchOnly) {
      layer.bindTooltip(escapeHtml(item.name), {
        sticky: item.kind !== "point",
        direction: "top",
        offset: item.kind === "point" ? [0, -8] : [0, -6],
      });
    }
    layer.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      // Clicking a district zooms into it; clicking a place just opens its card.
      if (item.isDistrict) select(item.id);
      else select(item.id, { fly: false, latlng: item.kind === "point" ? null : e.latlng });
    });
    layer.on("mouseover", () => highlightCard(item.id, true));
    layer.on("mouseout", () => highlightCard(item.id, false));
    item.layer = layer;
  }

  const districtBounds = L.featureGroup(districts.map((d) => d.layer).filter(Boolean)).getBounds();
  const goHome = (animate) => {
    const opts = { ...mapPadding(sheet.visibleHeight()), maxZoom: 14 };
    animate ? map.flyToBounds(districtBounds, { ...opts, duration: 0.6 }) : map.fitBounds(districtBounds, opts);
  };

  // Padding that keeps things out from under the phone's bottom sheet / detail card.
  function mapPadding(bottom = 0) {
    return isPhone()
      ? { paddingTopLeft: [20, 70], paddingBottomRight: [20, bottom + 20] }
      : { padding: [30, 30] };
  }

  /* ---------- Filters ---------- */

  const matches = (item, ignore) =>
    (ignore === "type" || state.types.size === 0 || state.types.has(item.type)) &&
    (ignore === "tag" || [...state.tags].every((t) => item.tags.includes(t))) &&
    (state.district === "all" || item.district.id === state.district) &&
    (!state.q || item.search.includes(state.q));

  const typeChips = document.getElementById("type-chips");
  const tagChips = document.getElementById("tag-chips");
  const districtSelect = document.getElementById("district-select");
  const search = document.getElementById("search");
  const listEl = document.getElementById("list");
  const countEl = document.getElementById("count");
  const clearBtn = document.getElementById("clear");
  const countMobile = document.getElementById("count-mobile");
  const backPill = document.getElementById("back-pill");
  const panel = document.getElementById("panel");
  const sheet = createSheet();
  const detail = createDetail();

  const TAGS_COLLAPSED = 10;
  const allTags = [...new Set(items.flatMap((i) => i.tags))];

  districtSelect.innerHTML =
    `<option value="all">All areas</option>` +
    districts.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("");

  function renderChips() {
    const typeCounts = countBy(items.filter((i) => matches(i, "type")), (i) => [i.type]);
    typeChips.innerHTML = Object.keys(TYPES)
      .filter((t) => items.some((i) => i.type === t))
      .map((t) => {
        const on = state.types.has(t);
        const n = typeCounts[t] || 0;
        return `<button class="chip" type="button" data-type="${t}" aria-pressed="${on}" ${!n && !on ? 'style="opacity:.45"' : ""}>
          <span class="dot" style="background:${TYPES[t].color}"></span>${escapeHtml(TYPES[t].label)} <span class="n">${n}</span></button>`;
      })
      .join("");

    const tagCounts = countBy(items.filter((i) => matches(i, "tag")), (i) => i.tags);
    const tags = allTags
      .filter((t) => state.tags.has(t) || tagCounts[t])
      .sort((a, b) => (tagCounts[b] || 0) - (tagCounts[a] || 0) || a.localeCompare(b));
    const shown = state.showAllTags ? tags : tags.filter((t, i) => i < TAGS_COLLAPSED || state.tags.has(t));
    tagChips.innerHTML =
      shown
        .map((t) => {
          const on = state.tags.has(t);
          return `<button class="chip" type="button" data-tag="${escapeHtml(t)}" aria-pressed="${on}">#${escapeHtml(t)} <span class="n">${tagCounts[t] || 0}</span></button>`;
        })
        .join("") +
      (tags.length > TAGS_COLLAPSED
        ? `<button class="chip chip-more" type="button" data-more>${state.showAllTags ? "Show less" : `+${tags.length - shown.length} more`}</button>`
        : "");
  }

  function renderList() {
    const visible = new Set(items.filter((i) => matches(i)).map((i) => i.id));
    let html = "";
    for (const d of districts) {
      const group = items.filter((i) => i.district === d && visible.has(i.id));
      if (!group.length) continue;
      html += `<div class="group-head"><span class="swatch" style="background:${colorOf(d)}"></span>${escapeHtml(d.name)}</div>`;
      html += group.map(cardHtml).join("");
    }
    listEl.innerHTML = html || `<div class="empty">Nothing matches these filters.</div>`;

    const n = [...visible].length;
    countEl.textContent = countMobile.textContent = `${n} place${n === 1 ? "" : "s"}`;
    clearBtn.hidden = !(filtering() || state.district !== "all");
    updateMap();
  }

  /* Map rules:
   *  - Overview (no district, no filter): only the districts are drawn.
   *  - A tag / type / search filter is on: matching places appear.
   *  - A district is chosen: everything in it appears (narrowed by any filters).
   *  - The selected place is always shown, even if filters would hide it. */
  function updateMap() {
    const showPlaces = filtering() || state.district !== "all";
    const onMap = new Set();
    const add = (item) => {
      onMap.add(item.id);
      if (item.anchor) onMap.add(item.anchor.id); // e.g. Starbucks → its station
    };
    if (showPlaces) for (const item of items) if (!item.isDistrict && matches(item)) add(item);
    if (state.selected) {
      const sel = byId[state.selected];
      add(sel);
      if (!sel.isDistrict) sel.children.forEach(add); // e.g. Dam Square → Royal Palace, Nieuwe Kerk…
      if (sel.parent && !sel.parent.isDistrict) add(sel.parent); // and the other way round, for context
    }

    backPill.hidden = state.district === "all";
    const labels = state.district === "all" && !filtering() && !state.selected;
    for (const item of items) {
      if (!item.layer) continue;
      const show = item.isDistrict || onMap.has(item.id);
      if (show && !map.hasLayer(item.layer)) item.layer.addTo(map);
      if (!show && map.hasLayer(item.layer)) item.layer.remove();
      item.layer.setStyle(styleFor(item, item.id === state.selected));
      if (item.isDistrict) labels ? item.layer.openTooltip() : item.layer.closeTooltip();
    }
    declutterLabels();
  }

  // Hide district labels that would overlap another one (they come back as you zoom in).
  function declutterLabels() {
    const placed = [];
    for (const d of districts) {
      const el = d.layer?.getTooltip()?.getElement();
      if (!el || !d.layer.isTooltipOpen()) continue;
      el.style.visibility = "";
      const r = el.getBoundingClientRect();
      const hit = placed.some((p) => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top);
      if (hit) el.style.visibility = "hidden";
      else placed.push(r);
    }
  }
  map.on("zoomend moveend", declutterLabels);

  function cardHtml(item) {
    const t = typeOf(item.type);
    const shape = item.isDistrict || item.kind === "area" ? "area" : item.kind === "line" ? "line" : "";
    const meta = [t.label];
    if (item.parent && !item.parent.isDistrict) meta.push(`in ${item.parent.name}`);
    return `<div class="card${item.depth > 1 ? " child" : ""}${item.id === state.selected ? " selected" : ""}"
        role="listitem" tabindex="0" data-id="${escapeHtml(item.id)}">
      <span class="dot ${shape}" style="background:${colorOf(item)}"></span>
      <div class="card-title">${escapeHtml(item.name)}</div>
      <div class="card-meta">${escapeHtml(meta.join(" · "))}</div>
      ${item.description ? `<div class="card-desc">${escapeHtml(item.description)}</div>` : ""}
      ${item.tags.length ? `<div class="card-tags">${item.tags.map((x) => `<span class="tag">#${escapeHtml(x)}</span>`).join("")}</div>` : ""}
    </div>`;
  }

  function render() {
    renderChips();
    renderList();
  }

  /* ---------- Selection + popup ---------- */
  const popup = L.popup({ maxWidth: 320, autoPanPadding: [24, 24], closeButton: true });
  popup.on("remove", clearSelection);

  function clearSelection() {
    if (!state.selected) return;
    state.selected = null;
    listEl.querySelector(".card.selected")?.classList.remove("selected");
    history.replaceState(null, "", location.pathname + location.search);
    updateMap();
  }

  function select(id, { fly = true, latlng = null } = {}) {
    const item = byId[id];
    if (!item) return;

    state.selected = id;
    if (item.isDistrict && state.district !== id) {
      state.district = id;
      districtSelect.value = id;
      render();
    } else {
      updateMap();
    }
    if (item.layer?.bringToFront && !item.isDistrict) item.layer.bringToFront();
    history.replaceState(null, "", `#${encodeURIComponent(id)}`);

    listEl.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
    const card = listEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (card) {
      card.classList.add("selected");
      card.scrollIntoView({ block: "nearest" });
    }

    const anchor = item.anchor;

    // Phones: show details in a bottom card and keep the place visible above it.
    if (isPhone()) {
      const h = detail.open(item);
      if (!anchor) return;
      const pad = mapPadding(h);
      if (!fly) return map.panInside(latlng || anchorPoint(anchor), pad);
      const bounds = anchor.kind === "point" ? L.latLngBounds([anchor.location, anchor.location]) : anchor.layer.getBounds();
      const maxZoom = anchor.kind === "point" ? Math.max(map.getZoom(), 16) : 17;
      return map.flyToBounds(bounds, { ...pad, maxZoom, duration: 0.6 });
    }

    if (!anchor) return;
    const at = latlng || anchorPoint(anchor);
    const open = () => {
      popup.setLatLng(at).setContent(popupHtml(item));
      if (!map.hasLayer(popup)) popup.openOn(map);
    };

    if (!fly) return open();
    if (anchor.kind === "point") {
      map.flyTo(anchor.location, Math.max(map.getZoom(), 16), { duration: 0.6 });
    } else {
      map.flyToBounds(anchor.layer.getBounds(), { ...mapPadding(), maxZoom: 17, duration: 0.6 });
    }
    map.once("moveend", open);
  }

  function anchorPoint(item) {
    if (item.kind === "point") return L.latLng(item.location);
    if (item.kind === "area") {
      try { return item.layer.getCenter(); } catch { /* not rendered yet */ }
    }
    return item.layer.getBounds().getCenter();
  }

  function popupHtml(item) {
    const t = { ...typeOf(item.type), color: colorOf(item) };
    const crumbs = [];
    for (let p = item.parent; p; p = p.parent) crumbs.unshift(p);
    const sub = item.children;
    const q = item.mapsQuery || `${(item.kind === "none" && item.anchor ? item.anchor : item).name}, ${guide.city}`;
    return `<div class="pop">
      <div class="pop-type" style="color:${t.color}"><span class="dot" style="background:${t.color}"></span>${escapeHtml(t.label)}</div>
      <h3>${escapeHtml(item.name)}</h3>
      ${crumbs.length ? `<div class="crumbs">${crumbs.map((c) => `<button data-select="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`).join(" › ")}</div>` : ""}
      ${item.description ? `<p>${escapeHtml(item.description)}</p>` : `<p class="muted">No notes yet.</p>`}
      ${item.tags.length ? `<div class="tags">${item.tags.map((x) => `<span class="tag">#${escapeHtml(x)}</span>`).join("")}</div>` : ""}
      ${sub.length ? `<div class="sub"><div class="sub-title">${item.isDistrict ? "Places here" : "Also here"}</div>
        ${sub.map((c) => `<button data-select="${escapeHtml(c.id)}"><span class="dot" style="background:${typeOf(c.type).color}"></span>${escapeHtml(c.name)}</button>`).join("")}</div>` : ""}
      ${item.isDistrict ? "" : `<div class="actions"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}" target="_blank" rel="noopener">Open in Google Maps ↗</a></div>`}
    </div>`;
  }

  function highlightCard(id, on) {
    listEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.classList.toggle("hover", on);
  }

  /* ---------- Events ---------- */
  typeChips.addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    toggle(state.types, b.dataset.type);
    render();
  });
  tagChips.addEventListener("click", (e) => {
    if (e.target.closest("[data-more]")) {
      state.showAllTags = !state.showAllTags;
      return renderChips();
    }
    const b = e.target.closest("[data-tag]");
    if (!b) return;
    toggle(state.tags, b.dataset.tag);
    render();
  });
  districtSelect.addEventListener("change", () => {
    if (districtSelect.value === "all") return showAllDistricts();
    select(districtSelect.value);
  });
  let searchTimer;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = search.value.trim().toLowerCase();
      render();
    }, 120);
  });
  clearBtn.addEventListener("click", () => {
    resetFilters(false);
    showAllDistricts();
  });

  function showAllDistricts() {
    state.district = "all";
    districtSelect.value = "all";
    map.closePopup();
    detail.close();
    render();
    goHome(true);
  }

  backPill.addEventListener("click", showAllDistricts);
  search.addEventListener("focus", () => isPhone() && sheet.snap("full"));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { search.blur(); if (isPhone()) sheet.snap("half"); }
  });
  map.on("click", () => isPhone() && detail.close()); // tap on empty map closes details

  /* ---------- Locate me ---------- */
  const locateBtn = document.getElementById("locate");
  let meLayer = null;
  locateBtn.addEventListener("click", () => {
    locateBtn.classList.add("busy");
    map.locate({ enableHighAccuracy: true, timeout: 10000 });
  });
  map.on("locationfound", (e) => {
    locateBtn.classList.remove("busy");
    locateBtn.classList.add("active");
    meLayer?.remove();
    meLayer = L.layerGroup([
      L.circle(e.latlng, { radius: e.accuracy, pane: "points", color: "#1c7ed6", weight: 1, fillOpacity: 0.08, interactive: false }),
      L.circleMarker(e.latlng, { radius: 7, pane: "points", color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1, interactive: false }),
    ]).addTo(map);
    map.flyTo(e.latlng, Math.max(map.getZoom(), 15), { duration: 0.6 });
  });
  map.on("locationerror", (e) => {
    locateBtn.classList.remove("busy");
    locateBtn.title = `Location unavailable: ${e.message}`;
    console.warn("[guide] location:", e.message);
  });

  /* ---------- Phone bottom sheet ---------- */
  function createSheet() {
    const top = panel.querySelector(".sheet-top");
    let current = "peek";
    let previous = "peek";

    const peekHeight = () => typeChips.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 12;
    const offsets = () => {
      const h = panel.offsetHeight;
      return { full: 0, half: Math.max(0, h - window.innerHeight * 0.5), peek: h - peekHeight(), hidden: h + 30 };
    };
    const apply = (px) => (panel.style.transform = `translateY(${px}px)`);

    function snap(name) {
      if (!isPhone()) return;
      if (name !== "hidden" && current !== "hidden") previous = name;
      if (current !== "hidden" && name === "hidden") previous = current;
      current = name;
      panel.dataset.snap = name;
      apply(offsets()[name]);
    }

    // Drag the top strip (title + grabber) to move the sheet; tap it to step through sizes.
    let drag = null;
    top.addEventListener("pointerdown", (e) => {
      if (!isPhone()) return;
      drag = { y: e.clientY, t: performance.now(), start: offsets()[current], moved: false };
      top.setPointerCapture(e.pointerId);
      panel.classList.add("dragging");
    });
    top.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 5) drag.moved = true;
      const o = offsets();
      apply(Math.min(Math.max(drag.start + dy, o.full), o.peek));
    });
    const end = (e) => {
      if (!drag) return;
      panel.classList.remove("dragging");
      const o = offsets();
      const dy = e.clientY - drag.y;
      const v = dy / Math.max(1, performance.now() - drag.t); // px per ms
      const pos = drag.start + dy;
      const order = ["full", "half", "peek"];
      let target;
      if (!drag.moved) target = { peek: "half", half: "full", full: "peek" }[current] || "half";
      else if (Math.abs(v) > 0.5) {
        const i = order.indexOf(current);
        target = order[Math.max(0, Math.min(order.length - 1, i + (v > 0 ? 1 : -1)))];
      } else target = order.reduce((a, b) => (Math.abs(o[a] - pos) < Math.abs(o[b] - pos) ? a : b));
      drag = null;
      snap(target);
    };
    top.addEventListener("pointerup", end);
    top.addEventListener("pointercancel", end);
    window.addEventListener("resize", () => isPhone() && snap(current));

    return {
      snap,
      restore: () => snap(previous || "peek"),
      reset: () => { panel.style.transform = ""; panel.classList.remove("dragging"); },
      visibleHeight: () => (isPhone() ? panel.offsetHeight - offsets()[current] : 0),
    };
  }

  /* ---------- Phone detail card ---------- */
  function createDetail() {
    const el = document.getElementById("detail");
    const body = document.getElementById("detail-body");
    let isOpen = false;

    function open(item) {
      body.innerHTML = popupHtml(item);
      el.scrollTop = 0;
      el.classList.add("open");
      if (!isOpen) sheet.snap("hidden");
      isOpen = true;
      return el.offsetHeight;
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      el.classList.remove("open");
      sheet.restore();
      clearSelection();
    }
    document.getElementById("detail-close").addEventListener("click", close);

    // Swipe the card down to dismiss.
    let y0 = null;
    el.addEventListener("touchstart", (e) => { y0 = el.scrollTop === 0 ? e.touches[0].clientY : null; }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (y0 === null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0) el.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      el.style.transform = "";
      y0 = null;
      if (dy > 90) close();
    });

    return { open, close, isOpen: () => isOpen };
  }

  phone.addEventListener?.("change", () => {
    map.closePopup();
    detail.close();
    sheet.reset();
    if (isPhone()) sheet.snap("peek");
    placeControls();
  });

  function placeControls() {
    map.attributionControl.setPosition(isPhone() ? "topright" : "bottomright");
  }

  listEl.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) select(card.dataset.id);
  });
  listEl.addEventListener("keydown", (e) => {
    const card = e.target.closest(".card");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      select(card.dataset.id);
    }
  });
  listEl.addEventListener("mouseover", (e) => hoverLayer(e, true));
  listEl.addEventListener("mouseout", (e) => hoverLayer(e, false));

  function hoverLayer(e, on) {
    const card = e.target.closest(".card");
    if (!card || card.contains(e.relatedTarget)) return;
    const item = byId[card.dataset.id]?.anchor;
    if (item?.layer && item.id !== state.selected && map.hasLayer(item.layer)) {
      item.layer.setStyle(styleFor(item, on));
    }
  }

  // Links inside popups / the phone detail card ("Also here", breadcrumbs). Leaflet stops click propagation
  // out of popups, so listen in the capture phase.
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".leaflet-popup [data-select], .detail [data-select]");
    if (b) select(b.dataset.select);
  }, true);

  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== state.selected) select(id);
  });

  function resetFilters(includeDistrict) {
    state.types.clear();
    state.tags.clear();
    state.q = "";
    search.value = "";
    if (includeDistrict) {
      state.district = "all";
      districtSelect.value = "all";
    }
  }

  /* ---------- Start ---------- */
  render();
  placeControls();
  if (isPhone()) sheet.snap("peek");
  goHome(false);
  const initial = decodeURIComponent(location.hash.slice(1));
  if (initial && byId[initial]) select(initial);

  /* ---------- Helpers ---------- */
  function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }
  function countBy(list, keys) {
    const out = {};
    for (const x of list) for (const k of keys(x)) out[k] = (out[k] || 0) + 1;
    return out;
  }
  function slug(s) { return String(s).toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, ""); }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
})();
