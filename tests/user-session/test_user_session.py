"""
User-session team's integration test (pytest).

Covers the human-identity surface the Phase 2 UI will use:
  * GET  /health
  * POST /register (success + duplicate → 409 + missing fields → 400)
  * POST /login    (success → JWT + wrong password → opaque 401)
  * GET  /validate (good JWT → 200 with identity, bad / missing → 401)

This service is independent of the auth-service used by the order pipeline —
the two identity concepts are intentionally separate. user-session is for
HUMANS; auth-service authorizes ORDERS with a static Bearer-token catalogue
and is unrelated to this test.

Standalone run:
    USER_SESSION_URL=http://localhost:3006 pytest tests/user-session/test_user_session.py -v

This test is NOT wired into ci-tests.yml or any TestKube workflow on purpose —
pipeline wiring is deferred.
"""
import os
import uuid
import pytest
import requests

USER_SESSION_URL = os.environ.get("USER_SESSION_URL", "http://localhost:3006")
REQUEST_TIMEOUT_S = float(os.environ.get("USER_SESSION_REQUEST_TIMEOUT_S", "5"))


# Unique email per pytest run so repeated runs against the same DB don't
# collide on /register with a stale 409. The duplicate-register assertion
# below uses a separate email-and-then-re-use trick within ONE run.
SESSION_EMAIL = f"test-{uuid.uuid4().hex[:10]}@example.com"
SESSION_PASSWORD = "correct-horse-battery-staple"


def _post(path, body):
    try:
        return requests.post(f"{USER_SESSION_URL}{path}", json=body, timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        pytest.fail(f"USER-SESSION UNREACHABLE at {USER_SESSION_URL}: {exc}")


def _get(path, headers=None):
    try:
        return requests.get(f"{USER_SESSION_URL}{path}", headers=headers or {}, timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        pytest.fail(f"USER-SESSION UNREACHABLE at {USER_SESSION_URL}: {exc}")


def test_health_returns_200():
    resp = _get("/health")
    assert resp.status_code == 200
    assert resp.json().get("status") == "ok"


def test_register_succeeds_for_new_email():
    resp = _post("/register", {"email": SESSION_EMAIL, "password": SESSION_PASSWORD})
    assert resp.status_code == 201, f"expected 201, got {resp.status_code} body={resp.text!r}"
    assert resp.json().get("email") == SESSION_EMAIL


def test_register_missing_fields_returns_400():
    resp = _post("/register", {"email": "x@example.com"})  # no password
    assert resp.status_code == 400


def test_register_duplicate_email_returns_409():
    # SESSION_EMAIL was registered by the previous test; re-registering
    # within the same run must hit the 409 path.
    resp = _post("/register", {"email": SESSION_EMAIL, "password": "anything-else"})
    assert resp.status_code == 409, f"expected 409 for duplicate, got {resp.status_code} body={resp.text!r}"
    assert resp.json().get("error") == "email_exists"


def test_login_succeeds_and_returns_jwt():
    resp = _post("/login", {"email": SESSION_EMAIL, "password": SESSION_PASSWORD})
    assert resp.status_code == 200, f"expected 200, got {resp.status_code} body={resp.text!r}"
    body = resp.json()
    assert body.get("email") == SESSION_EMAIL
    token = body.get("token")
    assert isinstance(token, str) and token.count(".") == 2, "expected a 3-segment JWT (header.payload.signature)"


def test_login_wrong_password_returns_opaque_401():
    resp = _post("/login", {"email": SESSION_EMAIL, "password": "definitely-wrong"})
    assert resp.status_code == 401
    # Opaque on purpose: must not distinguish "wrong password" from "no such user".
    assert resp.json().get("error") == "invalid_credentials"


def test_login_unknown_email_returns_same_opaque_401():
    resp = _post("/login", {"email": f"nobody-{uuid.uuid4().hex[:8]}@example.com", "password": "any"})
    assert resp.status_code == 401
    assert resp.json().get("error") == "invalid_credentials"


def test_validate_good_token_returns_identity():
    login = _post("/login", {"email": SESSION_EMAIL, "password": SESSION_PASSWORD})
    assert login.status_code == 200
    token = login.json()["token"]

    resp = _get("/validate", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, f"expected 200, got {resp.status_code} body={resp.text!r}"
    body = resp.json()
    assert body.get("email") == SESSION_EMAIL
    assert isinstance(body.get("iat"), int)
    assert isinstance(body.get("exp"), int) and body["exp"] > body["iat"]


def test_validate_missing_token_returns_401():
    resp = _get("/validate")
    assert resp.status_code == 401
    assert resp.json().get("error") == "invalid_token"


def test_validate_garbage_token_returns_401():
    resp = _get("/validate", headers={"Authorization": "Bearer not.a.jwt"})
    assert resp.status_code == 401
    assert resp.json().get("error") == "invalid_token"
