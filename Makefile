.PHONY: install demo dev test lint build types annotations

# Repository that holds annotations/, used for "suggest an edit" links in the demo.
ANNOTATION_REPO ?= https://github.com/adamliq/delvecat

install:
	cd ingestion && uv sync
	cd web && npm install

demo:  ## build the demo catalog bundle from fixtures
	cd ingestion && uv run delvecat-ingest build --fixtures tests/fixtures/splunk-9.4-dev --instance acme --fields --max-field-sourcetypes 10 --shard --strict \
		--deployment-apps-dir ../deploy/deployment-apps \
		--soar-fixtures tests/fixtures/soar-sample --ueba-fixtures tests/fixtures/ueba-sample \
		--annotations ../annotations --annotation-repo $(ANNOTATION_REPO) \
		--instance-name "Acme (demo)" --out ../web/public/catalog

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
