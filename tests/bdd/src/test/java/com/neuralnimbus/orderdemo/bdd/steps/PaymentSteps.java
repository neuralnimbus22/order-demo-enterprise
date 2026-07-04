package com.neuralnimbus.orderdemo.bdd.steps;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.is;

import com.neuralnimbus.orderdemo.bdd.config.ConfigReader;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;
import java.util.Locale;
import java.util.UUID;

/**
 * payment-service confirms a payment via POST /payments and publishes
 * payment-confirmed to Kafka. The happy path returns 201 with
 * {id, status:"confirmed"}.
 */
public class PaymentSteps {

    private String orderId;
    private Response response;

    @When("I confirm payment of {double} for a new order")
    public void i_confirm_payment(double amount) {
        orderId = "pay-bdd-" + UUID.randomUUID().toString().substring(0, 12);
        response = given()
                .baseUri(ConfigReader.paymentUrl())
                .contentType("application/json")
                .body(String.format(Locale.US, "{\"id\":\"%s\",\"amount\":%s}", orderId, amount))
                .when()
                .post("/payments");
    }

    @Then("the payment status is {int}")
    public void the_payment_status_is(int expected) {
        assertThat(response.getBody().asString(), response.statusCode(), is(expected));
    }

    @Then("the payment state is {string}")
    public void the_payment_state_is(String state) {
        assertThat(response.jsonPath().getString("status"), is(state));
    }

    @Then("the payment response echoes the order id")
    public void the_payment_response_echoes_the_order_id() {
        assertThat(response.jsonPath().getString("id"), is(orderId));
    }
}
