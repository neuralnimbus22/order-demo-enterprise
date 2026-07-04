package com.neuralnimbus.orderdemo.bdd.steps;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.notNullValue;

import com.neuralnimbus.orderdemo.bdd.config.ConfigReader;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;
import java.util.UUID;

/**
 * user-session is the human-identity service (register / login / validate),
 * standalone from the order pipeline. Login issues a signed JWT. Each run uses
 * a fresh unique email so it never collides with prior runs on the shared DB.
 */
public class SessionSteps {

    private String email;
    private String password;
    private Response response;

    @Given("a freshly registered user")
    public void a_freshly_registered_user() {
        email = "bdd-" + UUID.randomUUID().toString().substring(0, 10) + "@example.com";
        password = "correct-horse-battery-staple";
        given()
                .baseUri(ConfigReader.sessionUrl())
                .contentType("application/json")
                .body(String.format("{\"email\":\"%s\",\"password\":\"%s\"}", email, password))
                .when()
                .post("/register")
                .then()
                .statusCode(201);
    }

    @When("that user logs in")
    public void that_user_logs_in() {
        response = given()
                .baseUri(ConfigReader.sessionUrl())
                .contentType("application/json")
                .body(String.format("{\"email\":\"%s\",\"password\":\"%s\"}", email, password))
                .when()
                .post("/login");
    }

    @Then("the login status is {int}")
    public void the_login_status_is(int expected) {
        assertThat(response.getBody().asString(), response.statusCode(), is(expected));
    }

    @Then("the login response returns the user's email")
    public void the_login_response_returns_the_email() {
        assertThat(response.jsonPath().getString("email"), is(email));
    }

    @Then("the login response includes a JWT")
    public void the_login_response_includes_a_jwt() {
        String token = response.jsonPath().getString("token");
        assertThat(token, notNullValue());
        // A JWT is three base64url segments separated by dots.
        assertThat("token was not a 3-segment JWT: " + token,
                token.chars().filter(c -> c == '.').count(), is(2L));
    }
}
