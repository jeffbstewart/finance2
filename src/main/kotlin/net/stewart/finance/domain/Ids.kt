package net.stewart.finance.domain

// Strong-typed database identifiers (house convention): a raw Long
// cannot be passed where an id is expected, and one entity's id cannot
// stand in for another's. Values are positive by construction — ids
// come from IDENTITY columns starting at 1.

@JvmInline
value class UserId(val value: Long) {
    init { require(value > 0) { "user id must be positive: $value" } }
}

@JvmInline
value class PortfolioId(val value: Long) {
    init { require(value > 0) { "portfolio id must be positive: $value" } }
}

@JvmInline
value class BrokerId(val value: Long) {
    init { require(value > 0) { "broker id must be positive: $value" } }
}

@JvmInline
value class AccountId(val value: Long) {
    init { require(value > 0) { "account id must be positive: $value" } }
}

@JvmInline
value class SecurityId(val value: Long) {
    init { require(value > 0) { "security id must be positive: $value" } }
}

@JvmInline
value class LotId(val value: Long) {
    init { require(value > 0) { "lot id must be positive: $value" } }
}

@JvmInline
value class SaleId(val value: Long) {
    init { require(value > 0) { "sale id must be positive: $value" } }
}

@JvmInline
value class AssetClassId(val value: Long) {
    init { require(value > 0) { "asset class id must be positive: $value" } }
}

@JvmInline
value class PriceId(val value: Long) {
    init { require(value > 0) { "price id must be positive: $value" } }
}
