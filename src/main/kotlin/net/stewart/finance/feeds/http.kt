package net.stewart.finance.feeds

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

data class HttpResult(val status: Int, val body: String)

/** GET returning status + body; provider clients map non-200s to
 *  their typed errors. */
internal fun httpGetRaw(url: String, headers: Map<String, String> = emptyMap()): HttpResult {
    val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build()
    val builder = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(60)).GET()
    headers.forEach { (name, value) -> builder.header(name, value) }
    val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    return HttpResult(response.statusCode(), response.body())
}

/** GET that requires a 200 (feeds with no interesting error mapping). */
internal fun httpGet(url: String): String {
    val result = httpGetRaw(url)
    check(result.status == 200) { "GET $url returned ${result.status}" }
    return result.body
}
