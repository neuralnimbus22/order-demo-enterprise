package com.neuralnimbus.orderdemo.bdd;

import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

/**
 * Single entry point for the API BDD suite. Surefire runs this class; the
 * Cucumber engine discovers every .feature under {@code features/} and the
 * glue in {@code com.neuralnimbus.orderdemo.bdd.steps} (configured in
 * src/test/resources/junit-platform.properties).
 *
 * Tag filtering is done from the command line, e.g.
 *   mvn test -Dcucumber.filter.tags="@api"
 *   mvn test -Dcucumber.filter.tags="@api and @auth"
 */
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
public class RunCucumberTest {
}
