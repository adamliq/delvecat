# DelveCat Splunk app

The DelveCat web app as a Splunk app: the catalog opens inside Splunk Web, for
the people you choose, with no separate web server. Works on Splunk Enterprise
and Splunk Cloud.

There are two ways to get a catalog into it:

- **Build it in Splunk, on demand**: the app's *Build* page (or the search
  command `| delvecatbuild`) reads this Splunk and publishes the catalog. No
  token, no machine outside Splunk. [Details](#build-in-splunk).
- **Build it outside and publish it**: `delvecat-ingest` (or
  `scripts/Build-Catalog.ps1`) then `delvecat-ingest publish`. Needed for a
  catalog of several instances (indexers, Deployment Server, SOAR...),
  annotations from a repository, or the public redaction profile.

## Packages

```sh
make splunk-app
```

| Package | For |
|---|---|
| `dist/delvecat-<version>.tgz` | Splunk Enterprise 10.4 and later, and Splunk Cloud. Splunk's own page template; the build command runs on Python 3.13 with Splunk SDK 3. |
| `dist/delvecat-<version>-legacy.tgz` | Splunk Enterprise 9.x to 10.3. Its own page template (Splunk 10.4 deprecates these); the build command runs on Python 3.9 with Splunk SDK 2. |

Ready-built packages are also committed in [`packages/`](packages/)
(rebuild and replace them with `make splunk-app` after changing the app).

Or download them: the *Splunk app* workflow builds both on every push and
attaches them to the run (Actions > Splunk app > the run > Artifacts), with
their AppInspect reports. Pushing a tag `v<version>` that matches `app.conf`
publishes them as a GitHub release.

The main package passes Splunk AppInspect's Splunk Cloud checks with no
failures. The legacy package fails one, by design: AppInspect no longer
accepts Python 3.9, the only Python Splunk 9.x has; it is not meant for Splunk
Cloud. Tested on Splunk 9.4 (legacy) and 10.4.

## Install

1. **Install the app.** Enterprise: *Apps > Manage apps > Install app from
   file*. Splunk Cloud: upload it as a private app (*Apps > Manage apps >
   Upload app*, or `acs apps install private`). Cloud vets it on upload.
2. **Create two roles** (*Settings > Roles*). They need no capabilities; the
   app's permissions refer to them by name:
   - `delvecat_user`: may open the app and read the catalog. Add it to the
     people who should see the catalog.
   - `delvecat_publisher`: may replace the catalog, from the Build page or
     with `delvecat-ingest publish`. Give it to the people who build (with
     their usual roles: building runs a search, and reads what they can see),
     or to one service account with a token for publishing from outside.

   Until the roles exist, only admins see the app. Someone without
   `delvecat_user` does not see the app at all (Splunk answers "app not found").
3. **Build or publish a catalog** (next sections). Then open *DelveCat* from
   Splunk's app menu.

## Build in Splunk

Open *DelveCat > Build* (shown to admins and `delvecat_publisher`), choose the
parts to read and the options, and press *Build now*. The page follows the build and shows the new
catalog when it is done: about 10 seconds on a small Splunk, minutes on a large
one. The same from a search:

```
| delvecatbuild [fields=<bool>] [usage=<bool>] [redact=none|internal]
                [instance=<id>] [instancename=<name>] [dryrun=<bool>] [replacesmaller=<bool>]
                [parts="<part>,<part>,..."] [searchtimeout=<seconds>]
                [fieldindexes="<index>,<index>,..."]
```

- **What it reads**: this Splunk (the search head the app is on) and the
  products installed on it (Enterprise Security, DB Connect, Stream, Deployment
  Server), over its REST API and with read-only searches of `_internal` and
  `_audit`, exactly as `delvecat-ingest build --url` does. It runs as the
  person who starts it, with their session: **the catalog shows what they can
  see**, so build as an admin for a complete one.
- **Options**: `fields=true` samples events to discover fields (slower; feeds
  schemas, field lineage and quality checks); `usage=false` skips usage and
  health; `redact=internal` drops personal names; `instance` is the id objects
  get (keep it the same between builds, so versions and "first seen" dates
  carry over; the page fills in the current one); `dryrun=true` builds without
  publishing.
- **Parts**: the page lists the 41 parts of a build, in groups (platform, data,
  knowledge objects, usage and health, products), with *Select all* and a box
  per group. Parts marked *search* run Splunk searches; *slow* ones can take a
  while on a large Splunk. Everything but field discovery is selected by
  default. A part's prerequisite comes with it (field discovery needs the data
  inventory). From a search: `parts="indexes,inventory,savedSearches"` (names
  as in `inapp.PARTS`). **Only the selected parts are read, so the published
  catalog holds only what they find**: use it to try a slow part, or on a Splunk
  where some parts are not wanted.
- **Field discovery in chosen indexes**: with field discovery selected, the page
  offers *Discover fields only in indexes* (comma-separated, `*` wildcards,
  suggestions from the current catalog; `fieldindexes="web,app_*"` in a
  search). Only sourcetypes seen in those indexes are sampled, and only there.
  Without it, each sourcetype is still sampled only in the indexes it was seen
  in, never across all indexes.
- **Search time limit**: any single search running longer than this (300
  seconds by default; `searchtimeout=0` for none) is cancelled, and its part
  is reported as timed out while the rest of the build goes on. In field
  discovery, a sourcetype whose sample times out is skipped. The same limit
  applies on the command line (`delvecat-ingest build --search-timeout`).
- **Safeguard**: a catalog with less than half the objects of the current one
  (not counting fields) is not published, because the builder probably sees
  less of Splunk than whoever built the current one. The page says so and
  offers *Build and replace anyway* (`replacesmaller=true`). With only some parts
  selected, that is the expected outcome, and the page says so.
- **One build at a time**: a second build is refused while one runs. *Cancel*
  stops it (it is an ordinary search job, also in *Activity > Jobs*).
- **Replaces** the whole catalog with this Splunk's: a catalog of several
  instances published from outside is replaced (the page warns first).
- **On a schedule**: save `| delvecatbuild` as a scheduled report if you want
  one. It runs as the report's owner.
- **Not in Splunk**: annotations from a repository, the public redaction
  profile (it needs a secret salt), other instances. Use the command line for
  those.

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
| `delvecatbuild` command (Build page) | run: `admin`, `sc_admin`, `delvecat_publisher` | `admin`, `sc_admin` |

(`metadata/default.meta`.) The page reads the catalog with the viewer's own
Splunk session, so these permissions decide who sees it. The catalog is
deliberately not a file in the app's static folder: Splunk serves those to any
logged-in user.

Building in Splunk also keeps a `build` document there: who started the
last build, its progress and result, which the Build page shows.

**Writing to Splunk.** Publishing (`delvecat-ingest publish`, or a build in
Splunk) is the only writing DelveCat does, and it may write only this
collection: `POST` to its `batch_save` and `DELETE` of its older documents
(`transport.publish_allowlist`). Every other request is read-only, as before.

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
    default/app.conf, collections.conf, commands.conf, searchbnf.conf, data/ui/{nav,views}
    metadata/default.meta   permissions
    appserver/static/pages/catalog.js   loads the page (Splunk's templates load pages/<view>.js)
    bin/delvecatbuild.py    the build command; bin/lib/ is filled by make (packages below)
  legacy/                   overlay for Splunk 9.x to 10.3: the view, its template, Python 3.9
  requirements.txt          pure-Python packages bundled in bin/lib (plus delvecat_ingest
                            and the Splunk SDK: 3.x, or 2.x in the legacy package)
```
