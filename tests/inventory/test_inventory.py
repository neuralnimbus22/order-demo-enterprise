"""
Inventory team's integration test (pytest).

This is the DOWNSTREAM "edge" test. From inventory's perspective the only
question that matters is: did the message I expected actually arrive?

The test attempts to place an order via order-service, then polls
inventory's /processed/:id until it returns 200 or the deadline passes.

Crucially, it does NOT abort the test just because order-service returned
an error — whether that service was reachable is upstream noise outside
the inventory team's scope. The only assertion that fails the test is
"the message never arrived in my consumer."

Standalone run:
    ORDER_URL=http://localhost:3002 \
    INVENTORY_URL=http://localhost:3003 \
    pytest tests/inventory/test_inventory.py -v
"""
import os
import time
import uuid
import pytest
import requests

ORDER_URL = os.environ.get("ORDER_URL", "http://localhost:3002")
INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://localhost:3003")
MAX_WAIT_S = int(os.environ.get("INVENTORY_POLL_TIMEOUT_S", "20"))
POLL_INTERVAL_S = float(os.environ.get("INVENTORY_POLL_INTERVAL_S", "1"))
REQUEST_TIMEOUT_S = float(os.environ.get("REQUEST_TIMEOUT_S", "5"))


def test_order_propagates_to_inventory_via_kafka():
    # Fresh id every run — guarantees no collision with any prior run's state.
    order_id = f"order-{uuid.uuid4().hex[:12]}"

    # --- Setup: try to place the order. Log only, don't abort. -----------
    # If order-service is unhappy upstream, that's not the inventory team's
    # bug to surface — what they see is "no message arrived".
    try:
        place = requests.post(
            f"{ORDER_URL}/orders",
            json={"id": order_id, "item": "widget", "qty": 1},
            timeout=REQUEST_TIMEOUT_S,
        )
        print(
            f"[inventory-test] POST /orders id={order_id} "
            f"-> HTTP {place.status_code} {place.text!r}"
        )
    except requests.RequestException as exc:
        print(f"[inventory-test] POST /orders failed: {exc}")

    # --- Assertion: did the message ever arrive in inventory? ------------
    deadline = time.time() + MAX_WAIT_S
    last_status = None
    attempts = 0
    while time.time() < deadline:
        attempts += 1
        try:
            resp = requests.get(
                f"{INVENTORY_URL}/processed/{order_id}",
                timeout=REQUEST_TIMEOUT_S,
            )
            last_status = resp.status_code
            if resp.status_code == 200 and resp.json().get("processed") is True:
                print(
                    f"[inventory-test] order arrived after {attempts} polls "
                    f"({resp.json()})"
                )
                return  # success
        except requests.RequestException as exc:
            pytest.fail(
                f"INVENTORY-SERVICE UNREACHABLE at {INVENTORY_URL}: {exc}. "
                "This is an infrastructure problem, not a missing-message one."
            )
        time.sleep(POLL_INTERVAL_S)

    pytest.fail(
        f"MESSAGE NEVER ARRIVED: inventory has no record of order id={order_id} "
        f"after polling /processed/{order_id} {attempts} times over {MAX_WAIT_S}s "
        f"(last HTTP: {last_status}). "
        "From inventory's perspective the topic was silent."
    )
