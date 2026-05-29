"""
Payment team's integration test (pytest).

Genuinely calls payment-service /payments over HTTP and asserts:
  * happy path returns 201 with {id, status:"confirmed"}
  * missing id returns 400
  * /health returns 200

Failure mode: when payment-service is scaled to 0, this test fails with a
clean "PAYMENT-SERVICE UNREACHABLE" message (distinct signature from auth
down).

Standalone run:
    PAYMENT_URL=http://localhost:3004 pytest tests/payment/test_payment.py -v
"""
import os
import uuid
import pytest
import requests

PAYMENT_URL = os.environ.get("PAYMENT_URL", "http://localhost:3004")
REQUEST_TIMEOUT_S = float(os.environ.get("PAYMENT_REQUEST_TIMEOUT_S", "5"))


def _post(body):
    try:
        return requests.post(
            f"{PAYMENT_URL}/payments",
            json=body,
            timeout=REQUEST_TIMEOUT_S,
        )
    except requests.RequestException as exc:
        pytest.fail(
            f"PAYMENT-SERVICE UNREACHABLE at {PAYMENT_URL}: {exc}. "
            "The service is down, the pod is terminating, or there's a "
            "network/DNS problem."
        )


def test_health_returns_200():
    try:
        resp = requests.get(f"{PAYMENT_URL}/health", timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        pytest.fail(f"PAYMENT-SERVICE UNREACHABLE at {PAYMENT_URL}: {exc}")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code}"
    assert resp.json().get("status") == "ok"


def test_payment_confirms_and_returns_201():
    order_id = f"pay-test-{uuid.uuid4().hex[:8]}"
    resp = _post({"id": order_id, "amount": 19.99})
    assert resp.status_code == 201, f"expected 201, got {resp.status_code} body={resp.text!r}"
    body = resp.json()
    assert body.get("id") == order_id
    assert body.get("status") == "confirmed"


def test_missing_id_rejected_400():
    resp = _post({"amount": 5.0})
    assert resp.status_code == 400, f"expected 400, got {resp.status_code} body={resp.text!r}"
    assert "id" in resp.json().get("error", "")
