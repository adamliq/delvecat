.PHONY: install demo dev test lint build types annotations

# Repository that holds annotations/, used for "suggest an edit" links in the demo.
ANNOTATION_REPO ?= https://github.com/adamliq/delvecat

install:
	cd ingestion && uv sync
	cd web && npm install

# The demo is a multi-instance catalog: each instance is built on its own, then merged.
ANNOTATION_BRANCH ?= main
REDACT ?=                # e.g. REDACT="--redact-profile public" for public hosting
PARTS = ../web/.demo-parts
FIXTURE = tests/fixtures/splunk-9.4-dev
INGEST = cd ingestion && uv run delvecat-ingest

demo:  ## build the demo catalog (search head + Deployment Server + SOAR + UBA, merged)
	rm -rf web/.demo-parts && mkdir -p web/.demo-parts
	$(INGEST) build --fixtures $(FIXTURE) --instance acme --instance-name "Acme search head" \
		--fields --max-field-sourcetypes 10 --products dbConnect,stream,enterpriseSecurity \
		--strict --out $(PARTS)/search-head.json
	$(INGEST) build --fixtures $(FIXTURE) --instance acme-ds --instance-name "Acme deployment server" \
		--only serverInfo,apps --no-usage --products deploymentServer \
		--deployment-apps-dir ../deploy/deployment-apps --strict --out $(PARTS)/deployment-server.json
	$(INGEST) build --instance soar --soar-fixtures tests/fixtures/soar-sample --out $(PARTS)/soar.json
	$(INGEST) build --instance uba --ueba-fixtures tests/fixtures/ueba-sample --out $(PARTS)/uba.json
	$(INGEST) merge $(PARTS)/search-head.json $(PARTS)/deployment-server.json $(PARTS)/soar.json \
		$(PARTS)/uba.json --annotations ../annotations --annotation-repo $(ANNOTATION_REPO) \
		--annotation-branch $(ANNOTATION_BRANCH) --strict $(REDACT) --shard --out ../web/public/catalog

dev: demo
	cd web && npm run dev

annotations:  ## validate annotations/ against the demo bundle
	cd ingestion && uv run delvecat-ingest lint-annotations ../annotations --bundle ../web/public/catalog

types:
	cd web && npm run gen:types

lint:
	cd ingestion && uv run ruff check . && uv run ruff format --check .
	cd web && npm run typecheck

test: lint
	cd ingestion && uv run pytest -q
	cd web && npm test

build: demo
	cd web && npm run build
