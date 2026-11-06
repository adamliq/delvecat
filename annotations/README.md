# Annotations

Human-curated metadata for the catalog: descriptions, owners, tags,
classifications, glossary terms and links. They are merged into catalog
bundles at build time (`delvecat-ingest build --annotations annotations` or
`delvecat-ingest annotate`) and are **never written to Splunk**.

Changes go through pull requests like any other code. Each entity page in the
web app has a **Suggest an edit** link that opens the right file on GitHub (or
a pre-filled new file when the entity has no annotation yet).

## Format

Any `*.yaml` file under this directory, in any folder layout. The schema is
[`schemas/annotations.schema.json`](../schemas/annotations.schema.json).

```yaml
annotations:
  # One entity, by its id (shown on every entity page)
  - id: acme:index:web
    description: Storefront access logs from the CDN edge.
    owners: [web-platform]
    tags: [tier-1]
    classifications: [PII.IPAddress]
    glossaryTerms: [Storefront]
    links:
      - title: Runbook
        url: https://wiki.example.com/runbooks/web-index

  # Every entity matching a selector. All keys must match;
  # name, app and owner accept * and ? wildcards.
  - match: {type: savedSearch, app: acme_web}
    owners: [web-platform]

glossary:
  - term: Storefront
    description: The public e-commerce site at shop.example.com.
    synonyms: [shop]
```

Classifications can be defined once in a taxonomy (see `classifications.yaml`):

```yaml
classifications:
  - name: PII            # also covers PII.Email, PII.IPAddress, ...
    sensitive: true      # counts for "who can see sensitive data"
    propagate: true      # carried to data derived from it through lineage
```

Undefined classifications count as sensitive and propagate.

Rules:

- Selector (`match`) entries are applied first, in file order, then `id`
  entries, so specific annotations win over broad ones.
- `owners`, `tags`, `classifications`, `glossaryTerms` and `links` are
  combined; for `description`, the last one applied wins.
- An entry that matches nothing is reported (and fails `--strict` builds),
  as is a glossary term used on an entity but not defined anywhere.

Check your changes locally:

```bash
cd ingestion
uv run delvecat-ingest lint-annotations ../annotations --bundle ../web/public/catalog
```

Avoid personal data here (for example individual email addresses): bundles
published to a public GitHub Pages site are visible to anyone.
