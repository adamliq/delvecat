# Performance at scale

DelveCat is measured against a synthetic catalog the size of a large Splunk
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
