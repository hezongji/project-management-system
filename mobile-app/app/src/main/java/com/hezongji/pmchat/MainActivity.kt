package com.hezongji.pmchat

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException

/**
 * PM 聊天 —— Android WebView 壳。
 *
 * 加载 https://YOUR-PM-DOMAIN/im（IM 专页），登录态由 Web 层 localStorage 持久化，
 * 壳负责：文件选择（发图/发文件）、附件下载（JS 桥落盘 + 系统通知）、外链跳系统浏览器、
 * 断网重试页、双击退出。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PMChat-Main"
        private const val APP_URL = "https://YOUR-PM-DOMAIN/im"
        private const val UA_SUFFIX = " PMChat/" + BuildConfig.VERSION_NAME
        private const val RETRY_SCHEME = "pmchat://retry"
        private const val DOMAIN = "YOUR-PM-DOMAIN"

        /** v1.2 W5：WebView 录音权限请求码 */
        private const val RECORD_AUDIO_REQUEST_CODE = 4100

        /** 附件下载钩子：拦截 a[download]/blob: 锚点点击 → fetch → base64 → 原生落盘 */
        private const val DOWNLOAD_HOOK_JS = """
            (function() {
              if (window.__pmchatDownloadHook) return;
              window.__pmchatDownloadHook = true;
              document.addEventListener('click', function(ev) {
                var el = ev.target;
                while (el && el !== document &&
                       !(el.tagName === 'A' && (el.hasAttribute('download') ||
                         (el.href || '').indexOf('blob:') === 0))) {
                  el = el.parentNode;
                }
                if (!el || el === document) return;
                var href = el.href || '';
                if (href.indexOf('blob:') !== 0) return;
                ev.preventDefault();
                ev.stopPropagation();
                var name = el.getAttribute('download') || 'pm-chat-download';
                fetch(href).then(function(r) { return r.blob(); }).then(function(b) {
                  var reader = new FileReader();
                  reader.onloadend = function() {
                    try {
                      var data = String(reader.result);
                      var idx = data.indexOf(',');
                      if (window.AndroidBridge) {
                        window.AndroidBridge.saveFile(name, data.substring(idx + 1));
                      }
                    } catch (e) { console.error('pmchat download failed', e); }
                  };
                  reader.readAsDataURL(b);
                }).catch(function(e) { console.error('pmchat fetch failed', e); });
              }, true);
            })();
        """
    }

    private lateinit var webView: WebView

    // ---- 文件选择（onShowFileChooser）----
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCapture: Boolean = false
    private var cameraOutUri: Uri? = null

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        if (result.resultCode == Activity.RESULT_OK) {
            val uris = ArrayList<Uri>()
            result.data?.clipData?.let { clip ->
                for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
            }
            result.data?.data?.let { uris.add(it) }
            if (pendingCapture && cameraOutUri != null && uris.isEmpty()) {
                uris.add(cameraOutUri!!)
            }
            callback.onReceiveValue(uris.toTypedArray())
        } else {
            callback.onReceiveValue(null)
        }
        pendingCapture = false
        cameraOutUri = null
    }

    // ---- 旧系统（API 24-28）写公共目录的存储权限 ----
    private val storagePermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) {
            Toast.makeText(this, "未授予存储权限，附件无法保存", Toast.LENGTH_LONG).show()
        }
    }

    // ---- v1.2 W5：录音权限（targetSdk 34 必须运行时授予才生效）----
    // WebView 请求 RESOURCE_AUDIO_CAPTURE 时若未授权 → 先请求系统权限，回调后 grant/deny
    private var pendingPermissionRequest: android.webkit.PermissionRequest? = null

    private fun ensureRecordAudioPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), RECORD_AUDIO_REQUEST_CODE)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != RECORD_AUDIO_REQUEST_CODE) return
        val pending = pendingPermissionRequest
        pendingPermissionRequest = null
        if (pending == null) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            // WebView 同时被授予 → 直接放行（resources 与权限映射由 WebView 自行处理）
            pending.grant(pending.resources)
        } else {
            pending.deny()
            Toast.makeText(this, "未授予麦克风权限，语音消息不可用", Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webview)
        setupWebView()
        webView.loadUrl(APP_URL)
        // v1.2 W5：启动后延迟请求录音权限（等首屏渲染完成，避免与 WebView 加载竞争）；
        // targetSdk 34 下 RECORD_AUDIO 必须运行时授予，否则 WebView 录音必然失败
        webView.postDelayed({ ensureRecordAudioPermission() }, 500)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true                    // localStorage 登录态持久化关键
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.userAgentString = settings.userAgentString + UA_SUFFIX
        settings.allowFileAccess = false
        settings.setSupportZoom(false)
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true

        // v1.4：消费长按，防系统上下文菜单/文本选择中断触摸流（语音按住说话闪停根因）
        webView.setOnLongClickListener { true }

        webView.addJavascriptInterface(AndroidBridge(this, {
            maybeRequestLegacyStorage()
        }, { enabled ->
            webBackEnabled = enabled
        }), AndroidBridge.NAME)

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                if (filePathCallback == null) return false
                this@MainActivity.filePathCallback = filePathCallback
                launchFileChooser(fileChooserParams)
                return true
            }

            // v1.2 W5：WebView 录音（MediaRecorder）必须放行 RESOURCE_AUDIO_CAPTURE
            override fun onPermissionRequest(request: android.webkit.PermissionRequest?) {
                if (request == null) return
                val resources = request.resources ?: emptyArray()
                if (resources.contains(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity,
                            Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(resources)
                    } else {
                        pendingPermissionRequest = request
                        requestPermissions(
                            arrayOf(Manifest.permission.RECORD_AUDIO),
                            RECORD_AUDIO_REQUEST_CODE
                        )
                    }
                } else {
                    request.deny()
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                return handleUrl(url)
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return handleUrl(url ?: return false)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // SPA 事件委托挂在 document 一次，路由切换后仍生效
                view?.evaluateJavascript(DOWNLOAD_HOOK_JS, null)
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    showRetryPage()
                }
            }

            @Suppress("DEPRECATION")
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                if (failingUrl?.startsWith("http") == true) {
                    showRetryPage()
                }
            }
        }
    }

    /** 路由：壳内域名留 WebView；其他 scheme/域名走系统浏览器 */
    private fun handleUrl(url: String): Boolean {
        if (url == RETRY_SCHEME) {
            webView.loadUrl(APP_URL)
            return true
        }
        if (url.startsWith("http://") || url.startsWith("https://")) {
            val host = Uri.parse(url).host ?: return false
            return if (host == DOMAIN || host.endsWith(".$DOMAIN")) {
                false // 壳内导航
            } else {
                openExternal(url)
                true
            }
        }
        // mailto / tel / intent 等非 http scheme
        if (url.startsWith("intent:")) {
            try {
                startActivity(Intent.parseUri(url, Intent.URI_INTENT_SCHEME))
            } catch (e: Exception) {
                Log.w(TAG, "intent open failed: ${e.message}")
            }
            return true
        }
        return false
    }

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "没有可打开链接的应用", Toast.LENGTH_SHORT).show()
        }
    }

    private fun launchFileChooser(params: WebChromeClient.FileChooserParams?) {
        val accept = params?.acceptTypes ?: emptyArray()
        val acceptAll = accept.isEmpty() || accept.any { it == "*/*" || it.isEmpty() }
        val acceptImage = !acceptAll && accept.any { it.startsWith("image/") }
        val capture = params?.isCaptureEnabled == true

        // v1.2 W5：相机仅当 capture=true（input[capture] 拍照按钮）才走 ACTION_IMAGE_CAPTURE；
        // API<Q 时 accept=image/* 不再自动跳相机（改为普通多选相册），修复选择器体验
        if (capture) {
            pendingCapture = true
            val takePictureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            try {
                val photoFile = createImageFile()
                val uri = FileProvider.getUriForFile(
                    this,
                    "$packageName.fileprovider",
                    photoFile
                )
                cameraOutUri = uri
                takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, uri)
                fileChooserLauncher.launch(takePictureIntent)
                return
            } catch (e: IOException) {
                Log.e(TAG, "camera unavailable", e)
                pendingCapture = false
                // 降级到普通文件选择
            }
        }

        val intent = if (acceptImage && !acceptAll) {
            Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "image/*"
                addCategory(Intent.CATEGORY_OPENABLE)
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        } else {
            params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "*/*"
                addCategory(Intent.CATEGORY_OPENABLE)
            }
        }
        // v1.2 W5：强制多选（ACTION_GET_CONTENT / ACTION_OPEN_DOCUMENT 均生效；
        // 回调已支持 clipData 多 URI，见 fileChooserLauncher）
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        try {
            fileChooserLauncher.launch(intent)
        } catch (e: Exception) {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = null
        }
    }

    @Throws(IOException::class)
    private fun createImageFile(): File {
        val dir = File(cacheDir, "camera")
        if (!dir.exists()) dir.mkdirs()
        return File.createTempFile("pmchat_", ".jpg", dir)
    }

    private fun maybeRequestLegacyStorage() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            storagePermLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }

    private fun showRetryPage() {
        val html = """
            <!DOCTYPE html><html><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;
                   justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#334155}
              h2{color:#1e293b;margin-bottom:4px}
              p{color:#64748b;margin-bottom:24px}
              button{background:#3b82f6;color:#fff;border:none;padding:12px 32px;border-radius:8px;
                     font-size:16px}
            </style></head><body>
            <h2>网络连接失败</h2><p>请检查网络后重试</p>
            <button onclick="location.href='$RETRY_SCHEME'">重试</button>
            </body></html>
        """.trimIndent()
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private var lastBackPressed: Long = 0
    // v1.6：Web 层是否还有上一级（由 JS 桥 setBackEnabled 更新）
    private var webBackEnabled = false

    override fun onBackPressed() {
        // 1. WebView 有历史 → 优先回退
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }
        // 2. Web 层还有上一级 → 通知 Web 层处理（一级一级返回）
        if (webBackEnabled) {
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('pm-back'))", null)
            return
        }
        // 3. 已在顶层 → 双击退出
        val now = System.currentTimeMillis()
        if (now - lastBackPressed < 2000) {
            super.onBackPressed()
        } else {
            lastBackPressed = now
            Toast.makeText(this, R.string.exit_hint, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        // 防止 file chooser 回调悬挂
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        webView.destroy()
        super.onDestroy()
    }
}
