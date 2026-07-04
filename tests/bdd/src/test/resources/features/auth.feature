@api @auth
Feature: Order authorization (auth-service)
  auth-service is the deepest upstream of the order pipeline. It authorizes
  ORDERS against a static Bearer-token catalogue (it is unrelated to human
  login, which is user-session).

  @smoke
  Scenario: A valid token authorizes an order
    Given a valid order-authorization token
    When I request authorization for order "auth-bdd-happy"
    Then the authorization status is 200
    And the response confirms the order is authorized
    And the granted scope includes "orders:create"

  Scenario: An unknown token is rejected
    Given an invalid order-authorization token
    When I request authorization for order "auth-bdd-rejected"
    Then the authorization status is 401
    And the authorization error is "invalid_token"
