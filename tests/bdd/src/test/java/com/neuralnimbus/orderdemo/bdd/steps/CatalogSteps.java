package com.neuralnimbus.orderdemo.bdd.steps;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.hamcrest.Matchers.is;

import com.neuralnimbus.orderdemo.bdd.config.ConfigReader;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import io.restassured.response.Response;
import java.util.List;
import java.util.Map;

/**
 * product-catalog is a read-only product lookup over the seeded products table.
 * GET /products returns the seeded catalogue; GET /products/:id resolves a sku
 * or 404s with {error:"unknown product"}.
 */
public class CatalogSteps {

    private Response response;

    @When("I request the product catalog")
    public void i_request_the_catalog() {
        response = given().baseUri(ConfigReader.catalogUrl()).when().get("/products");
    }

    @When("I request product {string}")
    public void i_request_product(String sku) {
        response = given().baseUri(ConfigReader.catalogUrl()).when().get("/products/" + sku);
    }

    @Then("the catalog status is {int}")
    public void the_catalog_status_is(int expected) {
        assertThat(response.getBody().asString(), response.statusCode(), is(expected));
    }

    @Then("the catalog contains at least {int} products")
    public void the_catalog_contains_at_least(int min) {
        assertThat(response.jsonPath().getList("$").size(), greaterThanOrEqualTo(min));
    }

    @Then("every product has an id, name, category, price and stock")
    public void every_product_has_the_documented_fields() {
        List<Map<String, Object>> products = response.jsonPath().getList("$");
        for (Map<String, Object> p : products) {
            for (String field : new String[] {"id", "name", "category", "price", "stock"}) {
                assertThat("product " + p.get("id") + " missing field '" + field + "'",
                        p.containsKey(field), is(true));
            }
        }
    }

    @Then("the product id is {string}")
    public void the_product_id_is(String id) {
        assertThat(response.jsonPath().getString("id"), is(id));
    }

    @Then("the catalog error is {string}")
    public void the_catalog_error_is(String error) {
        assertThat(response.jsonPath().getString("error"), is(error));
    }
}
