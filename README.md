# City guide

A static map + catalogue of places. No build step, no dependencies — just HTML, CSS and JS.

```
index.html          page
app.js              map, filters, list
styles.css          styling (light + dark)
admin/              editor page at /admin (edits the data files, saves to GitHub)
api/github.mjs      “Sign in with GitHub” for the editor (Vercel function)
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

## Editing in the browser: /admin

Open `yoursite.com/admin` (or `localhost:3000/admin` locally). You can add, edit, move and delete places,
set pins by tapping the map, searching an address or pasting a Google Maps link, and pick areas or streets
from OpenStreetMap. It works on a phone too.

**Save** commits `data/guide.json` and `data/areas.geojson` to GitHub, and Vercel redeploys the site
(this needs the Vercel project connected to the GitHub repo). You sign in with the **Sign in with GitHub** button
and stay signed in on that device.

### One-time setup for “Sign in with GitHub”

1. **Create a GitHub App** at <https://github.com/settings/apps/new>:
   - **Name:** anything unique, for example “My Amsterdam editor”
   - **Homepage URL:** `https://YOUR-SITE`
   - **Callback URL:** `https://YOUR-SITE/api/github`
   - **Expire user authorization tokens:** leave ticked
   - **Webhook → Active:** untick
   - **Repository permissions → Contents:** Read and write (nothing else)
   - **Where can this GitHub App be installed:** Only on this account
2. On the App's page, copy the **Client ID**, then **Generate a new client secret** and copy it.
3. **Install App** (left menu) → Only select repositories → this repo.
4. In Vercel → Project → Settings → **Environment Variables**, add
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and optionally `GUIDE_REPO` = `owner/name`
   (otherwise the repo Vercel deploys from is used) and `GUIDE_BRANCH` (default `main`). Then redeploy.

How it stays safe: the App only has access to this one repository, and a signed-in person can only save if their
GitHub account may edit it, so anyone else who finds `/admin` can't change anything. The sign-in is kept in
HttpOnly cookies that page scripts can't read; the editor only gets an access token that expires after 8 hours and
is renewed automatically (sign-ins last 6 months of inactivity). Sign out from the gear button, or revoke access
on GitHub under Settings → Applications.

Every save is a normal commit, so any change can be reverted on GitHub, and Vercel's *Instant Rollback* restores an
earlier version of the site. Unsaved edits are kept in the browser as a draft, and saving is refused if the guide
was changed elsewhere in the meantime, so nothing gets overwritten.

**Without the App** (for example locally with `npx serve`, where `/api` doesn't run): use *Use an access token
instead* in the gear dialog with a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
limited to this repo with Contents: Read and write, or edit and use **Download files** to replace the two files in
`data/` by hand. `vercel dev` runs the sign-in locally too, if you add `http://localhost:3000/api/github` as a
second callback URL.

## Editing the JSON by hand

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
