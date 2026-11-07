from delvecat_ingest.spl_fields import analyze_fields


def used(spl):
    return {u["name"]: u["how"] for u in analyze_fields(spl).to_json()["used"]}


def outputs(spl):
    o = analyze_fields(spl).to_json().get("outputs")
    return None if o is None else {x["name"]: x["from"] for x in o}


def test_filters_aggregates_and_group_by():
    spl = (
        "index=fw sourcetype=acme:fw action=blocked dest_port>1024 NOT src_zone=trusted "
        "| stats count dc(dest_port) as ports by src_ip | where ports > 20"
    )
    assert used(spl) == {
        "action": ["filter"],
        "dest_port": ["filter", "aggregate"],
        "src_zone": ["filter"],
        "src_ip": ["groupBy", "output"],
    }
    assert outputs(spl) == {"count": [], "ports": ["dest_port"], "src_ip": ["src_ip"]}


def test_meta_and_internal_fields_are_not_source_fields():
    assert used("index=web sourcetype=access_combined earliest=-1d | stats count by _time") == {}


def test_eval_and_rename_trace_derived_fields_to_their_sources():
    spl = (
        "index=web status>=500 | eval slow=if(response_time>2,1,0), user=lower(user) "
        "| rename clientip as src | stats sum(slow) as slow_count by user, src "
        "| sort - slow_count | table user src slow_count"
    )
    u = used(spl)
    assert u["response_time"] == ["eval"]
    assert u["user"] == ["eval", "output"]
    assert u["clientip"] == ["rename"]
    assert "slow" not in u and "slow_count" not in u and "src" not in u
    assert outputs(spl) == {"user": ["user"], "src": ["clientip"], "slow_count": ["response_time"]}


def test_quoted_field_names_and_functions():
    u = used(
        'index=x | where like(\'user name\', "a%") AND isnotnull(dest) | eval n=len("literal")'
    )
    assert u == {"user name": ["filter"], "dest": ["filter"]}


def test_lookup_inputs_and_outputs():
    spl = (
        "index=fw | lookup asset_owners ip AS dest_ip OUTPUT owner AS dest_owner, site "
        "| table dest_ip dest_owner site"
    )
    assert used(spl) == {"dest_ip": ["lookup", "select", "output"]}
    assert outputs(spl) == {"dest_ip": ["dest_ip"], "dest_owner": ["dest_ip"], "site": ["dest_ip"]}


def test_rex_iplocation_and_bin_create_fields():
    spl = (
        'index=os EventCode=4625 | rex field=Message "Account Name:\\s+(?<acct>\\S+)" '
        "| iplocation prefix=src_ src | bin _time span=1h | stats count by acct, src_Country"
    )
    assert used(spl) == {"EventCode": ["filter"], "Message": ["extract"], "src": ["enrich"]}
    assert outputs(spl) == {"count": [], "acct": ["Message"], "src_Country": ["src"]}


def test_tstats_on_a_data_model():
    a = analyze_fields(
        "| tstats summariesonly=t count from datamodel=Authentication "
        "where Authentication.action=failure by Authentication.user span=1h"
    )
    assert a.source == "datamodel"
    assert {u["name"]: u["how"] for u in a.to_json()["used"]} == {
        "Authentication.action": ["filter"],
        "Authentication.user": ["groupBy", "output"],
    }


def test_subsearch_outputs_filter_the_outer_search():
    spl = "index=fw [ search index=threat | fields src_ip ] | stats count by dest_ip"
    assert used(spl) == {"src_ip": ["filter", "select"], "dest_ip": ["groupBy", "output"]}
    # A lookup subsearch's fields are not fields of the events.
    assert used("index=fw [| inputlookup bad_ips | fields ip] | stats count") == {"ip": ["filter"]}


def test_other_sources():
    assert analyze_fields('| inputlookup assets where owner="soc" | table ip').source == "lookup"
    assert analyze_fields("| rest /services/server/info | table version").source == "other"
    assert (
        analyze_fields("| from datamodel:Web.Web | stats count by Web.status").source == "datamodel"
    )


def test_unknown_shapes_leave_outputs_unknown():
    assert outputs("index=x | stats count by a, b | xyseries a b count") is None
    assert outputs("index=x | eval y=1") is None  # every event field is still there
    assert outputs("index=x | table a b | join a [search index=y]") is None
    # References after an opaque command are not counted as source fields.
    assert used("index=x | stats count by a, b | xyseries a b count | where zzz > 1") == {
        "a": ["groupBy"],
        "b": ["groupBy"],
    }


def test_after_stats_only_its_columns_exist():
    assert used("index=x | stats count by a | where b > 1 | table a count") == {
        "a": ["groupBy", "output"]
    }


def test_dedup_sort_join_and_top():
    u = used(
        "index=web | dedup session_id sortby -_time | join type=left user [search index=hr] "
        "| sort - bytes | top limit=5 uri_path by status"
    )
    assert u == {
        "session_id": ["dedup"],
        "user": ["join"],
        "bytes": ["sort"],
        "uri_path": ["groupBy", "output"],
        "status": ["groupBy", "output"],
    }


def test_tokens_and_wildcards_are_skipped():
    # A token value still filters on the field; token field names and wildcards are skipped.
    assert used("index=web user=$user$ | table src* | stats count by $field$") == {
        "user": ["filter"]
    }
