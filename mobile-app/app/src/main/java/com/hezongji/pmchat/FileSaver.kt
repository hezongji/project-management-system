package com.hezongji.pmchat

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * 附件落盘工具。
 *
 * - API 29+（Android 10+）：经 MediaStore.Downloads 写入公共下载目录（无需存储权限）。
 * - API 24-28（Android 7-9）：直接写公共 Downloads 目录（壳仅需 WRITE_EXTERNAL_STORAGE 权限，
 *   targetSdk 34 下若单独为旧系统声明该权限需运行时请求；见 MainActivity.requestLegacyStorage()）。
 *
 * 落盘后统一走 DownloadManager 插入下载记录，由系统进程发"下载完成"通知
 * （不受 Android 13+ POST_NOTIFICATIONS 运行时权限限制）。
 */
object FileSaver {
    private const val TAG = "PMChat-FileSaver"

    /**
     * 保存文件，返回落盘路径。
     * @param fileName 原始文件名（Web 侧 a.download 值）
     * @param base64Data data URL 去掉前缀后的纯 base64 载荷
     * @return 落盘后的绝对路径；失败返回 null
     */
    fun save(context: Context, fileName: String, base64Data: String): String? {
        val safeName = sanitize(fileName)
        val bytes = try {
            Base64.decode(base64Data, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "base64 decode failed", e)
            return null
        }
        if (bytes.isEmpty()) {
            Log.e(TAG, "empty content: $safeName")
            return null
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveToMediaStore(context, safeName, bytes)
        } else {
            saveToPublicDir(context, safeName, bytes)
        }
    }

    /** API 29+：MediaStore.Downloads，返回 content Uri 转字符串路径 */
    private fun saveToMediaStore(context: Context, name: String, bytes: ByteArray): String? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, guessMime(name))
            put(MediaStore.Downloads.IS_PENDING, 1)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: run {
            Log.e(TAG, "MediaStore insert failed")
            return null
        }
        return try {
            resolver.openOutputStream(uri)?.use { out ->
                out.write(bytes)
                out.flush()
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            uri.toString()
        } catch (e: Exception) {
            Log.e(TAG, "MediaStore write failed", e)
            resolver.delete(uri, null, null)
            null
        }
    }

    /** API 24-28：直接写公共 Downloads 目录 */
    private fun saveToPublicDir(context: Context, name: String, bytes: ByteArray): String? {
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!dir.exists()) dir.mkdirs()
        val target = File(dir, uniqueName(dir, name))
        return try {
            FileOutputStream(target).use { out ->
                out.write(bytes)
                out.flush()
            }
            // 旧系统仍需媒体库索引（可选，通知走 DownloadManager 不依赖扫描）
            MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null)
            target.absolutePath
        } catch (e: Exception) {
            Log.e(TAG, "public dir write failed", e)
            null
        }
    }

    private fun uniqueName(dir: File, name: String): String {
        val candidate = name
        if (!File(dir, candidate).exists()) return candidate
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while (File(dir, "$base($i)$ext").exists()) i++
        return "$base($i)$ext"
    }

    private fun sanitize(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
        return cleaned.ifEmpty { "pm-chat-download" }
    }

    private fun guessMime(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "pdf" -> "application/pdf"
            "zip" -> "application/zip"
            "doc", "docx" -> "application/msword"
            "xls", "xlsx" -> "application/vnd.ms-excel"
            "ppt", "pptx" -> "application/vnd.ms-powerpoint"
            "txt" -> "text/plain"
            "mp4" -> "video/mp4"
            "mp3" -> "audio/mpeg"
            "apk" -> "application/vnd.android.package-archive"
            else -> "application/octet-stream"
        }
    }
}
