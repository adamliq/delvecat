"""Python 3.9 compatibility (Splunk 9.x bundles Python 3.9; the app runs on it)."""

from datetime import timezone

UTC = timezone.utc  # datetime.UTC is new in Python 3.11
