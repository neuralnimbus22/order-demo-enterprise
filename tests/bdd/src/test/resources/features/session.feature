@api @session
Feature: Human login via API (user-session)
  user-session is the standalone human-identity service. A registered user can
  log in and receive a signed JWT.

  Scenario: A registered user can log in and receives a JWT
    Given a freshly registered user
    When that user logs in
    Then the login status is 200
    And the login response returns the user's email
    And the login response includes a JWT
