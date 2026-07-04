package com.neuralnimbus.orderdemo.bdd.steps;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.hasItem;
import static org.hamcrest.Matchers.is;

import com.neuralnimbus.orderdemo.bdd.config.ConfigReader;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;

/**
 * auth-service authorizes ORDERS in the backend pipeline against a static
 * Bearer-token catalogue. "demo-token-good" carries orders:create; anything
 * unknown is an invalid_token.
 */
public class AuthSteps {

    private String token;
    private Response response;

    @Given("a valid order-authorization token")
    public void a_valid_token() {
        token = "demo-token-good";
    }

    @Given("an invalid order-authorization token")
    public void an_invalid_token() {
        token = "not-a-real-token-xxx";
    }

    @When("I request authorization for order {string}")
    public void i_request_authorization(String orderId) {
        response = given()
                .baseUri(ConfigReader.authUrl())
                .header("Authorization", "Bearer " + token)
                .contentType("application/json")
                .body("{\"orderId\":\"" + orderId + "\"}")
                .when()
                .post("/authorize");
    }

    @Then("the authorization status is {int}")
    public void the_authorization_status_is(int expected) {
        assertThat(response.getBody().asString(), response.statusCode(), is(expected));
    }

    @Then("the response confirms the order is authorized")
    public void the_order_is_authorized() {
        assertThat(response.jsonPath().getBoolean("authorized"), is(true));
    }

    @Then("the granted scope includes {string}")
    public void the_granted_scope_includes(String scope) {
        assertThat(response.jsonPath().getList("scope"), hasItem(scope));
    }

    @Then("the authorization error is {string}")
    public void the_authorization_error_is(String error) {
        assertThat(response.jsonPath().getString("error"), is(error));
    }
}
