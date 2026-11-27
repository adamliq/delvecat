# Incremental builds: design (not implemented)

Status: proposal, 0.47.0. Nothing here is built yet; it needs measurements on a large
real stack first (see "Before building it").

## The problem

Every build reads everything again: each app, knowledge object, index, input, role and
user through Splunk's REST API, plus the searches for usage and data (index sizes,
sourcetypes seen, usage of searches and dashboards). On a large estate most of that has
not changed since the last build.

Two different costs make up a build, and incremental reading helps only one:

| Part | What it costs | Helped by reading only what changed? |
|---|---|---|
| Reading Splunk (REST + searches) | depends on the stack: number of objects, network, search load | **yes**: the main reason to do this |
| Working it out (lineage, health, governance, quality, risk, writing) | 186 s for 1,008,734 synthetic objects in Splunk's Python (assemble 95 s, governance 72 s) | no: these look at the whole catalog (an index's health depends on every search reading it) |

The synthetic catalogs measure only the second part (they are generated, not read), so
there is no measurement yet of how long reading a large real stack takes, and therefore
of what this would save.

## Proposed design

1. **Inventory first, cheaply.** For each REST collection, list entries with only their
   names, owner/app and `updated` time (Splunk's `f=` and `count=0` parameters), not
   their content.
2. **Read in full only what is new or changed**: entries whose `updated` is later than
   in the previous catalog (already read with `--previous` / the published catalog), or
   that are not in it.
3. **Carry the rest over** from the previous catalog unchanged; **drop** entries the
   inventory no longer lists (deleted).
4. **Searches on their own schedule.** Usage and data searches (time windows over
   _internal, _audit, introspection) cannot be incremental; run them on every build as
   now, or less often with the last results carried over and their age shown.
5. **Then work everything out as today** over the whole catalog, so lineage, health,
   governance and risk stay exactly as a full build would give.
6. **A full build regularly** (for example weekly, and whenever the app is upgraded),
   and a "Full build" choice on the Build page.

## Risks to check

- **Changes that do not move `updated`.** Permission (ACL) changes, changes in an app's
  default/ files after an app upgrade, and objects affected by a changed macro or
  lookup may not update an entry's time. Each kind needs checking on a real Splunk;
  where it does not move, that collection is always read in full.
- **Connectors without change times.** ES, SOAR, DB Connect and Stream have their own
  APIs; those without a reliable change time are read in full.
- **Silent drift.** An incremental build that misses a change looks complete. Mitigation:
  the regular full build, and comparing incremental and full results on a test stack in
  the end-to-end tests (same objects, same relationships, apart from times).
- **Complexity.** Every connector gains a second path; this is the largest change
  proposed so far.

## Before building it

1. Measure a full build's reading time against a large real stack (by REST collection
   and by search), to know what incremental reading can save.
2. On the test Splunk, check which kinds of change move `updated` (edit, permission
   change, app upgrade, disable, move between apps).
3. If reading is a large share of build time, implement steps 1 to 3 for the largest
   REST collections first (saved searches, macros, eventtypes, lookups, fields), with
   the incremental-against-full comparison as its test.
