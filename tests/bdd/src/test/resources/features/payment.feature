@api @payment
Feature: Payment confirmation (payment-service)
  payment-service confirms a payment and publishes payment-confirmed to Kafka.

  @smoke
  Scenario: Confirming a payment is accepted
    When I confirm payment of 19.99 for a new order
    Then the payment status is 201
    And the payment state is "confirmed"
    And the payment response echoes the order id
