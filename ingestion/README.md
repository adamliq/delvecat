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
| `--only a,b` | run selected extractors |
| `--record DIR` | save every response as replayable fixtures (secrets and emails removed) |
| `--strict` | exit 3 if any extractor failed |

## Lineage

Every bundle includes lineage derived from SPL in saved searches, dashboards,
eventtypes, macros, data models and workflow actions (no extra Splunk calls).
Objects that reference something missing or not shared get
`entity.lineage.unresolved`; searches without an index get
`entity.lineage.implicitIndex`.

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
