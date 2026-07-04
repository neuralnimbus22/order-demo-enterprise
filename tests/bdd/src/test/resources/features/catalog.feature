@api @catalog
Feature: Product catalog (product-catalog)
  product-catalog serves the seeded catalogue of retail products and resolves
  a sku to a single product.

  @smoke
  Scenario: The catalog returns the seeded products
    When I request the product catalog
    Then the catalog status is 200
    And the catalog contains at least 20 products
    And every product has an id, name, category, price and stock

  Scenario: A known sku returns its product
    When I request product "BK-001"
    Then the catalog status is 200
    And the product id is "BK-001"

  Scenario: An unknown sku returns 404
    When I request product "NOPE-9999"
    Then the catalog status is 404
    And the catalog error is "unknown product"
