package net.stewart.finance.domain

/**
 * Where an FX rate came from. Same open-column/closed-code pattern as
 * the other enums: the fx_rates.source column stays VARCHAR, server
 * code only ever handles these values.
 */
enum class RateSource(val dbValue: String) {
    ECB("ecb"),
    MANUAL("manual");
}
