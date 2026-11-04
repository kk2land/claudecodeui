package ai.cloudcli.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher

/**
 * Single-site shell: a natively configured HTTP(S) origin, a WebView with the injected bridge,
 * share intake and the file picker/save destinations.
 */
class MainActivity : Activity(), BridgeHost.Host {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var setupPanel: View
    private lateinit var siteInput: EditText
    private lateinit var siteError: TextView
    private lateinit var overflowButton: View
    private var bridgeHost: BridgeHost? = null
    private var siteOrigin: String? = null

    private var pendingPermission: ((Boolean) -> Unit)? = null
    private var pendingPick: ((List<Uri>?) -> Unit)? = null
    private var pendingCreate: ((Uri?) -> Unit)? = null
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private var pendingDeepLink: String? = null
    private var clearHistoryOnNextPage = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppRuntime.init(applicationContext)
        Notifications.ensureChannels(this)
        setContentView(R.layout.activity_main)
        applyEdgeToEdgeInsets()

        webView = findViewById(R.id.web_view)
        progress = findViewById(R.id.progress)
        setupPanel = findViewById(R.id.setup_panel)
        siteInput = findViewById(R.id.site_input)
        siteError = findViewById(R.id.site_error)
        overflowButton = findViewById(R.id.overflow_button)
        overflowButton.setOnClickListener { openOptionsMenu() }
        findViewById<Button>(R.id.site_save).setOnClickListener { saveSite() }
        siteInput.setText(AppRuntime.prefs.siteOrigin.orEmpty())

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            ) { handleBack() }
        }

        val origin = AppRuntime.prefs.siteOrigin
        if (origin == null) {
            showSetup()
        } else {
            openSite(origin, deepLinkFrom(intent))
        }
        importShareIntent(intent, savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // A restored Activity keeps the original launch intent; never import that share twice.
        outState.putBoolean(STATE_SHARE_IMPORTED, true)
    }

    /**
     * Target 36 enforces edge-to-edge: content draws under the status/navigation bars. Pad the
     * single root view by the system-bar + cutout insets and by the IME so the WebView and the
     * overflow button are never covered (and the keyboard does not hide the input).
     * Below API 30 the platform still fits system windows, so no manual insets are applied.
     */
    private fun applyEdgeToEdgeInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        window.setDecorFitsSystemWindows(false)
        window.insetsController?.setSystemBarsAppearance(
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
        )
        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        root.requestApplyInsets()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val deepLink = deepLinkFrom(intent)
        val origin = siteOrigin ?: AppRuntime.prefs.siteOrigin
        if (deepLink != null && origin != null) {
            loadTopLevel(AppRuntime.deeplinkFor(origin, deepLink))
        }
        importShareIntent(intent, null)
    }

    override fun onDestroy() {
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null
        bridgeHost?.destroy()
        bridgeHost = null
        webView.destroy()
        AppRuntime.listener = null
        super.onDestroy()
    }

    @Deprecated("Legacy back handling below API 33")
    override fun onBackPressed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            handleBack()
        } else {
            super.onBackPressed()
        }
    }

    private fun handleBack() {
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            finish()
        }
    }

    // ---------------------------------------------------------------- menu

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(Menu.NONE, MENU_CHANGE_SITE, 0, R.string.action_change_site)
        menu.add(Menu.NONE, MENU_RELOAD, 1, R.string.action_reload)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        MENU_CHANGE_SITE -> {
            changeSite()
            true
        }
        MENU_RELOAD -> {
            reloadTopLevel()
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    // ---------------------------------------------------------------- site setup

    private fun saveSite() {
        val origin = SiteOrigin.normalize(siteInput.text.toString())
        if (origin == null) {
            siteError.visibility = View.VISIBLE
            siteError.setText(R.string.invalid_url)
            return
        }
        siteError.visibility = View.GONE
        AppRuntime.prefs.changeOrigin(origin)
        openSite(origin, pendingDeepLink)
    }

    private fun openSite(origin: String, deepLink: String?) {
        siteOrigin = origin
        setupPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        overflowButton.visibility = View.VISIBLE
        configureWebView()
        bridgeHost?.destroy()
        val host = BridgeHost(this, webView, this)
        bridgeHost = if (host.install(origin)) host else null
        if (bridgeHost == null) {
            Toast.makeText(this, R.string.bridge_unavailable, Toast.LENGTH_LONG).show()
        }
        progress.visibility = View.VISIBLE
        loadTopLevel(AppRuntime.deeplinkFor(origin, deepLink))
    }

    private fun showSetup() {
        webView.visibility = View.GONE
        progress.visibility = View.GONE
        overflowButton.visibility = View.GONE
        setupPanel.visibility = View.VISIBLE
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    private fun changeSite() {
        AppRuntime.prefs.clearToken()
        AppRuntime.prefs.notificationsEnabled = false
        AppRuntime.requestStopNotificationService()
        AppRuntime.setConnected(false)
        bridgeHost?.destroy()
        bridgeHost = null
        siteOrigin = null
        webView.stopLoading()
        webView.loadUrl("about:blank")
        clearHistoryOnNextPage = true
        siteInput.setText("")
        showSetup()
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Network-first for the shell; the server and the service worker revalidate.
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                val target = originOf(url)
                val origin = siteOrigin ?: return true
                if (target == origin) return false
                openExternally(url)
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
                val origin = siteOrigin
                if (clearHistoryOnNextPage && url != null) {
                    if (url == "about:blank") {
                        // The site change unloads the old page here; drop it from history immediately.
                        view.clearHistory()
                    } else if (origin != null && url.startsWith("$origin/")) {
                        // After the first page of the newly configured origin, only that page remains,
                        // so Back never lands on the old origin or a blank page.
                        view.clearHistory()
                        clearHistoryOnNextPage = false
                    }
                }
            }
        }
        // Plain HTML uploads (file-tree, skills) keep using the page's own <input type="file">.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                pendingFileChooser?.onReceiveValue(null)
                pendingFileChooser = filePathCallback
                val intent = fileChooserParams.createIntent()
                startActivityForResult(intent, REQUEST_WEB_FILE)
                return true
            }
        }
    }

    private fun originOf(uri: Uri): String {
        val scheme = uri.scheme?.lowercase() ?: return ""
        val host = uri.host?.lowercase() ?: return ""
        val port = uri.port
        val defaultPort = if (scheme == "http") 80 else 443
        return if (port == -1 || port == defaultPort) {
            "$scheme://$host"
        } else {
            "$scheme://$host:$port"
        }
    }

    /**
     * Explicitly network-first for every top-level load we control (cold start, new WebView,
     * user-initiated open/reload, notification deep link). Drafts and pending attachments live in
     * the page and are never reloaded on resume.
     */
    private fun loadTopLevel(url: String) {
        webView.loadUrl(
            url,
            mapOf(
                "Cache-Control" to "no-cache",
                "Pragma" to "no-cache",
            ),
        )
    }

    private fun reloadTopLevel() {
        val origin = siteOrigin ?: AppRuntime.prefs.siteOrigin ?: return
        val current = webView.url
        loadTopLevel(if (current.isNullOrBlank()) "$origin/" else current)
    }

    private fun openExternally(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    // ---------------------------------------------------------------- intents

    private fun deepLinkFrom(intent: Intent?): String? {
        val sessionId = intent?.getStringExtra(EXTRA_SESSION_ID)
        if (intent != null && sessionId != null) intent.removeExtra(EXTRA_SESSION_ID)
        pendingDeepLink = sessionId
        return sessionId
    }

    private fun importShareIntent(intent: Intent?, savedInstanceState: Bundle?) {
        if (intent == null) return
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        // Capture the payload before clearing the delivered intent, so the background import never
        // reads a mutated intent and an Activity restore cannot import the same share again.
        val shareIntent = Intent(intent)
        val alreadyImported = savedInstanceState?.getBoolean(STATE_SHARE_IMPORTED) ?: false
        intent.action = null
        intent.removeExtra(Intent.EXTRA_TEXT)
        intent.removeExtra(Intent.EXTRA_STREAM)
        intent.clipData = null
        setIntent(Intent(this, MainActivity::class.java))
        if (alreadyImported) return
        AppRuntime.io.execute {
            val summary = AppRuntime.importShareIntent(shareIntent)
            if (summary.skipped.isNotEmpty()) {
                runOnUiThread {
                    val message = getString(R.string.share_skipped, summary.skipped.joinToString(", "))
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    // ---------------------------------------------------------------- BridgeHost.Host

    override fun notificationPermissionGranted(): Boolean = Notifications.canPostEvents(this)

    override fun requestNotificationPermission(onResult: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            onResult(true)
            return
        }
        pendingPermission = onResult
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_PERMISSION)
    }

    override fun pickDocuments(multiple: Boolean, onResult: (List<Uri>?) -> Unit) {
        pendingPick = onResult
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        startActivityForResult(intent, REQUEST_PICK)
    }

    override fun createDocument(name: String, mimeType: String, onResult: (Uri?) -> Unit) {
        pendingCreate = onResult
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, name)
        }
        startActivityForResult(intent, REQUEST_CREATE)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_PERMISSION) return
        val callback = pendingPermission
        pendingPermission = null
        callback?.invoke(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
    }

    @Deprecated("startActivityForResult is used to keep the app free of extra activity dependencies")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQUEST_PICK -> {
                val callback = pendingPick
                pendingPick = null
                if (callback == null) return
                if (resultCode != RESULT_OK || data == null) {
                    callback(null)
                    return
                }
                val uris = mutableListOf<Uri>()
                data.data?.let { uris += it }
                data.clipData?.let { clip ->
                    for (index in 0 until clip.itemCount) {
                        clip.getItemAt(index).uri?.let { if (!uris.contains(it)) uris += it }
                    }
                }
                callback(uris)
            }
            REQUEST_CREATE -> {
                val callback = pendingCreate
                pendingCreate = null
                callback?.invoke(if (resultCode == RESULT_OK) data?.data else null)
            }
            REQUEST_WEB_FILE -> {
                val callback = pendingFileChooser
                pendingFileChooser = null
                if (callback == null) return
                if (resultCode != RESULT_OK || data == null) {
                    callback.onReceiveValue(null)
                    return
                }
                val uris = mutableListOf<Uri>()
                data.data?.let { uris += it }
                data.clipData?.let { clip ->
                    for (index in 0 until clip.itemCount) {
                        clip.getItemAt(index).uri?.let { if (!uris.contains(it)) uris += it }
                    }
                }
                callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            }
        }
    }

    companion object {
        const val EXTRA_SESSION_ID = "ai.cloudcli.android.extra.SESSION_ID"
        private const val REQUEST_PERMISSION = 11
        private const val REQUEST_PICK = 12
        private const val REQUEST_CREATE = 13
        private const val REQUEST_WEB_FILE = 14
        private const val STATE_SHARE_IMPORTED = "cloudcli.share.imported"
        private const val MENU_CHANGE_SITE = 21
        private const val MENU_RELOAD = 22
    }
}
