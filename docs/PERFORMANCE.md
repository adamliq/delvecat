# Performance at scale

Licoryx Delvecat is measured against a synthetic catalog the size of a large Splunk
estate, built through the real ingestion pipeline (`delvecat-ingest synth`).
At scale 1.0 it has 88,300 objects and 292,000 relationships: 200 apps, 600
indexes, 1,500 sourcetypes with about 25 fields each (37,000 fields), 20,000
hosts, 12,000 saved searches, 2,000 detections, 3,000 dashboards, 300 roles
and 5,000 users. The output is deterministic for a given seed and scale.

```sh
make perf               # generate, build, serve and time every page (needs Playwright)
make perf SCALE=0.25    # a smaller run
cd ingestion && uv run delvecat-ingest synth --scale 2 --out /tmp/big --shard --validate
```

## 300,000 objects and 2 million relationships

The largest size tested, and the figures shown on the Help page ("Tested size and
limits"):

```sh
cd ingestion && uv run delvecat-ingest synth --scale 3.4 --host-indexes 16 --out ../web/.large --shard
```

301,405 objects and 2,025,265 relationships: 68,000 hosts each sending to about 16
indexes, 40,800 saved searches, 6,800 detections, 10,200 dashboards, 17,000 users,
122,861 fields. Measured on 4 cores and 15 GB, headless Chromium, Splunk 10.4.

| Step | 0.41.0 | 0.42.0 |
|---|---:|---:|
| Build (generate, assemble, governance, quality, write) | 75 s, 2.2 GB peak | 75 s, 1.8 GB peak |
| Schema validation (`delvecat-ingest validate`, part of every `build`) | 167 s | **29 s** |
| Size on disk | 383 MB (edges 216 MB) | **211 MB (edges 44 MB)** |
| Published into Splunk (`delvecat-ingest publish`) | 32 s, 2.8 GB peak, 27.1 MB | 42 s, **1.7 GB peak**, 26.0 MB |
| First load, served directly | 12.8 s, 990 MB heap | **6.2 s, 590 MB** |
| Opening in Splunk Web, first time | 16.7 s, about 1 GB | **6.8 s, 630 MB** |
| Opening in Splunk Web again | 16.7 s | **5.7 s** (copy kept in the browser) |
| Search right after opening | 2 s (after the 13 s load) | **0.4 s** quick results; full text about 8 s later |
| Browse with facets | 0.9–1.5 s | about 1 s |
| Object pages | 0.01–0.6 s | 0.1–0.6 s |
| Health, Findings, Coverage, Changes, Domains, Glossary | 0.03–0.14 s | 0.1–0.3 s |
| Schemas, Governance, Insights | 0.8–1.9 s | 1.1–2.0 s |
| SQL console ready (Run usable) | 30 s, page frozen 29 s | **0.8 s** |
| SQL: first query on entities / using edges / later | (all loaded up front) | 1.9 s / 9.7 s / 0.2–1 s |

What changed:

- **SQL console**: tables are created empty and each is filled the first time a query
  names it, in batches of 20,000 with the page responding in between (longest pause
  while indexing edges: 2 s). Before, every table (2.3 million rows) was copied in
  before Run could be used. (The 0.41.0 report said the console did not open at this
  size; that was the test waiting for an element the page no longer has. It did open,
  after 30 frozen seconds.)
- **First load**: the full-text index (5 s of the 12.5 s load) is built after the page
  appears, in small batches while the browser is idle. A search typed before it is
  complete answers at once from names, apps and descriptions, says so, and updates
  when the index is ready. The loading screen names each step.
- **Kept in the browser** (Splunk app): the compressed catalog is stored in IndexedDB,
  keyed by generation and checksum. Splunk is asked for the current pointer first
  (access is checked as before); the copy is used only while it is that generation,
  and is removed when no catalog is published or access is refused. On a Splunk on the
  same machine the gain is small (1 s); it saves the download on slower links.
- **Compact relationships** (schema 0.2.0 on disk): ids once, four integers per edge.
  Readers expand them to the usual form; older readers refuse 0.2 files with
  "Unsupported schema version" instead of showing a catalog without relationships.
- **Validation**: edges are checked directly against the schema's own rules (types and
  origins read from it); entities are validated in jobs of 20,000, in parallel
  processes above 40,000. Same messages and positions as before.
- **Publishing and writing** stream the JSON into gzip or the file a piece at a time
  (byte-identical output), so the whole text is never held at once. Generating it in
  pieces is slower (42 s against 32 s).

## Web app (headless Chromium, 1280×900)

Time from navigation until the page has rendered. Before = the code before
this work (with the loading fix below, without which nothing loaded at all).

| Page | Before | After |
|---|---:|---:|
| First load (download, verify, parse, index) + Home | 13.6 s | **3.0 s** |
| Search, browse with facets | 0.2–0.3 s | 0.1–0.3 s |
| Object pages (overview, lineage, relationships, schema, fields used) | 0.01–0.25 s | 0.01–0.15 s |
| Schemas | 9.5 s | **0.1 s** |
| Coverage | 11.4 s | **0.5 s** |
| Governance | 13.7 s (883 MB heap) | **0.3 s** |
| Insights | 7.1 s | **0.4 s** |
| SQL console (builds an in-memory SQLite database) | 8.8 s | 7.8 s |

Catalog size on disk: 105 MB → 82 MB (7.7 MB → 6 MB gzipped).

### A troubled estate (Health, Findings)

The synthetic catalog is healthy (36 findings). `ingestion/tools/stress_catalog.py`
gives it the problems of a large estate in trouble: 16,800 findings, 12,300 unused
objects, daily series on every problem search and data source, a 60-build trend and
3,000 resolved findings. Before 0.22.1 the Health page took 31 s and built 188,000
elements, enough to crash a browser tab in Splunk Web.

| Page | Before | After |
|---|---:|---:|
| Health | 31.4 s, 188,000 elements | **1.3 s**, 5,200 elements |
| Findings | (500 rows with every remedy built) | **1.1 s**, 1,800 elements |
| Governance | 4.4 s, 41,000 elements | **1.5 s**, 16,500 elements |

Fixes: tables show a first page (100 rows; 25 per Health area) with *Show more*,
instead of up to 500 rows each; "How to fix" and "Acknowledge" build their contents
when opened, not for every finding up front; sparklines have one hover area instead
of one per day.

## Ingestion (scale 1.0)

| Step | Before | After |
|---|---:|---:|
| assemble (SPL lineage, resolver, field links, health) | 10.8 s | 7.7 s |
| governance (classifications, access) | 9.6 s | 4.2 s |
| quality checks | 0.2 s | 0.2 s |
| schema validation (`--validate`) | 29 s | 28 s |

## What was wrong, and the fixes

- **Large catalogs did not load at all.** Sharded loading appended each
  shard with `push(...items)`; 292,000 edges exceed the browser's argument
  limit ("Maximum call stack size exceeded"), so the app showed "No catalog
  loaded". Now a plain loop, with a regression test at 300,000 edges.
- **Home and Coverage** worked out each detection's data by building its whole
  upstream set (up to 10 hops, which reaches much of the graph). Now a search
  that stops at the first index or sourcetype with events, cached per catalog.
- **Governance** rendered every user of every sensitive store and a full
  role × store matrix (180,000 cells). Lists now show the first names and
  "and N more", tables page by 100, and the matrix keeps the 40 most-reached
  stores and the 60 widest-reaching roles, saying so.
- **Schemas** drew a network of every sourcetype and every shared field and
  compared all pairs. It now draws the 60 sourcetypes with most fields and
  the 40 most shared fields (overlap mode keeps each sourcetype's strongest
  three links), with a note and the filters to narrow it.
- **Usage percentiles** compared every object with every other of its type
  (144 million comparisons for 12,000 searches); now sorted once.
- **Users duplicated their roles' access**: each user carried a copy of what
  its roles can reach (26 MB of 105). The web app now derives it from the
  roles; older catalogs that include it still work.
- **SPL scanning** walked every character twice per search; it now jumps
  between quotes, brackets and separators and skips searches with no
  subsearch or quoting.
- **Governance in ingestion** looped over every object once per role,
  re-resolved the classification taxonomy hundreds of thousands of times, and
  re-evaluated an object every time one of its inputs changed. Now the
  lookups are found once, the taxonomy is cached, and classifications spread
  level by level (each object evaluated once per level). This gives the same
  results as before; the only difference is at the 8-hop limit, where the
  level-based version uses true shortest distances (identical with no limit).
- **Determinism:** a user's roles were listed in Python set order, which
  changes between runs; now sorted. Classification `via` is chosen
  deterministically.

## Known limits

- **SQL console:** filling SQLite with ~900,000 rows takes about 8 seconds on
  the main thread, and the page is unresponsive meanwhile. Batching inserts
  gained only 10–15% (SQLite's own work dominates); moving the build into a
  Web Worker would keep the page responsive.
- **Schema validation** with `jsonschema` takes about 28 s at this size. It is
  optional for `synth` and runs in `build`; a compiled validator would cut it.
- **First load** is about 3 seconds, mostly parsing JSON and building the
  search index. Gzip or Brotli on the web server matters more than anything
  in the app: 82 MB of JSON is about 6 MB compressed.
