package ai.cloudcli.android.voice

import ai.cloudcli.android.AppRuntime
import ai.cloudcli.android.Jwt
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

internal class VoiceHttpError(val status: Int, val code: String?, message: String) : IOException(message)
internal data class VoiceAppendReceipt(val id: String, val appended: Boolean)

internal class VoiceApi(val origin: String) {
    private val base = origin.toHttpUrl()
    private val main = Handler(Looper.getMainLooper())

    private fun authorized(url: HttpUrl): Request.Builder? {
        if (AppRuntime.prefs.siteOrigin != origin) return null
        val token = AppRuntime.prefs.token()?.takeIf { Jwt.isUsable(it) } ?: return null
        return Request.Builder().url(url).header("Authorization", "Bearer $token")
    }

    fun socket(listener: WebSocketListener): WebSocket? =
        authorized(base.newBuilder().addPathSegment("ws").build())?.let { client.newWebSocket(it.build(), listener) }

    fun recent(offset: Int, done: (Result<RecentVoiceChoices>) -> Unit) = request(
        base.newBuilder().addPathSegments("api/providers/sessions/recent")
            .addQueryParameter("limit", "40").addQueryParameter("offset", offset.toString()).build(),
        read = { RecentVoiceChoices.read(it.getJSONObject("data"), offset) }, done = done,
    )

    fun title(id: String, done: (Result<String?>) -> Unit) = request(
        base.newBuilder().addPathSegments("api/providers/sessions").addPathSegment(id).build(),
        read = { it.getJSONObject("data").string("summary") }, done = done,
    )

    fun history(id: String, done: (Result<List<VoiceRow>>) -> Unit) = request(
        base.newBuilder().addPathSegments("api/providers/sessions").addPathSegment(id).addPathSegment("messages")
            .addQueryParameter("limit", "100").addQueryParameter("offset", "0").build(),
        read = { it.getJSONObject("data").getJSONArray("messages").objects().mapNotNull(VoiceRow::read) }, done = done,
    )

    fun queue(id: String, done: (Result<VoiceQueue>) -> Unit) = request(
        base.newBuilder().addPathSegments("api/user/drafts").build(),
        read = { VoiceQueue.read(it, id) }, done = done,
    )

    fun model(id: String, done: (Result<JSONObject>) -> Unit) = request(
        base.newBuilder().addPathSegments("api/providers/codex/sessions").addPathSegment(id).addPathSegment("active-model").build(),
        read = { it.getJSONObject("data") }, done = done,
    )

    fun append(id: String, text: String, options: JSONObject, ifEmpty: Boolean, done: (Result<VoiceAppendReceipt>) -> Unit) {
        val body = JSONObject().put("scope", id)
            .put("queuedMessage", JSONObject().put("content", text).put("options", options))
        if (ifEmpty) body.put("ifEmpty", true)
        request(base.newBuilder().addPathSegments("api/user/drafts/queued-message").build(), body,
            read = { VoiceAppendReceipt(it.getJSONObject("queuedMessage").getString("id"), it.getBoolean("appended")) }, done = done)
    }

    private fun <T> request(url: HttpUrl, body: JSONObject? = null, read: (JSONObject) -> T, done: (Result<T>) -> Unit) {
        val request = authorized(url)
        if (request == null) {
            main.post { done(Result.failure(VoiceHttpError(401, null, "Sign in to CloudCLI on the web."))) }
            return
        }
        if (body != null) request.post(body.toString().toRequestBody(json))
        val transport = if (body == null) reads else client
        transport.newCall(request.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                main.post { done(Result.failure(e)) }
            }

            override fun onResponse(call: Call, response: Response) {
                val result = runCatching {
                    response.use {
                        val raw = it.body?.string().orEmpty()
                        if (!it.isSuccessful) {
                            val error = runCatching { JSONObject(raw).optJSONObject("error") }.getOrNull()
                            throw VoiceHttpError(it.code, error?.string("code"),
                                error?.string("message") ?: "CloudCLI returned HTTP ${it.code}.")
                        }
                        read(JSONObject(raw))
                    }
                }
                main.post { done(result) }
            }
        })
    }

    private companion object {
        val json = "application/json".toMediaType()
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .followRedirects(false)
            .retryOnConnectionFailure(false)
            .build()
        val reads = client.newBuilder().retryOnConnectionFailure(true).build()
    }
}
