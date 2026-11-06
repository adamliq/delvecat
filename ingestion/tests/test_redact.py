from delvecat_ingest.redact import redact


def test_redact_drops_secret_keys_recursively():
    data = {
        "host": "db01",
        "password": "hunter2",
        "username": "svc_account",
        "nested": {"api_key": "x", "ph-auth-token": "y", "port": 5432},
        "list": [{"clientSecret": "z", "name": "ok"}],
        "action.webhook.param.url": "https://hooks.example.com",
    }
    assert redact(data) == {
        "host": "db01",
        "nested": {"port": 5432},
        "list": [{"name": "ok"}],
        "action.webhook.param.url": "https://hooks.example.com",
    }


def test_redact_strips_credentials_in_urls():
    assert redact({"url": "https://user:secret@feeds.example.org/x.csv"}) == {
        "url": "https://feeds.example.org/x.csv"
    }
    assert redact(
        ["ftp://anon@host/f", "mailto-ish user@example.com", "https://ok.example/a@b"]
    ) == ["ftp://host/f", "mailto-ish user@example.com", "https://ok.example/a@b"]
