package com.neuralnimbus.orderdemo.bdd.config;

/**
 * Single source of truth for every service base URL.
 *
 * Resolution order for each URL (first non-blank wins):
 *   1. a -D system property   (e.g. -Dauth.url=http://localhost:3001)
 *   2. an environment variable (e.g. AUTH_URL=http://localhost:3001)
 *   3. the in-cluster FQDN default (order-demo namespace)
 *
 * The defaults are the in-cluster FQDNs from ARCHITECTURE.md so the suite runs
 * unconfigured inside the cluster. For a local run behind
 * `kubectl port-forward`, override each to localhost — the env-var names match
 * the ones the other test suites in this repo already use.
 */
public final class ConfigReader {

    private ConfigReader() {
    }

    public static String authUrl() {
        return resolve("auth.url", "AUTH_URL",
                "http://auth.order-demo.svc.cluster.local:3001");
    }

    public static String orderUrl() {
        return resolve("order.url", "ORDER_URL",
                "http://order.order-demo.svc.cluster.local:3002");
    }

    public static String inventoryUrl() {
        return resolve("inventory.url", "INVENTORY_URL",
                "http://inventory.order-demo.svc.cluster.local:3003");
    }

    public static String paymentUrl() {
        return resolve("payment.url", "PAYMENT_URL",
                "http://payment.order-demo.svc.cluster.local:3004");
    }

    public static String catalogUrl() {
        return resolve("catalog.url", "PRODUCT_CATALOG_URL",
                "http://product-catalog.order-demo.svc.cluster.local:3005");
    }

    public static String sessionUrl() {
        return resolve("session.url", "USER_SESSION_URL",
                "http://user-session.order-demo.svc.cluster.local:3006");
    }

    /** Map a health-check service name (as used in the smoke feature) to its base URL. */
    public static String serviceUrl(String service) {
        switch (service) {
            case "auth":            return authUrl();
            case "order":           return orderUrl();
            case "inventory":       return inventoryUrl();
            case "payment":         return paymentUrl();
            case "product-catalog": return catalogUrl();
            case "user-session":    return sessionUrl();
            default:
                throw new IllegalArgumentException("unknown service: " + service);
        }
    }

    public static long pollTimeoutSeconds() {
        return Long.parseLong(resolve("inventory.poll.timeout", "INVENTORY_POLL_TIMEOUT_S", "20"));
    }

    public static long pollIntervalSeconds() {
        return Long.parseLong(resolve("inventory.poll.interval", "INVENTORY_POLL_INTERVAL_S", "1"));
    }

    static String resolve(String sysProp, String envVar, String defaultUrl) {
        String value = System.getProperty(sysProp);
        if (isBlank(value)) {
            value = System.getenv(envVar);
        }
        if (isBlank(value)) {
            value = defaultUrl;
        }
        // Trim any trailing slashes so callers can safely append "/path".
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
