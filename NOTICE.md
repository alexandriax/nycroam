# Third-party notices

NYC Roam's own source code is [MIT](LICENSE). Much of what the repo *ships* is
not the code: the world under `public/` is built from public map and transit
data, and the fonts and audio come from elsewhere. Those carry their own terms,
which the MIT license does not and cannot relicense. This file is the full
inventory.

Short version for anyone reusing this: **keep the "© OpenStreetMap contributors"
credit visible**, and if you publish a modified world database, publish it under
ODbL.

---

## Map and transit data (`public/tiles/`, `public/geo/`, `public/subway/`)

See also [`public/DATA-LICENSE.txt`](public/DATA-LICENSE.txt), which travels with
the data itself.

### OpenStreetMap — ODbL 1.0

Buildings (including `building:part`), roads, parks and water, trees, subway
entrances, and bus stops are © OpenStreetMap contributors, licensed under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See <https://www.openstreetmap.org/copyright>.

The generated tiles are a **Derivative Database** under ODbL §4.4. Consequences
for this repo, and for forks:

- The attribution must be visible wherever the world is publicly displayed.
  The app carries a persistent bottom-left "© OpenStreetMap" credit linking to
  the copyright page ([`src/ui/NYCRoam.tsx`](src/ui/NYCRoam.tsx)), plus a source
  list on the welcome card and a per-building credit in the info modal
  ([`src/ui/InfoModal.tsx`](src/ui/InfoModal.tsx)). Don't remove them.
- Publicly using a modified version of the derived database triggers ODbL §4.6:
  offer the modified database under ODbL too.
- The *rendered images* (screenshots, video) are a Produced Work under §4.3 —
  attribution required, but ODbL share-alike does not reach them.

Raw data is fetched from the [Overpass API](https://overpass-api.de/) by
`scripts/fetch-osm.mjs`. Overpass instances are volunteer-funded; the fetcher
sends an identifying User-Agent, chunks its queries, backs off on rate limits,
and caches everything under `data/cache/` so a re-run costs nothing. Please
leave that behavior intact — see the
[Overpass usage policy](https://operations.osmfoundation.org/policies/overpass/).

### MTA

Subway station list and structure types (`Stations.csv`), and GTFS static feeds
for subway and bus route stop sequences and travel times, from
<https://www.mta.info/developers>. Published by the MTA for public use.

### NYC Open Data

Borough boundaries (used to clip the island ground to the real shoreline) and
2020 Neighborhood Tabulation Areas (the live location label), from
<https://opendata.cityofnewyork.us/>, under the
[NYC Open Data Terms of Use](https://www.nyc.gov/html/data/terms.html).

### USGS / AWS Terrain Tiles

Elevation from the Terrarium-encoded
[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) public dataset on
AWS, sourced from USGS and other public elevation surveys. Public domain /
attribution per the dataset's
[data sources list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

### Citi Bike (GBFS)

Public dock locations and capacities from the
[GBFS](https://gbfs.citibikenyc.com/gbfs/gbfs.json) `station_information` feed,
under the [Citi Bike Data Use Policy](https://citibikenyc.com/data-sharing-policy).

### OldNYC — Apache-2.0

Historic-photo deep links use marker coordinates from
[OldNYC](https://www.oldnyc.org/) by Dan Vanderkam
([github.com/danvk/oldnyc](https://github.com/danvk/oldnyc)), Apache-2.0 — full
text at [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).

**No NYPL images are redistributed.** Only coordinates are used, at build time,
to construct `#g:lat,lon` links out to oldnyc.org; the photographs are from the
NYPL Milstein Collection and remain NYPL's. See
[`public/geo/OLDNYC_NOTICE.txt`](public/geo/OLDNYC_NOTICE.txt).

### Wikipedia / Wikidata — CC BY-SA

Building summaries are fetched **live in the browser** from the Wikipedia REST
API using each building's OSM `wikidata`/`wikipedia` tag. Nothing is cached or
redistributed in this repo. Article text is
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); the info modal
credits it inline and links back to the article.

---

## Fonts (`public/fonts/`)

All three are [SIL Open Font License 1.1](https://openfontlicense.org/), with
their license texts bundled alongside the files:

| Font | Files | License text |
|---|---|---|
| Questrial | `questrial-latin*.woff2` | `public/fonts/OFL.txt` |
| Archivo Black | `archivo-black-latin*.woff2` | `public/fonts/OFL-ArchivoBlack.txt` |
| VT323 | `vt323-latin.woff2` | `public/fonts/OFL-VT323.txt` |

---

## Audio (`public/audio/`)

Sound effects were generated with the
[ElevenLabs Sound Effects](https://elevenlabs.io/sound-effects) tool and are
used under the ElevenLabs terms applicable to the generating account. They are
**not** covered by this repo's MIT license — if you fork this, generate or
source your own audio rather than assuming these are free to redistribute.

---

## Runtime dependencies

Installed from npm, not vendored here; see `package.json` and the license field
of each package.

| Package | License |
|---|---|
| [three](https://github.com/mrdoob/three.js) | MIT |
| [next](https://github.com/vercel/next.js) | MIT |
| [react](https://github.com/facebook/react), react-dom | MIT |
| [earcut](https://github.com/mapbox/earcut) | ISC |
| [pngjs](https://github.com/lukeapage/pngjs) | MIT |

---

## Artwork

The mascot, splash, favicon and Open Graph images (`assets/`, `app/icon.png`,
`app/apple-icon.png`, `app/favicon.ico`, `app/opengraph-image.jpg`,
`public/mark.png`) are project artwork by the author, MIT along with the rest of
the repo.

Station interiors, landmarks and street furniture are **procedurally generated
originals** — stylized approximations informed by public documentation of NYC
station layouts and building exteriors. No scanned models, photographs, or
third-party 3D assets are included anywhere in this repo.
