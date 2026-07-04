package com.neuralnimbus.orderdemo.bdd.steps;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.is;

import com.neuralnimbus.orderdemo.bdd.config.ConfigReader;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;

/**
 * Cross-service smoke: every backend service answers GET /health with
 * 200 {status:"ok"}. Driven from a Scenario Outline over the service names.
 */
public class HealthSteps {

    private Response response;

    @When("I GET the health endpoint of the {string} service")
    public void i_get_health_of(String service) {
        response = given().baseUri(ConfigReader.serviceUrl(service)).when().get("/health");
    }

    @Then("the health status is {int}")
    public void the_health_status_is(int expected) {
        assertThat(response.getBody().asString(), response.statusCode(), is(expected));
    }

    @Then("the reported status is {string}")
    public void the_reported_status_is(String status) {
        assertThat(response.jsonPath().getString("status"), is(status));
    }
}
