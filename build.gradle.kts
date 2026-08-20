import com.google.protobuf.gradle.id

plugins {
    kotlin("jvm") version "2.3.10"
    application
    id("com.google.protobuf") version "0.9.4"
}

group = "net.stewart"
version = "0.1.0"

repositories {
    mavenCentral()
}

val grpcVersion = "1.80.0"
val grpcKotlinVersion = "1.5.0"
val protobufVersion = "4.34.1"

dependencies {
    implementation("net.stewart:armeria-kotlin-toolkit:0.1.0")
    implementation("net.stewart:armeria-kotlin-toolkit-auth:0.1.0")
    implementation("net.stewart:h2-kotlin-toolkit:0.1.0")

    implementation("io.grpc:grpc-stub:$grpcVersion")
    implementation("io.grpc:grpc-protobuf:$grpcVersion")
    implementation("io.grpc:grpc-kotlin-stub:$grpcKotlinVersion")
    implementation("com.google.protobuf:protobuf-kotlin:$protobufVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    implementation("io.micrometer:micrometer-registry-prometheus:1.15.2")
    // JSON tree parsing for provider clients (no @Serializable classes,
    // so no compiler plugin): numbers stay raw strings -> BigDecimal.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")

    runtimeOnly("org.slf4j:slf4j-simple:2.0.17")

    testImplementation(kotlin("test"))
    testImplementation(testFixtures("net.stewart:h2-kotlin-toolkit:0.1.0"))
    testImplementation("io.kotest:kotest-property:5.9.1")
}

application {
    mainClass.set("net.stewart.finance.MainKt")
}

// The wire contract lives in proto/ at the repo root — the single
// source of truth for both the Kotlin stubs (generated here on every
// build) and the TypeScript client (web-app/scripts/gen-proto.mjs).
sourceSets {
    main {
        proto {
            srcDir("proto")
        }
    }
}

protobuf {
    protoc {
        artifact = "com.google.protobuf:protoc:$protobufVersion"
    }
    plugins {
        id("grpc") {
            artifact = "io.grpc:protoc-gen-grpc-java:$grpcVersion"
        }
        id("grpckt") {
            artifact = "io.grpc:protoc-gen-grpc-kotlin:$grpcKotlinVersion:jdk8@jar"
        }
    }
    generateProtoTasks {
        all().forEach { task ->
            task.plugins {
                id("grpc")
                id("grpckt")
            }
            task.builtins {
                id("kotlin")
            }
        }
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}
