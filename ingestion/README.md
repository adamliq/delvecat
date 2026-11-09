# delvecat-ingest

Read-only extractor that turns Splunk metadata into a DelveCat catalog bundle.

```bash
uv sync
uv run delvecat-ingest extractors            # list extractors

# From recorded responses (no Splunk needed)
uv run delvecat-ingest build --fixtures tests/fixtures/splunk-9.4-dev --instance acme --out catalog.json

# From a live Splunk Enterprise or Cloud search head (token in DELVECAT_SPLUNK_TOKEN)
uv run delvecat-ingest build --url https://splunk.example.com:8089 --instance prod \
    --previous catalog/ --shard --out catalog/

# Splunk Cloud: also read the Admin Config Service (token in DELVECAT_ACS_TOKEN)
uv run delvecat-ingest build --url https://acme.splunkcloud.com:8089 --instance acme \
    --acs-stack acme --out catalog.json

uv run delvecat-ingest validate catalog/
```

Useful options:

| Option | Purpose |
|---|---|
| `--previous PATH` | previous bundle; adds per-entity versions and a change summary |
| `--shard` | write a directory: `catalog.json` manifest + per-type shards |
| `--fields` | sample events per sourcetype to discover fields (`--max-field-sourcetypes`) |
| `--inventory-window` | time range for observed sourcetypes/hosts/sources (default `-7d`) |
| `--only a,b` | run selected platform extractors (product connectors are skipped unless `--products` is given) |
| `--products` | `deploymentServer,dbConnect,stream`, `all` (default) or `none`; each is skipped when not installed |
| `--deployment-apps-dir` | the Deployment Server's deployment-apps folder, to catalogue the inputs each app pushes |
| `--record DIR` | save every response as replayable fixtures (secrets and emails removed) |
| `--no-usage` | skip the usage and health searches over `_audit` and `_internal` |
| `--usage-window` / `--health-window` | time ranges for usage (default `-30d`) and scheduler/parsing checks (`-7d`) |
| `--strict` | exit 3 if any extractor failed |

## Lineage

Every bundle includes lineage derived from SPL in saved searches, dashboards,
eventtypes, macros, data models and workflow actions (no extra Splunk calls).
Objects that reference something missing or not shared get
`entity.lineage.unresolved`; searches without an index get
`entity.lineage.implicitIndex`.

## Products

| Connector | Source | Notes |
|---|---|---|
| Deployment Server | `deployment/server/{serverclasses,applications,clients}`, `configs/conf-serverclass`, optional deployment-apps folder | verified against Splunk 9.4 with a real universal forwarder |
| DB Connect | `configs/conf-{identities,db_connections,db_inputs,db_outputs,db_lookups}` in `splunk_app_db_connect` | identity user names and passwords are never collected; key names follow DB Connect 3.x docs and should be checked against your version |
| Enterprise Security | saved searches (`action.correlationsearch.*`, `action.escu.*`), `alerts/alert_actions`, `configs/conf-inputs` (`threatlist://`, `identity_manager://`), `configs/conf-analyticstories` | verified against ES-format content in a dev Splunk |
| SOAR (`--soar-url`, token in `DELVECAT_SOAR_TOKEN`) | `/rest/{version,app,asset,playbook,custom_function}` | asset configuration is never read; sample responses only so far |
| UEBA (`--ueba-url`, token in `DELVECAT_UEBA_TOKEN`) | UBA REST, paths overridable with `--ueba-path kind=/path` | **unverified** paths and fields |
| Stream | KV store collections `streams`, `streamforwardergroups` in `splunk_app_stream`; forwarders from `stream:*` data | document fields follow the Stream app and should be checked against your version |

Machines are tied to the `host` values in the data by hostname (case-insensitive,
short name against FQDN), so lineage answers "which forwarders, databases and
streams feed index X". Run against each instance that holds a product (for
example the Deployment Server and the DB Connect heavy forwarder); combining
several instances into one bundle is on the roadmap.

## Usage and health

Usage comes from `_audit` and `_internal`, so the service account needs to
search them. DelveCat's own searches carry the comment ```` ```delvecat-ingest``` ````
and are excluded. Ad-hoc search text is only analyzed in memory; bundles hold
counts, never the searches. A `--record`ing does contain it, so never commit
recordings taken from production.

## Several instances

Build each instance with its own `--instance`, then merge:

```bash
uv run delvecat-ingest build --url https://sh:8089   --instance prod-sh  --out sh.json
uv run delvecat-ingest build --url https://idx1:8089 --instance prod-idx --only serverInfo,indexes --out idx.json
uv run delvecat-ingest build --url https://ds:8089   --instance prod-ds  --only serverInfo \
    --products deploymentServer --deployment-apps-dir /opt/splunk/etc/deployment-apps --out ds.json
uv run delvecat-ingest build --instance soar --soar-url https://soar.example.com --out soar.json
uv run delvecat-ingest merge sh.json idx.json ds.json soar.json --annotations ../annotations \
    --previous catalog/ --shard --out catalog/
```

The merge links what crosses instances: search-head searches to indexer
indexes, role patterns to every matching index, Deployment Server inputs to
the indexes they feed, deployment clients and forwarders to the hosts in the
data, ES detections to SOAR labels, UBA data sources to Splunk indexes. Names
of global objects (indexes, sourcetypes, hosts, SOAR labels) are matched
across instances; an index name configured on several indexer clusters links
to all of them. Merge unredacted bundles and redact the result.

### From PowerShell

`../scripts/Build-Catalog.ps1 -Config catalog.psd1` builds every instance in a
config file ([example](../scripts/catalog.example.psd1)) and merges them as
above, with annotations, redaction, `--previous` and `--shard` applied to the
merge. Tokens are read from environment variables (or asked for without
echoing) and passed to `delvecat-ingest` only through its environment.

## Search time limit

Every search a build runs (inventory, hosts, sources, forwarders, field
sampling, usage and health) is cancelled if it runs longer than
`--search-timeout` seconds (default 300; 0 for no limit). Its part is reported
as `failed` with the reason in the bundle's `ingestionReport`, and the build
goes on with the other parts. With a limit, searches run as ordinary search
jobs that DelveCat polls and, past the limit, cancels: the one `control` request
it sends, to its own job.

## Publishing to the Splunk app

```bash
export DELVECAT_PUBLISH_TOKEN=...   # account with the delvecat_publisher role
uv run delvecat-ingest publish catalog/ --url https://sh.example.com:8089
```

Stores the catalog in the DelveCat Splunk app's KV store collection (see
[../splunk-app/README.md](../splunk-app/README.md)). This is the only command
that writes to Splunk, and it can write only that collection. `--dry-run`
checks access and size; an unchanged catalog is not rewritten.

## Publishing safely

Bundles can be redacted before they go anywhere public:

```bash
export DELVECAT_REDACT_SALT=...   # keep secret; stable pseudonyms across builds
uv run delvecat-ingest build ... --redact-profile public --out catalog/
uv run delvecat-ingest redact catalog/ --redact-profile public --out public/   # after the fact
```

| Setting | `internal` | `public` |
|---|---|---|
| real names | drop | drop |
| user names, owners | keep | pseudonymize |
| hosts, forwarders, clients | keep | pseudonymize |
| source paths | keep | pseudonymize |
| IP addresses | keep | mask |
| internal URLs, DB hosts | keep | drop |

A YAML file (`--redact-profile-file`) can `extends: public` and change any
setting. Names inside SPL text are not rewritten.

## Safety

The HTTP client refuses any request that could change Splunk: only `GET` is
allowed (minus endpoints that act on GET, such as `_reload`), plus `POST` to
an allow-list of search endpoints (running a search, and cancelling DelveCat's
own search job when it exceeds the search time limit). The one exception is `publish`, which may
also write the DelveCat Splunk app's own catalog collection, and nothing else.
Keys that look like credentials and email
addresses are dropped before anything is written.

The service account needs read access to configuration endpoints, and to
`_internal` for forwarder discovery. Endpoints it cannot read are reported as
`skipped` in the bundle's `ingestionReport` rather than failing the run.

## Tests

```bash
uv run pytest                       # offline, from recorded fixtures
# against the dev container (see ../deploy):
DELVECAT_LIVE_URL=https://localhost:8089 DELVECAT_SPLUNK_TOKEN=$(cat ../deploy/.dev-token) uv run pytest -k live
```
