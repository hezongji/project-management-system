package com.hezongji.pmchat

import android.Manifest
import android.app.DownloadManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

/**
 * Web → 原生桥。Web 层通过 window.AndroidBridge.saveFile(fileName, base64) 调用。
 *
 * 流程：blob 下载被 JS 钩子拦截 → FileReader 转 base64 → 本桥 → FileSaver 落盘
 * → DownloadManager 插入记录（系统进程发"下载完成"通知，Android 13+ 无需通知权限）。
 */
class AndroidBridge(
    private val context: Context,
    private val onNeedStoragePermission: () -> Unit = {},
    private val onBackEnabledChanged: (Boolean) -> Unit = {}
) {

    companion object {
        private const val TAG = "PMChat-Bridge"
        const val NAME = "AndroidBridge"
    }

    /** v1.6：Web 层告知壳层"是否还有上一级"（返回键一级一级返回） */
    @JavascriptInterface
    fun setBackEnabled(enabled: Boolean) {
        onBackEnabledChanged(enabled)
    }

    /** v1.3：真实版本号（Web「我的」页展示，避免用户误判 APK 版本） */
    @JavascriptInterface
    fun getAppVersion(): String {
        return try {
            val pm = context.packageManager.getPackageInfo(context.packageName, 0)
            pm.versionName ?: "unknown"
        } catch (e: Exception) {
            "unknown"
        }
    }

    // ============================================================
    // v1.4：原生录音（WebView getUserMedia 在部分手机不可用，改用安卓原生 MediaRecorder）
    // Web 端按住说话 → startRecording() → 松开发送 → stopRecording() 返回 base64 JSON
    // ============================================================
    private var recorder: MediaRecorder? = null
    private var recordStartTime: Long = 0
    private var recordFile: File? = null

    private fun hasRecordPermission(): Boolean {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
        return granted == PackageManager.PERMISSION_GRANTED
    }

    /** 开始原生录音：返回 "ok" 或 "error:原因" */
    @JavascriptInterface
    fun startRecording(): String {
        return try {
            if (!hasRecordPermission()) {
                Log.w(TAG, "startRecording: no RECORD_AUDIO permission")
                return "error:未授予麦克风权限，请到系统设置→应用→PM聊天→权限 开启"
            }
            // 若上一段录音未结束（异常），先释放
            stopInternal()
            val file = File(context.cacheDir, "voice_record_${System.currentTimeMillis()}.m4a")
            val rec = MediaRecorder()
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioSamplingRate(44100)
            rec.setAudioEncodingBitRate(128000)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()
            recorder = rec
            recordFile = file
            recordStartTime = System.currentTimeMillis()
            Log.d(TAG, "startRecording ok")
            "ok"
        } catch (e: Exception) {
            Log.e(TAG, "startRecording failed: ${e.message}")
            cleanup()
            "error:${e.message ?: "录音启动失败"}"
        }
    }

    /** 停止录音：返回 JSON {"ok":true,"base64":...,"mime":"audio/mp4","durationMs":...} */
    @JavascriptInterface
    fun stopRecording(): String {
        return try {
            val rec = recorder
            val file = recordFile
            if (rec == null || file == null) {
                return "{\"ok\":false,\"error\":\"未在录音中\"}"
            }
            val durationMs = System.currentTimeMillis() - recordStartTime
            stopInternal()
            if (!file.exists() || file.length() == 0L) {
                cleanup()
                return "{\"ok\":false,\"error\":\"录音内容为空\"}"
            }
            val bytes = file.readBytes()
            val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            cleanup()
            val json = JSONObject()
                .put("ok", true)
                .put("base64", base64)
                .put("mime", "audio/mp4")
                .put("durationMs", durationMs)
            Log.d(TAG, "stopRecording ok: ${bytes.size}B ${durationMs}ms")
            json.toString()
        } catch (e: Exception) {
            Log.e(TAG, "stopRecording failed: ${e.message}")
            cleanup()
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "录音停止失败")
                .toString()
        }
    }

    /** 取消录音：停止并删除临时文件，不返回数据 */
    @JavascriptInterface
    fun cancelRecording() {
        try {
            stopInternal()
            cleanup()
            Log.d(TAG, "cancelRecording")
        } catch (e: Exception) {
            Log.w(TAG, "cancelRecording error: ${e.message}")
        }
    }

    /** 停止 MediaRecorder（不清理文件引用） */
    private fun stopInternal() {
        val rec = recorder
        if (rec != null) {
            try {
                rec.stop()
            } catch (e: Exception) {
                Log.w(TAG, "MediaRecorder stop error: ${e.message}")
            }
            try {
                rec.release()
            } catch (e: Exception) {
                Log.w(TAG, "MediaRecorder release error: ${e.message}")
            }
            recorder = null
        }
    }

    /** 清理临时文件与状态 */
    private fun cleanup() {
        try {
            recordFile?.delete()
        } catch (e: Exception) {
            Log.w(TAG, "delete voice file error: ${e.message}")
        }
        recordFile = null
        recordStartTime = 0
    }

    @JavascriptInterface
    fun saveFile(fileName: String, base64Data: String) {
        Log.d(TAG, "saveFile: $fileName (${base64Data.length} chars)")
        // API 24-28 写公共目录需存储权限：先检查，未授权则请求（用户获准后需重新点击下载）
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "storage permission missing, requesting")
            onNeedStoragePermission()
            return
        }
        val path = FileSaver.save(context, fileName, base64Data)
        if (path == null) {
            Log.e(TAG, "saveFile failed: $fileName")
            return
        }
        notifyDownload(context, fileName, path)
    }

    /** 通过 DownloadManager 插入下载记录，触发系统"下载完成"通知 */
    private fun notifyDownload(context: Context, fileName: String, path: String) {
        try {
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val uri = Uri.parse(path)
            val request = DownloadManager.Request(uri).apply {
                setTitle(fileName)
                setDescription("PM 聊天附件")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                setMimeType("application/octet-stream")
            }
            dm.enqueue(request)
        } catch (e: Exception) {
            // DownloadManager 对 content:// 外的 Uri 或重复场景可能抛异常；落盘已成功，仅通知失败不阻塞
            Log.w(TAG, "DownloadManager enqueue failed: ${e.message}")
        }
    }
}
