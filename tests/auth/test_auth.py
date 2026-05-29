"""
Auth team's integration tests (pytest).

Auth-service now does real token validation. The tests exercise the contract:
  * valid token + sufficient scope → 200 {authorized:true}
  * unknown token                  → 401 {error:"invalid_token"}
  * known token, wrong scope       → 403 {error:"insufficient_scope"}

Connection failure (e.g. scaled to zero) is still its own honest signature.

Standalone run:
    AUTH_URL=http://localhost:3001 pytest tests/auth/test_auth.py -v
"""
import os
import pytest
import requests

AUTH_URL = os.environ.get("AUTH_URL", "http://localhost:3001")
REQUEST_TIMEOUT_S = float(os.environ.get("AUTH_REQUEST_TIMEOUT_S", "5"))


def _post(token=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        return requests.post(
            f"{AUTH_URL}/authorize",
            headers=headers,
            json={"orderId": "auth-test-probe"},
            timeout=REQUEST_TIMEOUT_S,
        )
    except requests.RequestException as exc:
        pytest.fail(
            f"AUTH-SERVICE UNREACHABLE at {AUTH_URL}: {exc}. "
            "The service is down, the pod is terminating, or there's a "
            "network/DNS problem."
        )


def test_valid_token_authorizes():
    resp = _post(token="demo-token-good")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code} body={resp.text!r}"
    body = resp.json()
    assert body.get("authorized") is True, f"expected authorized:true, got {body}"
    assert "orders:create" in (body.get("scope") or []), f"expected orders:create in scope, got {body}"


def test_missing_token_rejected_401():
    resp = _post(token=None)
    assert resp.status_code == 401, f"expected 401, got {resp.status_code} body={resp.text!r}"
    assert resp.json().get("error") == "invalid_token"


def test_unknown_token_rejected_401():
    resp = _post(token="not-a-real-token-xxx")
    assert resp.status_code == 401, f"expected 401, got {resp.status_code} body={resp.text!r}"
    assert resp.json().get("error") == "invalid_token"


def test_insufficient_scope_rejected_403():
    resp = _post(token="demo-token-readonly")
    assert resp.status_code == 403, f"expected 403, got {resp.status_code} body={resp.text!r}"
    assert resp.json().get("error") == "insufficient_scope"
