package com.neuralnimbus.orderdemo.bdd.steps;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.empty;
import static org.hamcrest.Matchers.is;

import com.neuralnimbus.orderdemo.bdd.config.ConfigReader;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;

/**
 * inventory-service is the downstream convergence point: it fulfills an order id
 * only once BOTH order-placed and payment-confirmed have arrived over Kafka.
 * GET /fulfilled/:id reports {fulfilled, waitingFor}; we drive both upstream
 * events for one id and poll until waitingFor drains.
 */
public class InventorySteps {

    private String checkoutId;
    private Response fulfilled;

    @Given("a new checkout id")
    public void a_new_checkout_id() {
        checkoutId = "checkout-bdd-" + UUID.randomUUID().toString().substring(0, 12);
    }

    @When("I place the order and confirm its payment")
    public void i_place_the_order_and_confirm_payment() {
        given()
                .baseUri(ConfigReader.orderUrl())
                .contentType("application/json")
                .body(String.format("{\"id\":\"%s\",\"item\":\"widget\",\"qty\":1}", checkoutId))
                .when()
                .post("/orders")
                .then()
                .statusCode(201);

        given()
                .baseUri(ConfigReader.paymentUrl())
                .contentType("application/json")
                .body(String.format(Locale.US, "{\"id\":\"%s\",\"amount\":%s}", checkoutId, "12.50"))
                .when()
                .post("/payments")
                .then()
                .statusCode(201);
    }

    @When("I poll the fulfillment endpoint until nothing is left to wait for")
    public void i_poll_until_converged() throws InterruptedException {
        long deadlineNanos = System.nanoTime()
                + Duration.ofSeconds(ConfigReader.pollTimeoutSeconds()).toNanos();
        long intervalMillis = ConfigReader.pollIntervalSeconds() * 1000L;

        while (System.nanoTime() < deadlineNanos) {
            fulfilled = given()
                    .baseUri(ConfigReader.inventoryUrl())
                    .when()
                    .get("/fulfilled/" + checkoutId);

            if (fulfilled.statusCode() == 200
                    && fulfilled.jsonPath().getList("waitingFor").isEmpty()) {
                return;
            }
            Thread.sleep(intervalMillis);
        }
        // Fall through with the last response captured; the Then steps assert on
        // it and surface the body, so a timeout fails with useful context.
    }

    @Then("the order is fulfilled")
    public void the_order_is_fulfilled() {
        String context = fulfilled == null ? "no response captured" : fulfilled.getBody().asString();
        assertThat(context, fulfilled.statusCode(), is(200));
        assertThat(context, fulfilled.jsonPath().getBoolean("fulfilled"), is(true));
    }

    @Then("there is nothing left in waitingFor")
    public void nothing_left_waiting() {
        assertThat(fulfilled.jsonPath().getList("waitingFor"), is(empty()));
    }
}
