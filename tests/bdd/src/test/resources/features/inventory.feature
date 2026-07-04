@api @inventory
Feature: Order fulfillment convergence (inventory-service)
  inventory-service fulfills an order id only after BOTH order-placed and
  payment-confirmed have arrived over Kafka. GET /fulfilled/:id reports what is
  still being waited on; convergence empties waitingFor.

  Scenario: An order fulfills once order and payment have both converged
    Given a new checkout id
    When I place the order and confirm its payment
    And I poll the fulfillment endpoint until nothing is left to wait for
    Then the order is fulfilled
    And there is nothing left in waitingFor
