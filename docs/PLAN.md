# DelveCat — a metadata catalog for Splunk

DelveCat is an OpenMetadata-style data catalog purpose-built for the Splunk
ecosystem. It inventories Splunk objects, traces lineage through SPL and
across Splunk products, surfaces usage and health signals, and lets people
document and classify what they find — **without ever writing back to Splunk**.

## 1. Requirements

| # | Requirement | Consequence |
|---|---|---|
| R1 | Splunk Enterprise **and** Splunk Cloud | Two access paths: REST (8089) everywhere; Splunk Cloud also via the Admin Config Service (ACS) API. Extractors must degrade gracefully when an endpoint is restricted. |
| R2 | Splunk Premier security suite: **Enterprise Security, SOAR, UEBA, Asset and Risk Intelligence** | Product-specific entity types and connectors (SOAR and UBA have their own APIs, separate from Splunk REST). |
| R3 | **Splunk Stream, Deployment Server, DB Connect** | Ingestion-side lineage: DB table → DBX input → index; serverclass → app → input → index; stream → index. |
| R4 | Standalone web app hostable on **GitHub Pages** | No server. Static SPA + pre-built JSON *catalog bundle*. Forking OpenMetadata is ruled out (it needs a Java server, RDBMS, and Elasticsearch). |
| R5 | Audience: **admins and analysts** | Admin views (inventory, health, cleanup, access) and analyst views (discovery, field docs, "where does this data come from"). |
| R6 | **No write-back** to Splunk | Ingestion client is read-only by construction; annotations live in the DelveCat repo, not in Splunk. |

## 2. Architecture

```
 ┌────────────────────────── where Splunk is reachable ──────────────────────────┐
 │  delvecat-ingest (Python CLI, read-only)                                      │
 │    connectors: splunk-rest · splunk-cloud-acs · es · soar · ueba · ari ·      │
 │                stream · deployment-server · db-connect                        │
 │    → normalize → redact secrets → resolve lineage → validate (JSON Schema)    │
 │    → catalog bundle  (catalog.json [+ shards])                                │
 └───────────────────────────────────────┬───────────────────────────────────────┘
                                         │ committed / uploaded as build artifact
 ┌───────────────────────────────────────▼───────────────────────────────────────┐
 │  GitHub Actions: merge annotations/*.yaml → build web/ → deploy to Pages      │
 └───────────────────────────────────────┬───────────────────────────────────────┘
                                         │
 ┌───────────────────────────────────────▼───────────────────────────────────────┐
 │  DelveCat web (React + TS, static, HashRouter)                                │
 │    client-side search (MiniSearch) · entity pages · lineage graph ·          │
 │    usage & health · "open local bundle" (data never leaves the browser)       │
 └───────────────────────────────────────────────────────────────────────────────┘
```

### Key decisions

- **JSON Schema is the source of truth** (`schemas/`). TypeScript types are
  generated from it; the ingestion CLI validates every bundle against it.
- **Catalog bundle** = `{schemaVersion, generatedAt, instances, entities, edges}`.
  Large estates are sharded per entity type with a pre-built search index
  so the browser loads lazily.
- **Annotations as code.** Descriptions, owners, glossary terms, tags and
  classifications live in `annotations/*.yaml`, reviewed via pull request, and
  merged into the bundle at build time. Entity pages link to "suggest an edit".
  This gives collaboration without a server and without touching Splunk.
- **Read-only client.** The HTTP client only permits `GET`, plus `POST` to an
  explicit allow-list (`search/jobs` for running searches, `search/parser` for
  SPL parsing). Anything else raises before a request is sent.
- **Secrets never enter a bundle.** Keys matching password/token/secret/
  credential patterns are dropped at the connector boundary (DB Connect
  identities, SOAR asset configs, HEC tokens, alert action settings).
- **Privacy on GitHub Pages.** Public Pages exposes everything in the bundle.
  Supported options: (a) private Pages (GitHub Enterprise Cloud access
  control); (b) publish the app with a demo bundle only and load real bundles
  from a local file in the browser; (c) host the same static build on any
  internal web server; (d) `--redact` profile that hashes hosts/users.

## 3. Entity model

Fully qualified name (FQN), mirroring how Splunk makes names unique:
`<instance>:<type>:<name>` for global objects (indexes, sourcetypes, hosts,
roles, users, apps); `<instance>:<type>:<app>/<name>` for shared knowledge
objects (sharing app/global); `<instance>:<type>:<app>/@<owner>/<name>` for
private ones. The owner of a shared object is metadata only (it can be
reassigned), so it is not part of the identity.

Common aspects on every entity: `description`, `owners`, `tags`,
`classifications` (e.g. `PII.Email`, `MITRE.T1078`), `glossaryTerms`,
`product`, `sharing`, `disabled`, `updatedAt`, `usage`, `health`,
`properties` (type-specific), `sourceUrl` (deep link into Splunk).

### Splunk platform (Enterprise & Cloud)
| Area | Entity types |
|---|---|
| Platform | `instance` (role: search head, SHC, indexer cluster, HF, DS, Cloud stack), `app`, `user`, `role` |
| Data | `index` (events/metrics), `sourcetype`, `source`, `host`, `field`, `dataModel` (+ datasets, acceleration), `lookup` (CSV / KV store), `kvCollection` |
| Knowledge objects | `savedSearch` (report / alert / scheduled), `macro`, `eventtype`, `tag`, `fieldAlias`, `calculatedField`, `fieldExtraction`, `transform`, `workflowAction` |
| Consumption | `dashboard` (Simple XML & Dashboard Studio) with panels |
| Ingestion | `input` (monitor, HEC token *name*, scripted, modular, splunktcp), `forwarder` |
| Cloud | ACS: indexes, HEC token metadata, IP allow lists, installed apps; Ingest Actions rulesets; Edge/Ingest Processor pipelines (SPL2) — later |

### Enterprise Security
`correlationSearch` / `detection` (ES 8), `findingType` (notable), `riskRule`
and risk modifiers, `riskObjectType`, `threatIntelSource`,
`assetIdentitySource`, `adaptiveResponseAction`, `analyticStory`
(incl. ESCU content), `responseTemplate`, `investigationType`.
Classifications: MITRE ATT&CK techniques/tactics, kill-chain phase, CIM data
model. Coverage views: detections per data model / ATT&CK technique, and which
detections are blind because their source data is missing or stale.

### SOAR
`soarPlaybook` (classic/modern), `soarCustomFunction`, `soarApp`
(connector), `soarAsset` (configured instance — *no credentials*),
`soarLabel`, `soarWorkbook`. Source: SOAR REST API (`/rest/playbook`,
`/rest/asset`, `/rest/app`, `/rest/custom_function`, ...), token auth.
Lineage: ES detection → adaptive response / "send to SOAR" → label →
playbook → asset → external system.

### UEBA
`uebaDataSource`, `uebaModel` (anomaly model), `uebaAnomalyType`,
`uebaThreatRule`, `uebaOutputConnector`. Sources: Splunk UBA REST API
(on-prem) and the ES 8 integrated UEBA content (Cloud). Lineage:
index/sourcetype → data source → model → anomaly → threat → ES.

### Asset and Risk Intelligence (ARI)
`ariSource` (discovery searches feeding inventory), `ariAssetType`,
`ariField` mapping, `ariMetric`, `ariExposure`, inventory KV collections.
Lineage: index/sourcetype → discovery search → inventory → ES asset lookup.

### Splunk Stream
`streamForwarder` (streamfwd / ISF), `streamGroup`, `streamDefinition`
(protocol, enabled fields, filters, aggregation, target index), ephemeral
streams. Lineage: streamforwarder → stream → index/sourcetype
(`stream:<protocol>`).

### Deployment Server
`serverClass` (whitelist/blacklist, machine-type filters),
`deploymentApp`, `deploymentClient` (phone-home time, OS, IP — redactable).
Source: `/services/deployment/server/{serverclasses,applications,clients}`.
Lineage: serverclass → deployment app → inputs it contains → index/sourcetype;
"which forwarders send data into index X". (Customer-hosted even for Cloud.)

### DB Connect
`dbConnection` (type, host, database — never credentials), `dbIdentity`
(name only), `dbInput` (SQL, batch/rising column, target index/sourcetype),
`dbOutput`, `dbLookup`, `externalTable` (the database object).
Lineage: externalTable → dbInput → index/sourcetype; savedSearch → dbOutput →
externalTable; dbLookup ↔ externalTable.

### Edges (lineage graph)
`reads`, `writes`, `contains`, `uses` (macro/eventtype/lookup), `feeds`
(ingestion), `deploys`, `triggers` (alert action / SOAR), `accelerates`,
`mapsTo` (CIM / ATT&CK), `grantsAccess` (role → index).

## 4. Ingestion

| Extractor | Source |
|---|---|
| Configuration | `/servicesNS/-/-/` endpoints (`saved/searches`, `data/ui/views`, `admin/macros`, `data/props/*`, `data/transforms/*`, `datamodel/model`, `data/lookup-table-files`, `storage/collections/config`, `data/indexes`, `apps/local`, `authorization/roles`, ...) with `output_mode=json` |
| Data inventory | `\| tstats count where index=* by index, sourcetype, host, source` (windowed), `\| metadata` |
| Fields | `\| fieldsummary` sampled per sourcetype + props/transforms definitions |
| Usage | `_audit` searches (who/what/how often), `_internal` scheduler, `license_usage.log` |
| Health | latest event, `_indextime - _time` lag, parsing warnings, skipped searches |
| Cloud | ACS API (`admin.splunk.com/<stack>/adminconfig/v2/...`) |
| Products | ES (app conf + REST), SOAR REST, UBA REST, ARI/Stream/DBX app endpoints and KV store |

Connectors are independent plugins with a shared contract:
`extract(transport) -> Iterable[RawRecord]` then `normalize(RawRecord) -> Entity | Edge`.
A `FixtureTransport` replays recorded REST responses, so every connector is
unit-tested without a live Splunk. Endpoints marked *to verify* in this plan
are confirmed against a live instance before their connector ships.

## 5. Lineage

1. Parse SPL locally (`ingestion/src/delvecat_ingest/spl.py`), expanding
   macros from the catalogued definitions with Splunk's visibility rules. The
   live test suite cross-checks the expansion against Splunk's own
   `/services/search/parser`, so no per-search API calls are needed in
   production runs.
2. Reads: `index=`, `sourcetype=`, macros, `lookup`/`inputlookup`,
   `datamodel`/`tstats from datamodel=`, `savedsearch`/`loadjob`,
   `eventtype=`, `tag=`, `dbxquery connection=`.
3. Writes: `outputlookup`, `collect`/summary indexing, `outputcsv`,
   alert actions (incl. notable/risk/SOAR), `dbxoutput`, DM acceleration.
4. Product edges from connectors (sections 3 above).
5. Stretch: field-level lineage through `eval`/`rename`/`stats by`.

## 6. Web app

- **Home**: estate overview (counts by product/type, freshness, health alerts).
- **Search**: full-text, faceted by product / type / app / owner / tag.
- **Entity page** tabs: Overview · Fields/Schema · Lineage · Usage · Health ·
  Annotations · Raw.
- **Admin views**: unused objects, skipped searches, stale indexes, role →
  index access matrix, deployment coverage, license by index/sourcetype.
- **Analyst views**: "where is data about X", sourcetype field dictionary,
  detection coverage by ATT&CK technique / data model.
- Hash routing + relative base so it runs from any GitHub Pages path.

## 7. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Skeleton** ✅ | Monorepo, JSON Schemas, read-only client + fixture transport, ingest CLI producing a validated bundle from fixtures, web shell (search + entity page), CI, Pages deploy, docker-compose Splunk for dev | `make demo` builds a bundle and the site renders it; CI green; Pages workflow deploys the demo |
| **1. Core inventory** ✅ | All Splunk platform extractors (Enterprise + Cloud/ACS), versioned bundles, sharding | Every knowledge object in a test instance is in the bundle |
| **2. UI MVP + annotations** ✅ | Faceted search, entity tabs, `annotations/*.yaml` merge, "suggest edit" links, local bundle loading | Every type browsable and annotatable |
| **3. SPL lineage** ✅ | Parser integration, edge resolution, lineage graph (React Flow), impact analysis | index → search → lookup → dashboard chain traced |
| **4. Ingestion products** ✅ | Deployment Server, DB Connect, Stream connectors + lineage | "Which forwarders/DBs/streams feed index X" answered |
| **5. Security suite** ✅ | ES, SOAR, UEBA, ARI connectors; ATT&CK & CIM coverage views | Detection → SOAR playbook chain shown; coverage gaps listed |
| **6. Usage & health** ✅ | `_audit`/`_internal`/license extractors, freshness & volume checks, cleanup report | Health dashboard and unused-object report |
| **7. Governance** ✅ | Glossary, classifications (PII), role → index access view, redaction profiles | "Who can see PII data?" answered |
| Later | Field-level lineage, Edge/Ingest Processor pipelines, NL search | |

### Phase 1 notes (done)

- Verified against a live Splunk Enterprise 9.4 container seeded by
  `deploy/seed_dev_splunk.py`; `tests/test_live_splunk.py` checks that every
  seeded object (`deploy/seed_manifest.json`) is catalogued. The same run is
  recorded as `ingestion/tests/fixtures/splunk-9.4-dev` (via `--record`, then
  `tools/slim_fixtures.py`), which drives the offline tests and the demo site.
- Extractors: server info, apps, users, roles, indexes (event + metric),
  sourcetype definitions, observed sourcetypes/hosts/sources (`tstats`),
  inputs (monitor, TCP, splunktcp, UDP, script, HEC), forwarders
  (`tcpin_connections`), saved searches, dashboards, macros, eventtypes, tags,
  field extractions, field aliases, calculated fields, automatic lookups,
  transforms, lookup files and definitions, KV store collections, data models,
  workflow actions, and opt-in field discovery (`--fields`, `fieldsummary`).
- Splunk Cloud: ACS connector (indexes, HEC token metadata, apps, IP
  allow-list *counts*) merges into the same instance. ACS response shapes are
  covered by a hand-written fixture and still need a check against a real
  Cloud stack.
- Relationships resolved after extraction: app contains object; role →
  index (effective, incl. inherited and wildcard patterns, `*` excluding
  internal indexes as Splunk does); user → role; role → imported role;
  sourcetype → props objects; extraction → transform; automatic lookup →
  lookup definition → file / KV collection; tag → eventtype/sourcetype/host;
  input/host/source/sourcetype → index; summary-indexing search → index.
- Versioning: `--previous` assigns per-entity `version`, `firstSeenAt` and a
  bundle-level change summary. Run-to-run measurements live under
  `properties.observed` and do not count as changes.
- Sharding: `--shard` writes `catalog.json` + `entities/<type>.json` +
  `edges.json` with sha256 checks; the web app loads either form and can open
  a bundle folder from disk.
- Safety: GETs that act (`_reload`, `control`, `dispatch`, ...) are refused
  alongside all writes; email addresses are dropped with credentials.
- Deferred: SPL-derived lineage (Phase 3), dashboard panel parsing (Phase 3),
  data model acceleration status and `_audit` usage (Phase 6).

### Phase 2 notes (done)

- `annotations/**/*.yaml` (schema: `schemas/annotations.schema.json`) holds
  descriptions, owners, tags, classifications, glossary terms, links and the
  glossary itself. Entries target one entity by `id` or many by `match`
  (type/product/instance/app/name/owner, wildcards for app/name/owner).
  Selectors apply first, then ids; lists union; the last description wins.
- Merged by `delvecat-ingest build --annotations` or, without Splunk access,
  `delvecat-ingest annotate <bundle>`. `lint-annotations` validates files
  (errors carry `file:line`) and, with `--bundle`, flags entries that match
  nothing and glossary terms used but not defined. CI runs it, so pull
  requests from "suggest an edit" are checked automatically.
- Annotations sit in `entity.annotations` (with `sources` and
  `primarySource`), separate from Splunk's own description, and never change
  an entity's catalog version.
- Web: faceted search (type, product, app, owner, tag, classification,
  glossary term, sharing, status, has description; multi-select with counts),
  sorting and paging; entity tabs (Overview, Fields, Relationships,
  Annotations, Raw); glossary pages with synonyms; documentation coverage on
  the home page; "suggest an edit" links to the entity's own entry, or a
  pre-filled new file on GitHub, plus a copyable YAML entry.

### Phase 3 notes (done)

- SPL analyzer: pipelines and `[subsearches]`, quoting, `NOT`/`!=`, `IN`,
  `index::`, ```` ```comments``` ````, `tstats`/`mstats`/`metadata`,
  `datamodel`/`pivot`/`from`, `lookup`/`inputlookup`/`outputlookup`,
  `collect`/`mcollect`, `savedsearch`/`loadjob`; tags (`tag=`, `tag::f=`)
  and eventtypes. Macros (with arguments, nested, `$token$`-built names) are
  expanded using the catalog; Splunk's `/search/parser` agrees with the
  expansion for every seeded search (`tests/test_live_splunk.py`).
- SPL is analyzed for saved searches, eventtypes, macros, workflow actions,
  data model dataset constraints and dashboards (Simple XML inline,
  post-process and saved-search panels; Dashboard Studio `ds.search`,
  `ds.savedSearch`, `ds.chain`). Dashboard XML is parsed with `defusedxml`.
- References resolve with Splunk's visibility rules (same app, then globally
  shared; private objects only for their owner). Edges carry
  `origin: "spl"`.
- Diagnostics per entity (`entity.lineage`, outside the content hash):
  broken references (missing, deleted or unshared macros, lookups, indexes,
  saved searches; written lookups excluded), searches without an index,
  dynamic `$tokens$`, unparseable dashboards. On the stock Splunk 9.4
  content this flags real issues (e.g. searches for sourcetypes with no data)
  without false positives from comments or token-built macros.
- Web: Lineage tab with an upstream/downstream graph (longest-path layering,
  adjustable depth, scrolls to the focused object), full upstream and impact
  lists, diagnostics; "Search issues" facet; search health on the home page.
- Deferred: field-level lineage; `map search="..."` strings; SPL2.

### Phase 4 notes (done)

- **Deployment Server**: server classes (white/blacklists, machine-type
  filters), class → app mapping from `serverclass.conf`, deployment apps,
  clients (phone-home, installed apps, class membership), and, with
  `--deployment-apps-dir`, the inputs and output targets inside each app
  (`default/` and `local/` layered like Splunk). Verified end to end: the dev
  compose file runs a universal forwarder that phones home to the dev Splunk,
  receives two apps and forwards data.
- **DB Connect**: identities (names only), connections, inputs (batch /
  rising), outputs (with SPL lineage of their search), lookups, and external
  tables found from table names and SQL. `dbxquery`, `dbxoutput` and
  `dbxlookup` in SPL link searches to connections, tables, outputs and
  lookups; tables named only in `dbxquery` are catalogued under their
  connection. Read from DB Connect's `.conf` files through Splunk's generic
  config endpoint (no Java service needed); a stand-in app in the dev
  container exercises the real endpoint.
- **Stream**: stream definitions and forwarder groups from the Stream app's KV
  store collections, Stream forwarders from `stream:*` data, group rules
  matched against forwarder hostnames.
- **Linking**: deployment clients, forwarders and Stream forwarders feed the
  `host` values in the data (by hostname), so "which forwarders, databases and
  streams feed index X" is answered by lineage and by the new "Where this data
  comes from" panel on index and sourcetype pages.
- Disabled inputs (platform, deployment app, DB Connect, Stream) no longer
  count as feeding an index. User names are redacted alongside passwords.
- To verify on real installs: DB Connect key names across versions, Stream KV
  document fields. Deferred: combining bundles from several instances (the DS,
  heavy forwarders and search heads) into one catalog.

### Phase 5 notes (done)

- **Enterprise Security** (verified against ES-format content in the dev
  Splunk, since ES is configuration): saved searches with
  `action.correlationsearch.*` (or ESCU `action.escu.*`) become
  `correlationSearch` detections with ATT&CK techniques, kill chain, CIS/NIST,
  analytic stories, security domain, severity and risk objects. Detections
  write to `notable` / `risk`, trigger their alert actions, and name SOAR
  labels or playbooks through SOAR-bound alert action parameters. Alert
  actions, threat intel sources (`threatlist://`), asset & identity sources
  (`identity_manager://`, linked to their lookups) and ESCU analytic stories
  are catalogued. Objects in ES, SOAR, ARI and UEBA apps are attributed to
  their product.
- **SOAR** (`--soar-url`, `ph-auth-token`): apps, assets (configuration never
  read), playbooks with their labels, custom functions; label → playbook
  edges complete the chain detection → SOAR label → playbook. Built against
  the documented REST API with sample responses; not yet run against a live
  SOAR server.
- **UEBA** (`--ueba-url`): data sources → models → anomaly types → threat
  rules → output connectors → index. Endpoint paths and fields are a best
  reading of the UBA documentation, overridable with `--ueba-path`, and
  **unverified**.
- **Asset and Risk Intelligence**: objects in ARI's apps are attributed to
  the product and get platform lineage; dedicated ARI entity types wait for a
  real install to confirm its data model.
- **Coverage** page: ATT&CK Enterprise matrix (bundled reference data, v20.1,
  compiled by `ingestion/tools/compile_attack.py`) graded covered / weak /
  gap with sub-techniques rolled up; detections that cannot fire (disabled,
  broken reference, no data upstream); CIM data models the detections rely on
  (missing, no data, accelerated). Detection pages show ATT&CK, stories and
  the response chain.
- Credentials embedded in URLs (`https://user:pass@host`) are stripped
  everywhere.

### Phase 6 notes (done)

- Read-only searches over `_audit` (saved search runs, ad-hoc and dashboard
  searches, user activity), `_internal` (scheduler outcomes, web views,
  license usage, parsing warnings) and `tstats` (daily volume per index and
  sourcetype, ingest delay). Field names verified on Splunk 9.4. DelveCat tags
  its own searches with an SPL comment (```` ```delvecat-ingest``` ````) and
  leaves them out of usage (requires Splunk 8.1+ comment syntax).
- Ad-hoc search text is analyzed with the same SPL analyzer and macro
  library as lineage, so indexes, macros, lookups and data models used only
  interactively count as used. The text itself is never stored in a bundle
  (recordings of production instances would contain it: do not commit them).
- `entity.usage` (runs, views, ad-hoc references, last use, scheduler
  results) and `entity.health` (`ok` / `warning` / `critical` checks) are
  derived and never change catalog versions. Health is judged as of the
  capture time (live: now; recordings: `__meta__.json`).
- Checks: stale data (24 h / 7 d), volume drop or spike against the median
  day (needs 5 days), ingest delay (10 / 60 min, summary `stash` exempt),
  parsing warnings, skipped (10% / 50%), failed and slow scheduled runs,
  scheduled searches that should have run (cron-aware, against how far back
  the scheduler log goes), silent forwarders and deployment clients, failed
  app deployments.
- Cleanup report: objects nothing depends on and nobody used in the window,
  only judged where the relevant usage source was available; vendor content
  (Splunk-authored and product apps) hidden unless asked; CSV export.
- Web: Health page, usage & health panel with daily-volume sparkline on
  entity pages, Health and Usage facets, home summary.

### Phase 7 notes (done)

- **Classification taxonomy** in `annotations/` (`classifications:` with
  `sensitive` and `propagate`; `PII` covers `PII.*`).
- **Effective classifications** (`entity.governance.classifications`): annotated,
  from a classified field to its sourcetype, from a sourcetype to the indexes
  it feeds, and carried through lineage to derived data stores (summary
  indexes, lookups written by searches, ES notable/risk, data models, indexes
  fed from classified DB tables), each with provenance. Searches and
  dashboards that read classified data directly are listed as consumers.
- **Who can see it** (`governance.access`, `governance.sensitiveAccess`): roles
  through effective search access (inherited roles included) or object read
  permissions (now catalogued as `entity.permissions`, `*` = every role);
  users through their roles; row-level search filters reported; objects
  readable by every role flagged. Approximations: app-level visibility and
  capabilities such as `admin_all_objects` are not modelled.
- **Redaction profiles** (`build --redact-profile`, `delvecat-ingest redact`):
  `internal` drops real names; `public` also pseudonymizes users, hosts and
  sources with keyed hashes (stable with `DELVECAT_REDACT_SALT`), masks IPs,
  drops internal URLs and DB hosts, and rewrites ids and edges consistently.
  Custom YAML profiles can extend either. The Pages workflow publishes the
  demo with `public`; CI checks the redacted demo validates. Names inside SPL
  text and input stanza paths are not rewritten.
- Web: Governance page ("who can see …", access matrix, exposure, consumers,
  taxonomy), governance panel on entity pages, Sensitivity facet, redaction
  notice in the footer.

### Multi-instance catalogs (done)

- `delvecat-ingest merge a b c ... --out catalog/` combines bundles built from
  different instances (search heads, indexers, Deployment Server, DB Connect
  heavy forwarders, SOAR, UBA). `build` can now produce a SOAR- or UBA-only
  bundle.
- Every bundle keeps the references it could not resolve plus all wildcard
  patterns (`references`, global object types only); merge re-resolves them
  across instances, re-links machines to hosts, clears broken-reference
  diagnostics another instance fixes, revives objects that gained consumers,
  folds a search head's observation-only index stubs into the configured
  index on the indexers (when exactly one instance configures it), and
  recomputes governance. Annotations, `--previous` versioning and redaction
  run on the merged result; redacted bundles cannot be merged.
- Instance ids must be unique across inputs; annotation ids include the
  instance, so annotate objects under the instance that owns them.
- The demo is now four instances merged (`make demo`), used by CI and Pages.

### Domains, data products and impact export (done)

- Inspired by DataHub. Domains (nested with `parent`) and data products are
  defined in `annotations/`; objects get one domain each (`domain:` on any
  entry), data products list assets by id or selector. `lint-annotations`
  reports undefined domains, duplicate names and assets that match nothing.
  Merge combines them across bundles.
- Web: Domains page (tree with asset counts and health findings), domain and
  data product pages with health / sensitivity / documentation / cleanup
  roll-ups, a data product's boundary (what it depends on and what uses it
  outside the product), Domain and Data product facets and chips.
- Impact analysis: the Lineage tab's upstream and downstream lists show hops
  and the path ("via"), filter by type and distance, and export to CSV.

### Structured properties (done)

- Also from DataHub. `structuredProperties` definitions in `annotations/`
  give an id, display name, type (string, number, boolean, date, url),
  optional allowed values (with meanings), single or multiple values, the
  object types they apply to and whether they are required (optionally only
  where a selector matches). Entries set values under `properties:`.
- Ingestion checks values against definitions (unknown property, wrong type,
  value not allowed, list for a single value) with file:line errors, skips
  values on types the property does not apply to, and records which required
  properties each object lacks. Internal, system and `_` objects are not
  required to have values. Merge unions definitions by id.
- Web: a Structured properties panel on the entity overview, summary chips on
  search results, one search facet per filterable property plus "Missing
  required property", and a Properties page with fill rate, value counts and
  a link to the objects missing a required value. "Suggest an edit" snippets
  include the properties with empty placeholders for missing required ones.

### Field-level lineage (done)

- From Marquez's column-level lineage. `spl_fields.py` walks the macro-expanded
  pipeline (subsearches included) and records, per search, the source fields
  it reads and how (filter, groupBy, aggregate, eval, rename, lookup, extract,
  enrich, join, dedup, sort, select, output), and when the result shape is
  known (stats / table / fields...) each output column with the source fields
  it is computed from. Fields the pipeline creates (eval, rename, stats
  outputs, lookup outputs, rex groups, iplocation) are traced back to their
  sources. Commands whose output shape is not modelled (xyseries, foreach,
  map...) make outputs unknown rather than wrong. Stored as derived
  `lineage.fields`, so it never changes catalog versions.
- `fields.py` adds `field` entities for fields props.conf defines (inline and
  transform extractions, aliases, calculated fields, automatic lookup outputs)
  with `definesField` edges, plus `readsField` edges from those definitions to
  their inputs; and `readsField` edges from searches to the fields of the
  sourcetypes they read (`sourcetype=` narrows it; otherwise every sourcetype
  feeding the indexes read). Merge re-links across instances.
- Governance: reading a classified field counts as reading that
  classification. Risk: a field whose only definition is disabled puts its
  readers at risk.
- Web: "Fields used" tab on searches (fields, how, matched sourcetype fields,
  result columns and their sources); on a field, where it comes from, who uses
  it and how, and what a change could break (readers, fields derived through
  aliases and lookups, and everything downstream); "Used by" on sourcetype
  fields; `field_usage` and `column_lineage` tables in the SQL console.
- Limits: data model, lookup and other-search fields are recorded but not
  linked (no entities for them yet); wildcards and `$token$` field names are
  skipped; `spath` and automatic key-value fields are taken by name.

### Search results export (done)

- "Download CSV" on Browse exports every result of the current search and
  filters, in the current sort: identity, product, app, sharing, status,
  description, domain, data products, owners, tags, classifications, glossary
  terms, health and findings, at-risk severity and causes, usage, Splunk and
  catalog links, and one column per structured property.
- All CSV exports defuse spreadsheet formulas (text starting with = + - @ gets
  a leading apostrophe) and start with a byte-order mark so Excel reads UTF-8.

### Downstream at-risk alerts (done)

- From OpenDataDiscovery's alert propagation. Computed in the web app from
  the loaded bundle, so it works for merged and redacted bundles. Causes are
  health findings, broken references and disabled objects.
- Risk follows dependency: mostly data flow, except that a detection depends
  on the alert action it triggers (a broken action puts its detections at
  risk; a disabled detection does not put a shared action at risk). Disabled
  objects are causes, never paths.
- A target with several producers of the same kind (an index fed by many
  sourcetypes or written by many searches) is only partly affected by one bad
  producer: it is flagged as a warning and the risk stops there; a disabled
  producer among several is ignored. A sole producer spreads fully.
- Web: an "At risk" banner on the object with each cause, hops and path; "Puts
  N objects at risk" on the cause; an At risk label and search facet; an At
  risk section with CSV export on the Health page; counts on Home and in
  domain and data product roll-ups; a `risk` table in the SQL console.

### SQL console (done)

- From Magda's in-browser SQL console. `/#/sql` loads SQLite (sql.js,
  WebAssembly) only when opened, so the main bundle stays the same size, and
  fills an in-memory database from the loaded bundle. Redacted bundles stay
  redacted. The database is set `query_only`, so nothing can change.
- Tables: `entities` (with `settings` and `props` as JSON for
  `json_extract`), `edges`, `labels` (owners, tags, terms, data products,
  missing properties), `classifications`, `properties`, `settings` (one row
  per Splunk setting), `health_checks`, `lineage_issues`, `access`,
  `instances`, `domains`, `data_products`.
- Example queries, a table browser with column notes, ids linked to entity
  pages, CSV download, and the query kept in the URL for sharing.

## 8. Repository layout

```
delvecat/
  schemas/            JSON Schema (source of truth)
  ingestion/          Python package `delvecat_ingest` (CLI, connectors, transports)
    tests/fixtures/   recorded REST responses per scenario
  web/                React + TypeScript + Vite static app
  annotations/        human-curated metadata (descriptions, owners, glossary)
  deploy/             docker-compose for a local dev Splunk
  docs/               plan and design notes
  .github/workflows/  ci.yml, pages.yml
```

## 9. Risks

- **SPL complexity** (subsearches, `map`, nested macros, dashboard tokens) —
  use Splunk's parser endpoint and a real-world SPL test corpus.
- **Load on production Splunk** — incremental, windowed usage searches; run
  off-peak; per-connector timeouts and concurrency limits.
- **Product API variance** across versions (ES 7 vs 8, SOAR on-prem vs Cloud,
  UBA vs integrated UEBA) — version detection per connector; verify endpoints
  on live instances before shipping.
- **Splunk Cloud restrictions** — capability probe at start; report what was
  skipped and why in the bundle's `ingestionReport`.
- **Sensitive metadata on public Pages** — see privacy options in §2;
  demo deploys only ever use fixtures.
- **Bundle size** for large estates — sharding, pre-built search index, lazy load.
