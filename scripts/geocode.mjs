#!/usr/bin/env node
/**
 * Fills in coordinates and shapes in data/guide.json using OpenStreetMap (Nominatim).
 *
 *   "location": "Herengracht 386, Amsterdam"        → replaced with [lat, lng]
 *   "area": "search:Westerpark, Amsterdam"          → shape saved to data/areas.geojson,
 *                                                     "area" replaced with the place id
 *
 * Usage:  node scripts/geocode.mjs
 * Needs Node 18+. No dependencies. Respects Nominatim's 1 request/second limit.
 */
import { readFile, writeFile } from "node:fs/promises";

const GUIDE = new URL("../data/guide.json", import.meta.url);
const AREAS = new URL("../data/areas.geojson", import.meta.url);
const UA = "city-guide-geocoder/1.0";

const guide = JSON.parse(await readFile(GUIDE, "utf8"));
const areas = JSON.parse(await readFile(AREAS, "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 1e6) / 1e6;
const roundDeep = (g) => JSON.parse(JSON.stringify(g, (_, v) => (typeof v === "number" ? round(v) : v)));
// Pretty JSON that keeps short arrays/objects (coordinates, tags, types) on one line.
const pretty = (obj) =>
  JSON.stringify(obj, null, 2).replace(/[\[{][^\[\]{}]*[\]}]/g, (m) => {
    const flat = m.replace(/\s*\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]");
    return flat.length <= 90 ? flat : m;
  });
const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");

async function search(q, withShape) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ q, format: "jsonv2", limit: "1", ...(withShape ? { polygon_geojson: "1" } : {}) });
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  await sleep(1100);
  if (!res.ok) throw new Error(`Nominatim ${res.status} for "${q}"`);
  return (await res.json())[0];
}

let changed = 0;
const todo = [];
(function walk(list) {
  for (const p of list || []) {
    todo.push(p);
    walk(p.places);
  }
})(guide.districts);

for (const p of todo) {
  if (typeof p.location === "string") {
    const r = await search(p.location, false);
    if (!r) { console.warn(`✗ ${p.name}: nothing found for "${p.location}"`); continue; }
    p.location = [round(+r.lat), round(+r.lon)];
    console.log(`✓ ${p.name} → ${p.location.join(", ")}  (${r.display_name.slice(0, 70)})`);
    changed++;
  }
  if (typeof p.area === "string" && p.area.startsWith("search:")) {
    const q = p.area.slice("search:".length).trim();
    const r = await search(q, true);
    if (!r?.geojson || r.geojson.type === "Point") { console.warn(`✗ ${p.name}: no shape found for "${q}"`); continue; }
    const id = p.id || slug(p.name);
    areas.features = areas.features.filter((f) => f.id !== id);
    areas.features.push({ type: "Feature", id, properties: { id }, geometry: roundDeep(r.geojson) });
    p.id = id;
    p.area = id;
    console.log(`✓ ${p.name} → ${r.geojson.type} saved as "${id}"  (${r.display_name.slice(0, 70)})`);
    changed++;
  }
}

if (changed) {
  await writeFile(GUIDE, pretty(guide) + "\n");
  await writeFile(AREAS, JSON.stringify(areas) + "\n");
  console.log(`\nUpdated ${changed} place(s). Check them on the map — OSM search can pick the wrong match.`);
} else {
  console.log("Nothing to geocode. Put an address string in \"location\", or \"search:…\" in \"area\".");
}
