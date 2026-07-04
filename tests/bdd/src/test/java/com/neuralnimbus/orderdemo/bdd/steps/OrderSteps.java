package com.neuralnimbus.orderdemo.bdd.steps;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.is;

import com.neuralnimbus.orderdemo.bdd.config.ConfigReader;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;
import java.util.UUID;

/**
 * order-service places an order via POST /orders. Internally it authorizes with
 * auth-service and then publishes order-placed to Kafka; the functional
 * contract we assert here is the 201 response echoing the order id and status.
 */
public class OrderSteps {

    private String orderId;
    private Response response;

    @When("I place an order for item {string} with quantity {int}")
    public void i_place_an_order(String item, int qty) {
        orderId = "order-bdd-" + UUID.randomUUID().toString().substring(0, 12);
        response = given()
                .baseUri(ConfigReader.orderUrl())
                .contentType("application/json")
                .body(String.format("{\"id\":\"%s\",\"item\":\"%s\",\"qty\":%d}", orderId, item, qty))
                .when()
                .post("/orders");
    }

    @Then("the order status is {int}")
    public void the_order_status_is(int expected) {
        assertThat(response.getBody().asString(), response.statusCode(), is(expected));
    }

    @Then("the response echoes the generated order id")
    public void the_response_echoes_the_order_id() {
        assertThat(response.jsonPath().getString("id"), is(orderId));
    }

    @Then("the order state is {string}")
    public void the_order_state_is(String state) {
        assertThat(response.jsonPath().getString("status"), is(state));
    }
}
