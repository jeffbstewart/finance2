rootProject.name = "finance2"

// The toolkit family is consumed via composite builds from sibling
// checkouts (see MODERNIZATION.md "Reference repositories").
// armeria-kotlin-toolkit itself includes ../auth-kotlin-toolkit.
includeBuild("../armeria-kotlin-toolkit")
includeBuild("../h2-kotlin-toolkit")
