from delvecat_ingest.redact import redact


def test_redact_drops_secret_keys_recursively():
    data = {
        "host": "db01",
        "password": "hunter2",
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
