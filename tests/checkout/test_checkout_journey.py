"""
Checkout journey test (pytest).

Walks one order through the whole pipeline the way a shopper would:

  1. place the order on order-service
  2. confirm the payment on payment-service
  3. wait for inventory-service to report the order fulfilled

The three steps share one order id. Each step is its own test so a report
shows exactly where the journey stopped. When a step fails, the steps after
it are skipped rather than failed, because they cannot run without it.

Standalone run:
    ORDER_URL=http://localhost:3002 \
    PAYMENT_URL=http://localhost:3004 \
    INVENTORY_URL=http://localhost:3003 \
    pytest tests/checkout/test_checkout_journey.py -v
"""

import os
import time
import uuid

import pytest
import requests

ORDER_URL = os.environ.get("ORDER_URL", "http://localhost:3002")
PAYMENT_URL = os.environ.get("PAYMENT_URL", "http://localhost:3004")
INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://localhost:3003")
REQUEST_TIMEOUT_S = float(os.environ.get("CHECKOUT_REQUEST_TIMEOUT_S", "10"))
FULFILL_TIMEOUT_S = float(os.environ.get("CHECKOUT_FULFILL_TIMEOUT_S", "20"))


def _call(method, url, **kwargs):
    try:
        return requests.request(method, url, timeout=REQUEST_TIMEOUT_S, **kwargs)
    except requests.RequestException as exc:
        pytest.fail(f"UNREACHABLE: {method} {url} failed: {exc}")


@pytest.fixture(scope="module")
def journey():
    return {"id": f"chk-{uuid.uuid4().hex[:12]}", "placed": False, "paid": False}


def test_1_place_order(journey):
    resp = _call(
        "POST",
        f"{ORDER_URL}/orders",
        json={"id": journey["id"], "item": "Aurora Desk Lamp", "qty": 1},
    )
    assert resp.status_code == 201, (
        f"placing order {journey['id']} returned HTTP {resp.status_code}, "
        f"expected 201. body={resp.text!r}"
    )
    assert resp.json().get("status") == "placed"
    journey["placed"] = True


def test_2_confirm_payment(journey):
    if not journey["placed"]:
        pytest.skip("the order was not placed, so there is nothing to pay for")
    resp = _call(
        "POST",
        f"{PAYMENT_URL}/payments",
        json={"id": journey["id"], "amount": 79.00},
    )
    assert resp.status_code == 201, (
        f"confirming payment for {journey['id']} returned HTTP {resp.status_code}, "
        f"expected 201. body={resp.text!r}"
    )
    assert resp.json().get("status") == "confirmed"
    journey["paid"] = True


def test_3_order_becomes_fulfilled(journey):
    if not journey["paid"]:
        pytest.skip("the payment was not confirmed, so the order cannot be fulfilled")
    deadline = time.monotonic() + FULFILL_TIMEOUT_S
    state = None
    while time.monotonic() < deadline:
        resp = _call("GET", f"{INVENTORY_URL}/fulfilled/{journey['id']}")
        if resp.status_code == 200:
            state = resp.json()
            if state.get("fulfilled") is True:
                return
        time.sleep(1)
    pytest.fail(
        f"order {journey['id']} did not reach fulfilled within {FULFILL_TIMEOUT_S:.0f}s. "
        f"last state={state!r}"
    )
