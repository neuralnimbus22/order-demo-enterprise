@api @smoke
Feature: Service health checks
  Every backend service on the order pipeline answers its liveness endpoint.

  Scenario Outline: <service> reports healthy
    When I GET the health endpoint of the "<service>" service
    Then the health status is 200
    And the reported status is "ok"

    Examples:
      | service         |
      | auth            |
      | order           |
      | payment         |
      | inventory       |
      | product-catalog |
      | user-session    |
