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
2. The web app (`web/`) loads `catalog/catalog.json` (single file or sharded)
   and provides search, browsing, entity pages and relationships entirely in
   the browser. **Open file** / **Open folder** load a local bundle without
   uploading it; `?bundle=<url>` loads a bundle from elsewhere.

3. A **Coverage** page grades your detections against MITRE ATT&CK and the
   CIM data models, and lists detections that cannot fire.
4. Descriptions, owners, tags, classifications and the glossary live in
   [`annotations/`](annotations/README.md) as YAML and change through pull
   requests. Each entity page links to "suggest an edit" on GitHub.

## Quick start

Requires [uv](https://docs.astral.sh/uv/) and Node 22+.

```bash
make install
make dev      # builds the demo bundle (recorded from a real Splunk 9.4) and starts Vite
make test     # lint + tests for both packages
```

Against a live Splunk (management port, token auth):

```bash
export DELVECAT_SPLUNK_TOKEN=...
cd ingestion && uv run delvecat-ingest build --url https://splunk.example.com:8089 \
  --instance prod --out catalog.json
```

Splunk Cloud: add `--acs-stack <stack>` (ACS token in `DELVECAT_ACS_TOKEN`).
See [ingestion/README.md](ingestion/README.md) for all options.

### Local Splunk for development

```bash
export SPLUNK_PASSWORD='choose-a-dev-password'
docker compose -f deploy/docker-compose.yml up -d        # wait until healthy
uv run --project ingestion python deploy/seed_dev_splunk.py   # sample content + API token (uses docker exec for ES stand-in files)
DELVECAT_SPLUNK_TOKEN=$(cat deploy/.dev-token) uv run --project ingestion \
  delvecat-ingest build --url https://localhost:8089 --insecure --instance dev \
  --deployment-apps-dir deploy/deployment-apps --out catalog.json
```

Optional universal forwarder managed by the dev Splunk acting as Deployment Server
(after seeding, so the server classes exist):

```bash
docker compose -f deploy/docker-compose.yml --profile forwarder up -d forwarder
docker cp deploy/forwarder/deploymentclient.conf \
  deploy-forwarder-1:/opt/splunkforwarder/etc/system/local/deploymentclient.conf
docker exec -u root deploy-forwarder-1 chown splunk:splunk \
  /opt/splunkforwarder/etc/system/local/deploymentclient.conf
docker exec -u splunk deploy-forwarder-1 /opt/splunkforwarder/bin/splunk restart
```

Within about a minute it phones home, receives `acme_all_outputs` and
`acme_linux_inputs`, and forwards its `splunkd.log` into the `os` index.

## Hosting on GitHub Pages

`.github/workflows/pages.yml` publishes the app with the **demo** bundle.
Enable it under *Settings → Pages → Source: GitHub Actions*. Public Pages
sites are visible to anyone, so do not publish real bundles there unless
access is restricted; load them with **Open file** / **Open folder** instead.
