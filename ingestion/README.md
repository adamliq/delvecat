# delvecat-ingest

Read-only extractor that turns Splunk metadata into a DelveCat catalog bundle.

```bash
uv sync
uv run delvecat-ingest extractors            # list extractors

# From recorded responses (no Splunk needed)
uv run delvecat-ingest build --fixtures tests/fixtures/splunk-9.4-dev --instance acme --out catalog.json

# From a live Splunk Enterprise or Cloud search head (token in DELVECAT_SPLUNK_TOKEN)
uv run delvecat-ingest build --url https://splunk.example.com:8089 --instance prod \
    --previous catalog/ --shard --out catalog/

# Splunk Cloud: also read the Admin Config Service (token in DELVECAT_ACS_TOKEN)
uv run delvecat-ingest build --url https://acme.splunkcloud.com:8089 --instance acme \
    --acs-stack acme --out catalog.json

uv run delvecat-ingest validate catalog/
```

Useful options:

| Option | Purpose |
|---|---|
| `--previous PATH` | previous bundle; adds per-entity versions and a change summary |
| `--shard` | write a directory: `catalog.json` manifest + per-type shards |
| `--fields` | sample events per sourcetype to discover fields (`--max-field-sourcetypes`) |
| `--inventory-window` | time range for observed sourcetypes/hosts/sources (default `-7d`) |
| `--only a,b` | run selected platform extractors (product connectors are skipped unless `--products` is given) |
| `--products` | `deploymentServer,dbConnect,stream`, `all` (default) or `none`; each is skipped when not installed |
| `--deployment-apps-dir` | the Deployment Server's deployment-apps folder, to catalogue the inputs each app pushes |
| `--record DIR` | save every response as replayable fixtures (secrets and emails removed) |
| `--no-usage` | skip the usage and health searches over `_audit` and `_internal` |
| `--usage-window` / `--health-window` | time ranges for usage (default `-30d`) and scheduler/parsing checks (`-7d`) |
| `--strict` | exit 3 if any extractor failed |

## Lineage

Every bundle includes lineage derived from SPL in saved searches, dashboards,
eventtypes, macros, data models and workflow actions (no extra Splunk calls).
Objects that reference something missing or not shared get
`entity.lineage.unresolved`; searches without an index get
`entity.lineage.implicitIndex`.

## Products

| Connector | Source | Notes |
|---|---|---|
| Deployment Server | `deployment/server/{serverclasses,applications,clients}`, `configs/conf-serverclass`, optional deployment-apps folder | verified against Splunk 9.4 with a real universal forwarder |
| DB Connect | `configs/conf-{identities,db_connections,db_inputs,db_outputs,db_lookups}` in `splunk_app_db_connect` | identity user names and passwords are never collected; key names follow DB Connect 3.x docs and should be checked against your version |
| Enterprise Security | saved searches (`action.correlationsearch.*`, `action.escu.*`), `alerts/alert_actions`, `configs/conf-inputs` (`threatlist://`, `identity_manager://`), `configs/conf-analyticstories` | verified against ES-format content in a dev Splunk |
| SOAR (`--soar-url`, token in `DELVECAT_SOAR_TOKEN`) | `/rest/{version,app,asset,playbook,custom_function}` | asset configuration is never read; sample responses only so far |
| UEBA (`--ueba-url`, token in `DELVECAT_UEBA_TOKEN`) | UBA REST, paths overridable with `--ueba-path kind=/path` | **unverified** paths and fields |
| Stream | KV store collections `streams`, `streamforwardergroups` in `splunk_app_stream`; forwarders from `stream:*` data | document fields follow the Stream app and should be checked against your version |

Machines are tied to the `host` values in the data by hostname (case-insensitive,
short name against FQDN), so lineage answers "which forwarders, databases and
streams feed index X". Run against each instance that holds a product (for
example the Deployment Server and the DB Connect heavy forwarder); combining
several instances into one bundle is on the roadmap.

## Usage and health

Usage comes from `_audit` and `_internal`, so the service account needs to
search them. DelveCat's own searches carry the comment ```` ```delvecat-ingest``` ````
and are excluded. Ad-hoc search text is only analyzed in memory; bundles hold
counts, never the searches. A `--record`ing does contain it, so never commit
recordings taken from production.

### Modular inputs and identity groups

Inputs that add-ons define (modular inputs: cloud services, APIs, journald...)
are `input` objects like the built-in kinds, with `modular: true`, the input
kind's title and `feeds` edges to their index and sourcetype. Their own settings
are listed by name only (`settingNames`): values can be accounts, queues or keys.

SAML and LDAP groups mapped to Splunk roles are `authGroup` objects with
`memberOf` edges to those roles, so a group reaches what its roles reach. An
LDAP group records its strategy and how many members it has, never who they
are. The instance records how people log in (`authentication`: Splunk, LDAP or
SAML, with LDAP strategies by name and SSL only; no bind DN, password or host).

### Enterprise Security triage

The `enterpriseSecurity` part also reads how findings are handled:

- `esReviewStatus`: the statuses findings and investigations move through
  (`/services/alerts/reviewstatuses`): type, default, whether it closes them.
- `esSuppression`: finding (notable) suppressions
  (`alerts/suppressions`, eventtypes `notable_suppression-<name>`) with their
  search, the detections they name (`source=`, `uses` edges) and time window,
  and, from ES 8, finding suppression rules. A suppression whose window has ended
  gets `suppressionExpired` and goes to the cleanup report; one that names only a
  detection gets `suppressesWholeDetection` (every finding of it is hidden).
- ES 8 (Mission Control, `/servicesNS/nobody/missioncontrol`):
  `esAggregationRule` (finding aggregation into finding groups),
  `esAutomationRule` (playbooks run on matching findings; edges to detections
  and SOAR playbooks), `esQueue` (with read/write roles) and the `soarApp`s
  configured for ES. Plain settings are kept; anything named like a secret,
  token, password or key is not. ES 7 has no Mission Control: those are skipped.

- ES 8 response plans (`missioncontrol/public/v2/responseplans`, the
  organisation's plans; ES 7 called them response templates) as
  `responseTemplate`: name, description, creator, created, updated and by whom,
  status (published or draft) and the template it came from.

The Mission Control responses are read defensively (a list, or an object holding
one; names from `name`/`title`/`label`): their shapes were not available to test
against a live ES 8.

### SPL2 (Splunk 10 and later)

Part `spl2` reads Splunk's Data Orchestrator (`/services/orchestrator/v1`, a
splunkd sidecar; GET requests only):

- `spl2Connection`: the Splunk deployments SPL2 runs against, with name, host,
  port and account only (no secret is returned). Published connections, plus
  drafts not yet published (`status`).
- `spl2Module`: SPL2 code saved in an app: owner, version, description, source
  (`definition`) and permissions (read and write roles, from the module
  permissions API). `from <dataset>` statements become `reads` edges to the
  index, lookup or saved search, as the orchestrator's own dataset list names
  them; `from $statement` references within the module are not datasets.
- `spl2Dataset`: datasets of SPL2-native kinds (anything but indexes, lookups
  and saved searches, which are catalogued as themselves): Federated Analytics
  datastores on AWS (`fa_aws_lake`, `fa_aws_s3`), Azure (`azure_blob`,
  `azure_abs` for Azure Blob Storage / Data Lake Storage, and `dmx_azure_blob`
  export destinations), Snowflake and others. Each records its `dataSource`
  (AWS, Azure, Snowflake, DDSS, Splunk), its `connection` (a `uses` edge to the
  connection) and where the data is: storage account, container, directory, file
  prefix, format and compression (or region and bucket, database and table).
  The dataset's secret (`datasetSecret`) is never read.
- Unified (Federated Analytics) connections are `spl2Connection` objects too,
  with `dataSource`, connection type, capabilities, access level, the
  authentication methods used (e.g. `servicePrincipal`) and, for Azure, the
  Entra ID tenant id. Credentials (`auths`) are never read.

Azure datastores and unified connections are Splunk Cloud features (behind
Splunk's Federated Analytics flags); Splunk Enterprise 10.4 refuses to create
them, so they are tested against the shapes of Splunk's own request schemas.

Splunk 9.x has no orchestrator: the part is reported as skipped. After a
restart the orchestrator answers 404 for about a minute until it is up. Listing
modules needs `list_spl2_modules`. The public profile drops connection hosts and
pseudonymizes their accounts; it also drops storage accounts, containers,
directories, buckets and the Azure tenant id.

### Data Management catalog

Part `dataManagementCatalog` reads the Data Management metadata catalog
(`splunk-data-management` app, `mdc/v1alpha2/catalog-objects`, paged): each
object as `dmCatalogObject` with name, resource name, kind, type, namespace,
creator and created time; one describing an index `mapsTo` it. Served by a
Splunk Cloud service: Splunk Enterprise 10.4 has the app but not the service,
and the part is skipped.

### Index-time routing, filtering and masking

Transforms record what they do at index time (`properties.indexTime`): route to
another index (`DEST_KEY = _MetaData:Index`), drop (`queue` = `nullQueue`), keep
only matching events (`indexQueue`), forward (`_TCP_ROUTING`, `_SYSLOG_ROUTING`,
`_HTTP_ROUTING`), rewrite the event (`_raw`), change sourcetype, host or source,
or write indexed fields; `INGEST_EVAL` assignments are read the same way
(string results only; a condition's patterns are not targets). Transforms that
have only an `INGEST_EVAL` are read from `transforms.conf` (Splunk's transform
list leaves them out).

Part `indexTimeRules` reads `props.conf`: each sourcetype's `TRANSFORMS-` rules
link it to its transforms (`uses`), routed data adds `sourcetype feeds index`
and `transform writes index` edges, and the sourcetype records a summary
(`properties.indexTime`) including `SEDCMD-` masking. `source::` and `host::`
rules are recorded on the transform (`appliesTo`). A transform routing to an
index this instance does not have gets a `routeToMissingIndex` warning: where the
data is indexed, events for a missing index are discarded (or go to
`lastChanceIndex`). On a search head, check against the indexers.

### Federated search

`federatedProvider` objects (a remote Splunk deployment, standard or transparent
mode, or Amazon S3 through AWS Glue) and `federatedIndex` objects (the local
name of a remote dataset: an index, saved search, last job, data model or Glue
table) with a `uses` edge to their provider. Searches on
`index=federated:<name>` read the federated index; role patterns
`federated:...` grant access to them. Splunk lists federated indexes among its
indexes too; they are catalogued once. Splunk never lists a provider's
password; the public profile also drops the remote host, AWS account and S3
paths, and pseudonymizes the service account.

### Index storage and retention

Each index records its retention (`retentionDays`, from `frozenTimePeriodInSecs`;
Splunk Cloud's "searchable retention") and size limit (`maxTotalDataSizeMB`, or
`maxGlobalDataSizeMB` with SmartStore): data freezes at whichever comes first.
`storage.tiers` lists hot, warm, cold, frozen and thawed with their location,
size limit and, where Splunk reports them (`data/indexes-extended`), actual size
and buckets. SmartStore indexes (`remotePath`) keep warm buckets in the remote
store and have no cold tier. `frozenAction` says what happens to frozen data:
`delete`, `archiveDir`, `archiveScript`, or in Splunk Cloud `activeArchive`
(Dynamic Data Active Archive, with its retention) or `selfStorage` (Dynamic Data
Self Storage, the customer's bucket). The web app names tiers in both
vocabularies (hot/warm/cold = Splunk Cloud's searchable storage, DDAS). An index
at 90% of its size limit gets a `retentionBySize` warning: it freezes data by size
before its retention period. The public profile drops object-store locations.

### Azure

- Storage: a SmartStore index's warm tier names its object store from the
  `[volume:...]` stanza its `remotePath` uses (`indexes.conf`): Azure Blob
  Storage (`azure://<container>/...`, with the storage account from
  `remote.azure.endpoint`), Amazon S3 (`s3://`) or Google Cloud Storage
  (`gs://`), as `provider`, `bucket` (the container on Azure),
  `storageAccount` and `volume`. Splunk Cloud Self Storage gets the same from its
  bucket path. Keys in the volume stanza are never read. The public profile drops
  locations, buckets and accounts.
- Inputs: see "Microsoft add-ons" below.

### Microsoft add-ons

For the Splunk Add-ons for Microsoft Cloud Services
(`Splunk_TA_microsoft-cloudservices`), Microsoft Office 365 (`splunk_ta_o365`),
Microsoft Azure (`TA-MS-AAD`) and Microsoft Security (`Splunk_TA_MS_Security`):

- Their inputs record `properties.microsoft`: the add-on, the Microsoft service
  read (Event Hubs, Azure Storage, Log Analytics, Azure Monitor metrics, activity
  log, cost and usage, Resource Graph and inventory; Office 365 Management
  Activity, service health, message trace, Teams/SharePoint/OneDrive/mailbox/Viva
  Engage usage reports; Entra ID sign-ins, audit logs, users, groups, apps,
  devices, Identity Protection; Defender for Endpoint, Microsoft 365 Defender
  incidents, Defender for Cloud Apps, Defender for Cloud, Defender Threat
  Intelligence, Graph security alerts), the account or tenant used (a `uses` edge
  to it), and the values of settings that only name things (Event Hub namespace
  and name, consumer group, container, tables, content type, subscription, tenant
  and workspace ids). Every other setting stays names only.
- Part `microsoftAccounts` reads their accounts and tenants from the add-ons' own
  configuration endpoints (`splunk_ta_mscs_azureaccount`,
  `splunk_ta_o365_tenants`, `TA_MS_AAD_account`,
  `Splunk_TA_MS_Security_account`) as `addOnAccount`: tenant id, client
  (application) id, cloud environment, tenant subdomain and data center, auth
  type. Client secrets, passwords, certificates and tokens are never read. The
  public profile drops tenant and client ids. Skipped when none of the add-ons is
  installed.

### Other inputs

Besides the inputs Splunk lists over REST (monitor, TCP, UDP, scripted,
splunktcp, HEC, modular), the inputs only `inputs.conf` lists are catalogued too
(part `otherInputs`): `batch` (with `deletesFilesAfterReading` for sinkhole),
Windows (`WinEventLog`, `perfmon`, `WinRegMon`, `admon`, `WinHostMon`,
`WinNetMon`, `WinPrintMon`), PowerShell, SSL TCP and `fschange`.

### Scheduled views and Pivot reports

A scheduled view (a dashboard rendered as a PDF and emailed on a schedule,
*Export > Schedule PDF Delivery*) is a `scheduledView` object with a `reads`
edge to its dashboard: schedule, subject, paper size and orientation, and its
recipients (same rules and redaction as alert recipients). Its scheduler runs
and failures count as for a scheduled search. Splunk also lists it among saved
searches as `_ScheduledView__<dashboard>`; it is catalogued only once.

A report made in Pivot (`| pivot <data model> <dataset> ...`) records which
(`properties.pivot`), besides the `reads` edge to the data model.

### Authentication tokens

Each Splunk authentication token is an `authToken` object: the user it is for
(an edge from that user), audience, who issued it and when, expiry, last use and
whether it is enabled. Splunk never lists a token's value and DelveCat never
reads one; the client address it was last used from is not kept either. Health
checks flag tokens that expired (delete them), expire within 14 days, never
expire, have not been used for 90 days, or belong to a user Splunk no longer has
(checked only when users were collected). Expired, stale and orphaned tokens
also appear in the cleanup report. The public redaction profile pseudonymizes
token users like every other user name.

### Fired alerts

How often each alert or detection actually triggered in the usage window, not
just ran (`usage.alertFires`, `alertsSuppressed`, `lastFired`). Two records are
combined: the scheduler log (every run, with the actions it triggered and
whether throttling suppressed it) and `_audit` `alert_fired` (tracked alerts,
including ones with no actions); per alert the larger count is used, so nothing
is counted twice. An alert with no record reads 0 ("never fired"). An alert
firing more than 24 times a day on average gets an `alertNoisy` warning.

### Custom search commands

Each command an app adds in `commands.conf` is a `searchCommand` object in that
app, with how it runs: script file and type, protocol (`v2` chunked, or legacy
`v1`), generating or streaming, and Splunk's `risky` flag. Every search,
dashboard panel, macro or other SPL that runs a command gets a `uses` edge to
it, resolved with Splunk's sharing rules (an app-only command serves only its
own app). A search that runs a command its app cannot see lists it under
`lineage.unresolved`. Ad-hoc searches in `_audit` count as use, so a command
nothing runs shows under unused objects. Splunk's compiled commands (`stats`,
`eval`...) are not in `commands.conf` and are not catalogued.

### HTTP Event Collector

Each HEC token is an `input` (kind `http`): its default and allowed indexes,
sourcetype, output group and description, with `feeds` edges to its indexes.
The token value is never read into the catalog. HEC's own settings (on or off
for the whole instance, port, SSL) go on the instance as `httpEventCollector`;
while HEC is off, its tokens feed nothing and are flagged critical.

The `usageHec` part reads HEC's metrics (`_introspection`,
`http_event_collector_metrics`) for events, bytes and errors per token, and
`_internal` (`HttpInputDataHandler` errors) for why requests were rejected,
such as an index the token may not write to. Requests with an invalid token are
only counted, on the instance: the token they tried may be someone's real one.
Health then flags rejected requests and requests to a disabled token, and
cleanup lists tokens that received no events in the usage window.

## Several instances

Build each instance with its own `--instance`, then merge:

```bash
uv run delvecat-ingest build --url https://sh:8089   --instance prod-sh  --out sh.json
uv run delvecat-ingest build --url https://idx1:8089 --instance prod-idx --only serverInfo,indexes --out idx.json
uv run delvecat-ingest build --url https://ds:8089   --instance prod-ds  --only serverInfo \
    --products deploymentServer --deployment-apps-dir /opt/splunk/etc/deployment-apps --out ds.json
uv run delvecat-ingest build --instance soar --soar-url https://soar.example.com --out soar.json
uv run delvecat-ingest merge sh.json idx.json ds.json soar.json --annotations ../annotations \
    --previous catalog/ --shard --out catalog/
```

The merge links what crosses instances: search-head searches to indexer
indexes, role patterns to every matching index, Deployment Server inputs to
the indexes they feed, deployment clients and forwarders to the hosts in the
data, ES detections to SOAR labels, UBA data sources to Splunk indexes. Names
of global objects (indexes, sourcetypes, hosts, SOAR labels) are matched
across instances; an index name configured on several indexer clusters links
to all of them. Merge unredacted bundles and redact the result.

### From PowerShell

`../scripts/Build-Catalog.ps1 -Config catalog.psd1` builds every instance in a
config file ([example](../scripts/catalog.example.psd1)) and merges them as
above, with annotations, redaction, `--previous` and `--shard` applied to the
merge. Tokens are read from environment variables (or asked for without
echoing) and passed to `delvecat-ingest` only through its environment.

## Field discovery

`--fields` samples up to 1,000 events of each of the 100 busiest observed
sourcetypes (`--max-field-sourcetypes`), searching only the indexes the
sourcetype was seen in. `--field-indexes web,app_*` narrows it to the
sourcetypes in those indexes (`*` wildcards), sampled only there.

## Search time limit

Every search a build runs (inventory, hosts, sources, forwarders, field
sampling, usage and health) is cancelled if it runs longer than
`--search-timeout` seconds (default 300; 0 for no limit). Its part is reported
as `failed` with the reason in the bundle's `ingestionReport`, and the build
goes on with the other parts. With a limit, searches run as ordinary search
jobs that DelveCat polls and, past the limit, cancels: the one `control` request
it sends, to its own job.

## Publishing to the Splunk app

```bash
export DELVECAT_PUBLISH_TOKEN=...   # account with the delvecat_publisher role
uv run delvecat-ingest publish catalog/ --url https://sh.example.com:8089
```

Stores the catalog in the DelveCat Splunk app's KV store collection (see
[../splunk-app/README.md](../splunk-app/README.md)). This is the only command
that writes to Splunk, and it can write only that collection. `--dry-run`
checks access and size; an unchanged catalog is not rewritten.

## Publishing safely

Bundles can be redacted before they go anywhere public:

```bash
export DELVECAT_REDACT_SALT=...   # keep secret; stable pseudonyms across builds
uv run delvecat-ingest build ... --redact-profile public --out catalog/
uv run delvecat-ingest redact catalog/ --redact-profile public --out public/   # after the fact
```

| Setting | `internal` | `public` |
|---|---|---|
| real names | drop | drop |
| user names, owners | keep | pseudonymize |
| hosts, forwarders, clients | keep | pseudonymize |
| source paths | keep | pseudonymize |
| IP addresses | keep | mask |
| internal URLs, DB hosts | keep | drop |
| email alert addresses | domain only (`*@corp.example`) | drop |

A YAML file (`--redact-profile-file`) can `extends: public` and change any
setting. Names inside SPL text are not rewritten.

## Safety

The HTTP client refuses any request that could change Splunk: only `GET` is
allowed (minus endpoints that act on GET, such as `_reload`), plus `POST` to
an allow-list of search endpoints (running a search, and cancelling DelveCat's
own search job when it exceeds the search time limit). The one exception is `publish`, which may
also write the DelveCat Splunk app's own catalog collection, and nothing else.
Keys that look like credentials are dropped before anything is written.
Email addresses are collected in one place only: who email alert actions write
to and from (`alertRecipients` on searches; `defaultRecipients` and `sender` on
the email action), as configured, with `$tokens$` kept as written. Users' own
email addresses are not collected, and `--record`ings still drop every email
key. The `internal` redaction profile keeps only the domains, `public` drops them.

The service account needs read access to configuration endpoints, and to
`_internal` for forwarder discovery. Endpoints it cannot read are reported as
`skipped` in the bundle's `ingestionReport` rather than failing the run.

## Tests

```bash
uv run pytest                       # offline, from recorded fixtures
# against the dev container (see ../deploy):
DELVECAT_LIVE_URL=https://localhost:8089 DELVECAT_SPLUNK_TOKEN=$(cat ../deploy/.dev-token) uv run pytest -k live
```
