@api @order
Feature: Placing an order (order-service)
  order-service authorizes with auth-service and, only then, publishes
  order-placed to Kafka. Placing an order returns the placed order id.

  Scenario: Placing an order returns a placed order id
    When I place an order for item "widget" with quantity 1
    Then the order status is 201
    And the response echoes the generated order id
    And the order state is "placed"
