"""
Inventory cache-consistency tests (pytest).

Validates the cache-aside contract between inventory's Redis cache and the
source-of-truth stock store. Three scenarios:

  1. Healthy cache-aside: cache and DB agree, fulfillment succeeds.
  2. Stale cache: cache disagrees with DB, /consistency/check reports the
     mismatch, /fulfill returns 409 DATA_INCONSISTENCY (NOT a connectivity
     or missing-message error).
  3. Cache miss: with cache flushed, /stock falls back to DB and repopulates.

Standalone run:
    INVENTORY_URL=http://localhost:3003 pytest tests/inventory/test_cache_consistency.py -v
"""
import os
import uuid
import pytest
import requests

INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://localhost:3003")
REQUEST_TIMEOUT_S = float(os.environ.get("INVENTORY_REQUEST_TIMEOUT_S", "5"))


def _post(path, body):
    try:
        return requests.post(f"{INVENTORY_URL}{path}", json=body, timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        pytest.fail(f"INVENTORY-SERVICE UNREACHABLE at {INVENTORY_URL}: {exc}")


def _get(path):
    try:
        return requests.get(f"{INVENTORY_URL}{path}", timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        pytest.fail(f"INVENTORY-SERVICE UNREACHABLE at {INVENTORY_URL}: {exc}")


@pytest.fixture
def fresh_sku():
    """Unique sku per test so runs don't collide."""
    return f"sku-{uuid.uuid4().hex[:8]}"


def test_healthy_cache_aside_fulfills(fresh_sku):
    # Seed DB with stock; flush cache so the first /stock read repopulates.
    _post("/stock/seed", {"sku": fresh_sku, "qty": 10})
    _post("/cache/flush", {})

    # Read once to warm the cache from DB.
    r = _get(f"/stock/{fresh_sku}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["qty"] == 10
    assert body["source"] in ("cache", "db")  # may be either depending on Redis warmth

    # Consistency should be clean.
    cc = _get("/consistency/check")
    assert cc.status_code == 200, cc.text
    assert cc.json()["consistent"] is True

    # Fulfill succeeds.
    f = _post("/fulfill", {"id": "ok-" + fresh_sku, "sku": fresh_sku, "qty": 3})
    assert f.status_code == 200, f.text
    fb = f.json()
    assert fb["fulfilled"] is True
    assert fb["remaining"] == 7


def test_stale_cache_surfaces_as_data_inconsistency(fresh_sku):
    # Seed DB to 0, then poison the cache with a nonzero value.
    _post("/stock/seed", {"sku": fresh_sku, "qty": 0})
    _post("/cache/seed", {"sku": fresh_sku, "qty": 10})

    # Consistency check should now report a mismatch (HTTP 409).
    cc = _get("/consistency/check")
    assert cc.status_code == 409, f"expected 409 for mismatch, got {cc.status_code} body={cc.text!r}"
    body = cc.json()
    assert body["consistent"] is False
    mismatches = body["mismatches"]
    found = [m for m in mismatches if m["sku"] == fresh_sku]
    assert found, f"expected {fresh_sku} in mismatches, got {mismatches}"
    assert found[0]["cacheQty"] == 10
    assert found[0]["dbQty"] == 0

    # Fulfill must NOT succeed and must NOT look like a connectivity error;
    # it must surface as a clean DATA_INCONSISTENCY 409.
    f = _post("/fulfill", {"id": "stale-" + fresh_sku, "sku": fresh_sku, "qty": 1})
    assert f.status_code == 409, f"expected 409 DATA_INCONSISTENCY, got {f.status_code} body={f.text!r}"
    fb = f.json()
    assert fb["error"] == "DATA_INCONSISTENCY"
    assert fb["cacheQty"] == 10
    assert fb["dbQty"] == 0


def test_cache_miss_falls_back_to_db_then_repopulates(fresh_sku):
    _post("/stock/seed", {"sku": fresh_sku, "qty": 4})
    _post("/cache/flush", {})

    # First read should fetch from DB (source=db).
    r1 = _get(f"/stock/{fresh_sku}")
    assert r1.status_code == 200, r1.text
    b1 = r1.json()
    assert b1["qty"] == 4
    assert b1["source"] == "db"

    # Second read should now be cached.
    r2 = _get(f"/stock/{fresh_sku}")
    assert r2.status_code == 200, r2.text
    b2 = r2.json()
    assert b2["qty"] == 4
    assert b2["source"] == "cache"
