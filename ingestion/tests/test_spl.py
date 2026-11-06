import pytest

from delvecat_ingest.spl import analyze, expand_macros, split_top


def refs(spl, macros=None, **kw):
    resolver = (lambda name: macros.get(name)) if macros else None
    return sorted(analyze(spl, resolver, **kw).refs)


def R(edge, type_, name, pattern=False):
    return (edge, type_, name, pattern)


def test_split_respects_quotes_brackets_and_backticks():
    assert split_top('index=a "x|y" | stats count | eval b="|"', "|") == [
        'index=a "x|y" ',
        " stats count ",
        ' eval b="|"',
    ]
    assert split_top("search [search index=b | head 1] | stats c", "|") == [
        "search [search index=b | head 1] ",
        " stats c",
    ]
    assert split_top("`m(a|b)` | x", "|") == ["`m(a|b)` ", " x"]


@pytest.mark.parametrize(
    "spl,expected",
    [
        (
            "index=web sourcetype=access_combined status=500",
            [R("reads", "index", "web"), R("reads", "sourcetype", "access_combined")],
        ),
        (
            'search index="web" sourcetype = "access combined"',
            [R("reads", "index", "web"), R("reads", "sourcetype", "access combined")],
        ),
        ("INDEX=web", [R("reads", "index", "web")]),
        ("index::web", [R("reads", "index", "web")]),
        (
            "index=web* OR index=summary_?",
            [R("reads", "index", "summary_?", True), R("reads", "index", "web*", True)],
        ),
        (
            'index IN (web, firewall) sourcetype IN ("a",b)',
            [
                R("reads", "index", "firewall"),
                R("reads", "index", "web"),
                R("reads", "sourcetype", "a"),
                R("reads", "sourcetype", "b"),
            ],
        ),
        ("index=web NOT index=summary_web index!=_internal", [R("reads", "index", "web")]),
        ("index=web NOT (index=a OR sourcetype=b)", [R("reads", "index", "web")]),
        ("index=web NOT (NOT index=a)", [R("reads", "index", "a"), R("reads", "index", "web")]),
        (
            "eventtype=failed_login tag=authentication tag::action=success",
            [
                R("uses", "eventtype", "failed_login"),
                R("uses", "tag", "authentication"),
                R("uses", "tag", "success"),
            ],
        ),
        ('index=web "index=notreal" uri="/index=x"', [R("reads", "index", "web")]),
    ],
)
def test_base_search_terms(spl, expected):
    assert refs(spl) == expected


def test_eval_and_where_fields_named_index_are_not_reads():
    assert refs('index=web | eval index="other" | where index="x" | stats count by index') == [
        R("reads", "index", "web")
    ]


@pytest.mark.parametrize(
    "spl,expected",
    [
        ("| tstats count where index=fw by sourcetype", [R("reads", "index", "fw")]),
        (
            "| tstats summariesonly=t count from datamodel=Network_Traffic.All_Traffic "
            "where All_Traffic.action=blocked by All_Traffic.src",
            [R("reads", "dataModel", "Network_Traffic")],
        ),
        (
            "| datamodel Authentication Failed_Authentication search",
            [R("reads", "dataModel", "Authentication")],
        ),
        ("| pivot Acme_Web Requests count(Requests) AS c", [R("reads", "dataModel", "Acme_Web")]),
        ("| from datamodel:Acme_Web.Requests", [R("reads", "dataModel", "Acme_Web")]),
        ("| from lookup:asset_owners", [R("reads", "lookup", "asset_owners")]),
        (
            "| inputlookup append=t asset_owners.csv where owner=netops",
            [R("reads", "lookup", "asset_owners.csv")],
        ),
        (
            "index=fw | lookup local=t asset_owners ip AS src_ip OUTPUT owner",
            [R("reads", "index", "fw"), R("uses", "lookup", "asset_owners")],
        ),
        (
            "index=fw | stats count by src | outputlookup create_empty=f fw_counts.csv",
            [R("reads", "index", "fw"), R("writes", "lookup", "fw_counts.csv")],
        ),
        (
            "index=web | stats count | collect index=summary_web source=x",
            [R("reads", "index", "web"), R("writes", "index", "summary_web")],
        ),
        (
            "index=web | stats count | collect",
            [R("reads", "index", "web"), R("writes", "index", "summary")],
        ),
        (
            '| savedsearch "Web - Top Error Pages"',
            [R("reads", "savedSearch", "Web - Top Error Pages")],
        ),
        (
            '| loadjob savedsearch="admin:acme_web:Web - Top Error Pages"',
            [R("reads", "savedSearch", "Web - Top Error Pages")],
        ),
        ("| metadata type=sourcetypes index=web", [R("reads", "index", "web")]),
        (
            "| mstats avg(cpu) WHERE index=infra_metrics span=1m",
            [R("reads", "index", "infra_metrics")],
        ),
        ("| rest /services/server/info | table version", []),
    ],
)
def test_commands(spl, expected):
    assert refs(spl) == expected


def test_subsearches_are_followed():
    spl = (
        "index=web [search index=firewall action=blocked | fields src_ip"
        " | rename src_ip AS clientip]"
        " | join type=left clientip [| inputlookup asset_owners.csv]"
        " | append [search index=wineventlog | stats count]"
    )
    assert refs(spl) == [
        R("reads", "index", "firewall"),
        R("reads", "index", "web"),
        R("reads", "index", "wineventlog"),
        R("reads", "lookup", "asset_owners.csv"),
    ]


MACROS = {
    "web_idx": ("index=web sourcetype=access_combined", []),
    "rare_port_threshold(1)": ("stats count by src_ip, dest_port | where count >= $min$", ["min"]),
    "outer(2)": ("`web_idx` status=$code$ | `limit($n$)`", ["code", "n"]),
    "limit(1)": ("head $n$", ["n"]),
    "loop": ("`loop`", []),
}


def test_macro_expansion_with_args_and_nesting():
    text, used, unresolved = expand_macros("`outer(500, 10)` | stats count", MACROS.get)
    text = " ".join(text.split())
    assert "index=web sourcetype=access_combined status=500" in text
    assert "head 10" in text
    assert used == ["outer(2)"]
    assert unresolved == []


def test_macro_reads_are_attributed_and_direct_macros_listed():
    a = analyze("`outer(404, 5)` | `rare_port_threshold(3)` | lookup missing_lookup ip", MACROS.get)
    assert ("reads", "index", "web", False) in a.refs
    assert ("uses", "macro", "outer(2)", False) in a.refs
    assert ("uses", "macro", "rare_port_threshold(1)", False) in a.refs
    assert ("uses", "macro", "web_idx", False) not in a.refs  # nested: belongs to outer
    assert a.macros == ["outer(2)", "rare_port_threshold(1)"]
    assert not a.implicit_index


def test_unresolved_and_recursive_macros():
    a = analyze("`nope` index=web | `other(1,2)`", MACROS.get)
    assert a.unresolved_macros == ["nope", "other(2)"]
    assert ("reads", "index", "web", False) in a.refs
    b = analyze("`loop` index=x", MACROS.get)
    assert "(macro nesting too deep)" in b.unresolved_macros


def test_macro_names_with_empty_parens_and_quoted_backticks():
    assert expand_macros('`web_idx()` "`not_a_macro`"', MACROS.get)[1] == ["web_idx"]


def test_implicit_index_and_fragments():
    assert analyze("error OR fail | stats count").implicit_index
    assert not analyze("index=web error").implicit_index
    assert not analyze("| makeresults").implicit_index
    assert not analyze("EventCode=4625", fragment=True).implicit_index
    assert not analyze("eventtype=failed_login | stats count").implicit_index


def test_dashboard_tokens_are_dynamic():
    a = analyze("index=$idx$ sourcetype=access_combined | lookup $lk$ x")
    assert a.dynamic
    assert sorted(a.refs) == [R("reads", "sourcetype", "access_combined")]
    assert not a.implicit_index  # a token may well be an index


def test_empty_and_garbage_do_not_crash():
    for spl in (
        "",
        "   ",
        "|",
        "| | |",
        "index=",
        '"unterminated',
        "[[[",
        "`",
        "NOT",
        "(((index=a",
    ):
        analyze(spl)


def test_comments_are_ignored():
    a = analyze(
        "index=web ```skip `fake_macro` index=hidden``` | stats count ```end```", MACROS.get
    )
    assert sorted(a.refs) == [R("reads", "index", "web")]
    assert a.unresolved_macros == []


def test_token_built_macros_are_dynamic_not_unresolved():
    a = analyze("`$base_search$($host|s$)` | `dmc_$type$_rangemap`", MACROS.get)
    assert a.unresolved_macros == [] and a.dynamic
