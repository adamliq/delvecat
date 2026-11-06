import json

from delvecat_ingest.dashboards import parse_dashboard


def test_simple_xml_inline_saved_and_post_process():
    xml = """<form version="1.1"><label>Web</label>
  <search id="base"><query>index=web | fields status uri</query></search>
  <fieldset><input type="dropdown" token="host"><label>Host</label>
    <search><query>| tstats count where index=web by host</query></search></input></fieldset>
  <row><panel><title>Errors</title><table>
    <search base="base"><query>| search status>=500 | stats count by uri</query></search>
  </table></panel>
  <panel><chart><title>Top pages</title><search ref="Web - Top Error Pages"/></chart></panel></row>
</form>"""
    framework, searches, warnings = parse_dashboard(xml)
    assert framework == "simpleXmlForm" and warnings == []
    got = [(s.kind, s.title, s.query, s.ref, s.base) for s in searches]
    assert got == [
        ("inline", None, "index=web | fields status uri", None, None),
        ("inline", "Host", "| tstats count where index=web by host", None, None),
        ("postProcess", "Errors", "| search status>=500 | stats count by uri", None, "base"),
        ("savedSearch", "Top pages", None, "Web - Top Error Pages", None),
    ]


def test_dashboard_studio_definition():
    definition = {
        "dataSources": {
            "ds1": {"type": "ds.search", "options": {"query": "index=firewall | timechart count"}},
            "ds2": {"type": "ds.savedSearch", "options": {"ref": "Firewall - Denied"}},
            "ds3": {"type": "ds.chain", "options": {"extend": "ds1", "query": "| head 5"}},
        },
        "visualizations": {
            "v1": {
                "type": "splunk.line",
                "title": "Blocked over time",
                "dataSources": {"primary": "ds1"},
            }
        },
    }
    xml = (
        f'<dashboard version="2"><label>SOC</label><definition><![CDATA['
        f"{json.dumps(definition)}]]></definition></dashboard>"
    )
    framework, searches, _ = parse_dashboard(xml)
    assert framework == "dashboardStudio"
    assert [(s.kind, s.title, s.query, s.ref, s.base) for s in searches] == [
        ("inline", "Blocked over time", "index=firewall | timechart count", None, None),
        ("savedSearch", None, None, "Firewall - Denied", None),
        ("postProcess", None, "| head 5", None, "ds1"),
    ]


def test_hostile_or_broken_xml_is_reported_not_raised():
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
        '<!ENTITY lol2 "&lol;&lol;&lol;">]><dashboard>&lol2;</dashboard>'
    )
    framework, searches, warnings = parse_dashboard(bomb)
    assert searches == [] and warnings and "could not parse" in warnings[0]
    assert parse_dashboard("<dashboard><row>")[2]
    assert parse_dashboard("") == ("other", [], [])
    assert parse_dashboard('<view template="x"/>')[0] == "html"
