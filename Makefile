.PHONY: install demo dev test lint build types

install:
	cd ingestion && uv sync
	cd web && npm install

demo:  ## build the demo catalog bundle from fixtures
	cd ingestion && uv run delvecat-ingest build --fixtures tests/fixtures/acme --instance acme \
		--instance-name "Acme (demo)" --out ../web/public/catalog.json

dev: demo
	cd web && npm run dev

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
