"""
Product catalog team's integration test (pytest).

Hits a running product-catalog service over HTTP. Asserts:
  * GET /health returns 200
  * GET /products returns the seeded catalog (>= 20 generic items)
  * GET /products/:id returns one product for a known sku
  * GET /products/:id returns 404 for an unknown sku

Standalone run:
    PRODUCT_CATALOG_URL=http://localhost:3005 pytest tests/product-catalog/test_product_catalog.py -v

This test is NOT wired into ci-tests.yml or any TestKube workflow on purpose —
pipeline wiring is deferred.
"""
import os
import pytest
import requests

PRODUCT_CATALOG_URL = os.environ.get("PRODUCT_CATALOG_URL", "http://localhost:3005")
REQUEST_TIMEOUT_S = float(os.environ.get("PRODUCT_CATALOG_REQUEST_TIMEOUT_S", "5"))


def _get(path):
    try:
        return requests.get(f"{PRODUCT_CATALOG_URL}{path}", timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        pytest.fail(
            f"PRODUCT-CATALOG UNREACHABLE at {PRODUCT_CATALOG_URL}: {exc}. "
            "The service is down, the pod is terminating, or there's a "
            "network/DNS problem."
        )


def test_health_returns_200():
    resp = _get("/health")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code}"
    assert resp.json().get("status") == "ok"


def test_products_list_returns_seeded_catalog():
    resp = _get("/products")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code} body={resp.text!r}"
    products = resp.json()
    assert isinstance(products, list), f"expected list, got {type(products).__name__}"
    assert len(products) >= 20, f"expected at least 20 seeded products, got {len(products)}"

    # Each product should have the documented fields.
    required = {"id", "name", "category", "price", "description", "stock"}
    for p in products:
        missing = required - set(p.keys())
        assert not missing, f"product {p.get('id')!r} missing fields: {missing}"


def test_get_known_sku_returns_product():
    # BK-001 ("Hardcover Notebook") is in the seed list.
    resp = _get("/products/BK-001")
    assert resp.status_code == 200, f"expected 200 for BK-001, got {resp.status_code} body={resp.text!r}"
    body = resp.json()
    assert body.get("id") == "BK-001"
    assert isinstance(body.get("name"), str) and body["name"]
    assert isinstance(body.get("category"), str) and body["category"]
    assert isinstance(body.get("price"), (int, float))
    assert isinstance(body.get("stock"), int)


def test_get_unknown_sku_returns_404():
    resp = _get("/products/DOES-NOT-EXIST-9999")
    assert resp.status_code == 404, f"expected 404, got {resp.status_code} body={resp.text!r}"
    assert resp.json().get("error") == "unknown product"
