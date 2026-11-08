# DelveCat Splunk app

The DelveCat web app as a Splunk app: the catalog opens inside Splunk Web, for
the people you choose, with no separate web server. Works on Splunk Enterprise
and Splunk Cloud.

The catalog is still built outside Splunk, by `delvecat-ingest` (or
`scripts/Build-Catalog.ps1`), and then published into the app. Building it
inside Splunk on a schedule is a later phase.

## Packages

```sh
make splunk-app
```

| Package | For |
|---|---|
| `dist/delvecat-<version>.tgz` | Splunk Enterprise 10.4 and later, and Splunk Cloud. Uses Splunk's own page template. |
| `dist/delvecat-<version>-legacy.tgz` | Splunk Enterprise 9.x to 10.3. Brings its own page template, which Splunk 10.4 deprecates. |

Or download them: the *Splunk app* workflow builds both on every push and
attaches them to the run (Actions > Splunk app > the run > Artifacts), with
their AppInspect reports. Pushing a tag `v<version>` that matches `app.conf`
publishes them as a GitHub release.

Both pass Splunk AppInspect's Splunk Cloud checks with no failures (the legacy
package warns about its template). Tested on Splunk 9.4 (legacy) and 10.4.

## Install

1. **Install the app.** Enterprise: *Apps > Manage apps > Install app from
   file*. Splunk Cloud: upload it as a private app (*Apps > Manage apps >
   Upload app*, or `acs apps install private`). Cloud vets it on upload.
2. **Create two roles** (*Settings > Roles*). They need no capabilities; the
   app's permissions refer to them by name:
   - `delvecat_user`: may open the app and read the catalog. Add it to the
     people who should see the catalog.
   - `delvecat_publisher`: may replace the catalog. Give it to one service
     account, with a token (*Settings > Tokens*).

   Until the roles exist, only admins see the app. Someone without
   `delvecat_user` does not see the app at all (Splunk answers "app not found").
3. **Publish a catalog** (next section). Then open *DelveCat* from Splunk's
   app menu.

## Publish a catalog

```sh
export DELVECAT_PUBLISH_TOKEN=...   # token of the account with delvecat_publisher
cd ingestion
uv run delvecat-ingest publish ../catalog --url https://sh.example.com:8089
```

or, from PowerShell, add `-PublishUrl https://sh.example.com:8089` to
`Build-Catalog.ps1`. `--dry-run` checks access and prints the size without
writing; an unchanged catalog is not rewritten (`--force` does).

Splunk Cloud: the management port (8089) must allow your build machine's IP
address (ACS `search-api` allowlist), as for reading Splunk.

Publish to one search head of a search head cluster: the KV store replicates
the catalog to the others.

## What the app stores, and who can see it

The catalog lives in the app's KV store collection `delvecat_catalog`:
gzip-compressed JSON, base64-encoded, in parts of 4 MB (a KV store document is
limited in size), plus a pointer document `current`. A new catalog is written as
a new generation; the pointer switches to it in one write, then older
generations are deleted, so a page loading meanwhile never mixes two catalogs
(the pointer's sha256 checks it).

| | Read | Write |
|---|---|---|
| The app | `admin`, `sc_admin`, `delvecat_user`, `delvecat_publisher` | `admin`, `sc_admin` |
| `delvecat_catalog` | the same | `admin`, `sc_admin`, `delvecat_publisher` |

(`metadata/default.meta`.) The page reads the catalog with the viewer's own
Splunk session, so these permissions decide who sees it. The catalog is
deliberately not a file in the app's static folder: Splunk serves those to any
logged-in user.

**Writing to Splunk.** `delvecat-ingest publish` is the only command that
writes, and it may write only this collection: `POST` to its `batch_save` and
`DELETE` of its older documents (`transport.publish_allowlist`). Every other
request DelveCat sends is read-only, as before.

Everyone with `delvecat_user` sees the whole catalog: every index, search,
role and user it describes, including objects their own Splunk permissions
hide. Give the role accordingly, or publish a redacted catalog
(`--redact-profile internal` or `public` when building).

## Size

A catalog of 88,000 objects and 292,000 relationships is 6.6 MB compressed:
it publishes in about 6 seconds and opens in Splunk in about 4.

## Notes

- The page has DelveCat's own header (not Splunk's bar); its *Splunk* button
  goes back to Splunk's home page.
- After upgrading the app by hand (not through *Manage apps*), Splunk Web may
  serve the old files until an admin opens `/en-US/_bump`.
- The SQL console (SQLite as WebAssembly) works inside Splunk Web.

## Layout

```
splunk-app/
  delvecat/                 the app (built page goes to appserver/static/build/)
    default/app.conf, collections.conf, data/ui/{nav,views}
    metadata/default.meta   permissions
    appserver/static/pages/catalog.js   loads the page (Splunk's templates load pages/<view>.js)
  legacy/                   overlay for Splunk 9.x to 10.3: the view and its template
```
