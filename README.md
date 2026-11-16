# City guide

A static map + catalogue of places. No build step, no dependencies — just HTML, CSS and JS.

```
index.html          page
app.js              map, filters, list
styles.css          styling (light + dark)
data/guide.json     ← your content: districts, places, descriptions, types, tags
data/areas.geojson  shapes for districts, squares, parks and streets
scripts/geocode.mjs helper that looks up coordinates/shapes for new places
```

## Run locally

```sh
npx serve .
```
(Opening `index.html` directly from disk won't work — browsers block loading the JSON files.)

## Deploy to Vercel

```sh
vercel          # preview
vercel --prod   # production
```
Or push the folder to GitHub and import it at vercel.com/new — framework preset “Other”, no build command.

## Editing the guide

Everything is in `data/guide.json`. Districts contain `places`, and any place can contain its own `places`
(e.g. *Dam Square → Royal Palace*).

```jsonc
{
  "id": "anne-frank-house",            // unique, used in links: yoursite.com/#anne-frank-house
  "name": "Anne Frank House",
  "description": "Book tickets in advance",
  "type": "museum",                    // one of the keys in "types" — drives colour + Type filter
  "tags": ["book ahead", "WWII"],      // free-form — every tag becomes a filter chip
  "location": [52.375156, 4.884081],   // a dot on the map…
  "area": "vondelpark",                // …or a shape from areas.geojson (polygon or street line)
  "mapsQuery": "…"                     // optional: custom Google Maps search
}
```

- **Dot or shape?** Use `location` for a single spot, `area` for a district, square, park or street.
- **No `location` or `area`?** The place is shown at its parent (e.g. *Starbucks in old waiting room* → Centraal Station).
- **New type?** Add it to `"types"` with a label and colour.

### Adding places without looking up coordinates

Put an address or name as a string, then run the helper:

```jsonc
"location": "Westerpark, Amsterdam"          // → becomes [lat, lng]
"area": "search:Westerpark, Amsterdam"        // → shape saved to areas.geojson
```

```sh
node scripts/geocode.mjs
```

It uses OpenStreetMap search, which occasionally picks the wrong match — check the result on the map.
For a custom shape, draw it at [geojson.io](https://geojson.io), and paste the feature into `data/areas.geojson`
with `"id": "your-area-id"`.

Map data © OpenStreetMap contributors, base map by OpenFreeMap (free, no API key).
