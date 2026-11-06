# DelveCat

A metadata catalog for the Splunk ecosystem: Splunk Enterprise & Cloud,
Enterprise Security, SOAR, UEBA, Asset and Risk Intelligence, Stream,
Deployment Server and DB Connect. It is inspired by OpenMetadata, but runs
as a **static web app** (GitHub Pages friendly) and **never writes to Splunk**.

See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap.

## How it works

1. `delvecat-ingest` (Python, `ingestion/`) reads metadata from Splunk with a
   read-only client and writes a JSON **catalog bundle** that conforms to
   [`schemas/catalog.schema.json`](schemas/catalog.schema.json).
2. The web app (`web/`) loads `catalog.json` and provides search, browsing
   and entity pages entirely in the browser. **Open bundle** loads a local
   file without uploading it; `?bundle=<url>` loads a bundle from elsewhere.

## Quick start

Requires [uv](https://docs.astral.sh/uv/) and Node 22+.

```bash
make install
make dev      # builds the demo bundle from fixtures and starts Vite
make test     # lint + tests for both packages
```

Against a live Splunk (management port, token auth):

```bash
export DELVECAT_SPLUNK_TOKEN=...
cd ingestion && uv run delvecat-ingest build --url https://splunk.example.com:8089 \
  --instance prod --out catalog.json
```

For a local Splunk to develop against, see `deploy/docker-compose.yml`.

## Hosting on GitHub Pages

`.github/workflows/pages.yml` publishes the app with the **demo** bundle.
Enable it under *Settings → Pages → Source: GitHub Actions*. Public Pages
sites are visible to anyone, so do not publish real bundles there unless
access is restricted; load them with **Open bundle** instead.
