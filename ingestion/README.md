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

## Safety

The HTTP client refuses any request that could change Splunk: only `GET` is
allowed (minus endpoints that act on GET, such as `_reload`), plus `POST` to
an allow-list of search endpoints. Keys that look like credentials and email
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
