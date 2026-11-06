# delvecat-ingest

Read-only extractor that turns Splunk metadata into a DelveCat catalog bundle.

```bash
uv sync
# Build from recorded REST responses (no Splunk needed)
uv run delvecat-ingest build --fixtures tests/fixtures/acme --instance acme --out ../web/public/catalog.json
# Build from a live instance (token read from DELVECAT_SPLUNK_TOKEN)
uv run delvecat-ingest build --url https://splunk.example.com:8089 --instance prod --out catalog.json
uv run delvecat-ingest validate catalog.json
```

The HTTP client refuses any request that could change Splunk: only `GET` is
allowed, plus `POST` to an explicit allow-list of search/parse endpoints.
