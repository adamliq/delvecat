"""Credit objects to the Splunk product whose app they live in.

Platform extractors catalogue everything as ``product: splunk``. Objects that
live in a product's apps (for example ES's ``SA-*`` and ``DA-ESS-*`` apps) are
re-attributed so the catalog can be filtered by product. App names follow the
products' published app IDs; adjust ``APP_PRODUCTS`` if yours differ.
"""

from __future__ import annotations

import re
from typing import Any

APP_PRODUCTS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"^(SplunkEnterpriseSecuritySuite|SA-[A-Za-z]+|DA-ESS-.+|missioncontrol)$"),
        "enterpriseSecurity",
    ),
    (re.compile(r"^(phantom|splunk_app_soar)$"), "soar"),
    (
        re.compile(r"^(SplunkAssetRiskIntelligence|splunk_asset_risk_intelligence|SA-ARI.*)$"),
        "assetRiskIntelligence",
    ),
    (re.compile(r"^(Splunk-UBA|Splunk_TA_ueba|splunk_app_ueba|SA-UEBA.*)$"), "ueba"),
    (re.compile(r"^splunk_app_stream$"), "stream"),
    (re.compile(r"^splunk_app_db_connect$"), "dbConnect"),
]


def product_for_app(app: str | None) -> str | None:
    if not app:
        return None
    for pattern, product in APP_PRODUCTS:
        if pattern.match(app):
            return product
    return None


def attribute_products(entities: list[dict[str, Any]]) -> int:
    """Re-attribute platform objects living in product apps; return how many changed."""
    changed = 0
    for e in entities:
        if e.get("product") != "splunk":
            continue
        app = e["name"] if e["type"] == "app" else e.get("app")
        product = product_for_app(app)
        if product:
            e["product"] = product
            changed += 1
    return changed
