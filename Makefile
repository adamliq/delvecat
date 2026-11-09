.PHONY: install demo dev test lint build types annotations perf splunk-app splunk-app-lib

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

SCALE ?= 1.0
perf:  ## time every page against a synthetic catalog (SCALE=1.0 is ~100k objects; needs Playwright)
	cd ingestion && uv run delvecat-ingest synth --scale $(SCALE) --out ../web/.large --shard
	cd web && npm run build && rm -rf dist/large && cp -r .large dist/large
	cd web && (npx vite preview --port 4173 --strictPort >/dev/null 2>&1 & echo $$! > .preview.pid) && sleep 3 && \
		node scripts/perf.cjs http://localhost:4173 .large large/catalog.json; kill `cat .preview.pid`; rm -f .preview.pid

# The Splunk app (splunk-app/delvecat): the web app built for Splunk Web, packaged for
# "Install app from file" or Splunk Cloud (ACS). Two packages: dist/delvecat-<v>.tgz uses
# Splunk's page template (Splunk 10.4+ and Splunk Cloud); dist/delvecat-<v>-legacy.tgz
# brings its own (Splunk 9.x to 10.3), from the overlay in splunk-app/legacy.
APP_VERSION = $(shell sed -n 's/^version = //p' splunk-app/delvecat/default/app.conf | head -1)
APP_BUILD = splunk-app/delvecat/appserver/static/build
APP_STAGE = dist/stage
APP_TAR = COPYFILE_DISABLE=1 tar --exclude='local' --exclude='local.meta' --exclude='*.pyc' \
	--exclude='.DS_Store' --owner=0 --group=0 --mode='u+rwX,go+rX,go-w' -czf
APP_LIB = splunk-app/delvecat/bin/lib
# Splunk 10.4+ and Splunk Cloud run the command on Python 3.13 with the current SDK;
# the legacy package (Splunk 9.x to 10.3) on Python 3.9, with the last SDK for it.
SDK = splunk-sdk==3.0.1
SDK_LEGACY = splunk-sdk==2.1.1
define vendor  # $(1) target dir, $(2) Python version, $(3) SDK requirement
	rm -rf $(1) && mkdir -p $(1)
	cd ingestion && uv pip install --quiet --target $(abspath $(1)) --python-version $(2) \
		--python-platform linux -r ../splunk-app/requirements.txt "$(3)"
	# PyYAML falls back to pure Python without its compiled part; no scripts, no caches.
	find $(1) -name '*.so' -delete
	rm -rf $(1)/bin $(1)/_yaml
	cp -r ingestion/src/delvecat_ingest $(1)/delvecat_ingest
	find $(1) -name __pycache__ -prune -exec rm -rf {} +
endef
splunk-app-lib:  ## the Python packages | delvecatbuild needs (pure Python)
	$(call vendor,$(APP_LIB),3.13,$(SDK))

splunk-app: splunk-app-lib
	cd web && npx tsc -b && npx vite build --mode splunk
	rm -f $(APP_BUILD)/index.html
	cp -r web/public/reference $(APP_BUILD)/reference
	rm -rf $(APP_STAGE) && mkdir -p $(APP_STAGE)/legacy
	$(APP_TAR) dist/delvecat-$(APP_VERSION).tgz -C splunk-app delvecat
	cp -r splunk-app/delvecat $(APP_STAGE)/legacy/delvecat
	cp -r splunk-app/legacy/. $(APP_STAGE)/legacy/delvecat/
	$(call vendor,$(APP_STAGE)/legacy/delvecat/bin/lib,3.9,$(SDK_LEGACY))
	$(APP_TAR) dist/delvecat-$(APP_VERSION)-legacy.tgz -C $(APP_STAGE)/legacy delvecat
	rm -rf $(APP_STAGE)
	@ls -1 dist/delvecat-$(APP_VERSION)*.tgz
