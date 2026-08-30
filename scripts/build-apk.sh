#!/usr/bin/env bash
# =============================================================================
# PM 聊天 Android APK 构建脚本（S4-W3）
#
# 功能：
#   1. 首次运行自动生成自签 keystore（RSA 2048 / 10000 天 / alias pmchat）
#   2. gradle assembleRelease 出未签名 APK
#   3. zipalign 对齐 + apksigner 签名（v1+v2）
#   4. apksigner verify 校验，输出最终 APK 路径
#
# 用法：
#   bash scripts/build-apk.sh            # release（默认）
#   bash scripts/build-apk.sh debug      # debug 包（开发调试用）
#
# 依赖：
#   - JDK 17（java/keytool）
#   - Android SDK：ANDROID_HOME 或 /opt/android-sdk（platforms/android-34 + build-tools/34.0.0）
#   - Gradle：GRADLE_HOME 或 /opt/gradle-8.7/bin/gradle 或系统 PATH 中 gradle
#
# keystore 安全提示（重要）：
#   自签密钥丢失 = 签名变更 = 已装员工必须卸载重装（丢登录态/聊天记录缓存）。
#   首次生成后请立即把 mobile-app/keystore/pmchat.jks 异地备份，
#   并把 keystore 密码、alias、alias 密码记录到安全密码管理器（勿提交到 git）。
# =============================================================================
set -euo pipefail

# ---------- 路径探测 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"          # 仓库根
MOBILE_DIR="$ROOT_DIR/mobile-app"
OUTPUT_DIR="$MOBILE_DIR/app/build/outputs/apk"
KEYSTORE_DIR="$MOBILE_DIR/keystore"
KEYSTORE="$KEYSTORE_DIR/pmchat.jks"

# ---------- 环境探测 ----------
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if command -v gradle >/dev/null 2>&1; then
  GRADLE="$(command -v gradle)"
elif [ -x /opt/gradle-8.7/bin/gradle ]; then
  GRADLE=/opt/gradle-8.7/bin/gradle
else
  echo "错误: 未找到 gradle（检查 PATH / GRADLE_HOME / /opt/gradle-8.7）" >&2
  exit 1
fi

BUILD_TOOLS="$ANDROID_HOME/build-tools/34.0.0"
if [ ! -d "$BUILD_TOOLS" ]; then
  BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1)"
fi
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER="$BUILD_TOOLS/apksigner"

# ---------- keystore 参数（默认值；生产可改） ----------
KEYSTORE_PASS="${KEYSTORE_PASS:-pmchat2026}"
KEY_ALIAS="${KEY_ALIAS:-pmchat}"
KEY_PASS="${KEY_PASS:-$KEYSTORE_PASS}"
KEY_DNAME="${KEY_DNAME:-CN=PM Chat, OU=Hezongji, O=Hezongji, L=Beijing, ST=Beijing, C=CN}"

MODE="${1:-release}"

# ---------- 1. keystore 生成（可重复执行，已存在则复用） ----------
if [ ! -f "$KEYSTORE" ]; then
  echo ">> 生成自签 keystore: $KEYSTORE"
  mkdir -p "$KEYSTORE_DIR"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -storepass "$KEYSTORE_PASS" \
    -keypass "$KEY_PASS" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 \
    -validity 10000 \
    -dname "$KEY_DNAME"
else
  echo ">> 复用已存在 keystore: $KEYSTORE"
fi

# ---------- 2. gradle 构建 ----------
cd "$MOBILE_DIR"
# 版本号从 build.gradle.kts 读取（v4-pro N2：参数化，避免发版遗漏）
APP_VERSION="$(grep -oP 'versionName = "\K[^"]+' "$MOBILE_DIR/app/build.gradle.kts" | head -1)"
echo ">> gradle assemble$([ "$MODE" = debug ] && echo Debug || echo Release) (version ${APP_VERSION})"
"$GRADLE" -p "$MOBILE_DIR" "assemble${MODE^}"

# ---------- 3. 签名 ----------
if [ "$MODE" = release ]; then
  UNSIGNED="$OUTPUT_DIR/release/app-release-unsigned.apk"
  FINAL="$OUTPUT_DIR/release/pm-chat-${APP_VERSION}.apk"
  if [ ! -f "$UNSIGNED" ]; then
    echo "错误: 未找到未签名 APK: $UNSIGNED" >&2
    exit 1
  fi
  echo ">> zipalign 对齐"
  "$ZIPALIGN" -f 4 "$UNSIGNED" "$FINAL"
  echo ">> apksigner 签名 (v1+v2)"
  "$APKSIGNER" sign \
    --ks "$KEYSTORE" \
    --ks-key-alias "$KEY_ALIAS" \
    --ks-pass "pass:$KEYSTORE_PASS" \
    --key-pass "pass:$KEY_PASS" \
    --out "$FINAL" \
    "$FINAL"
  echo ">> apksigner verify"
  "$APKSIGNER" verify --verbose "$FINAL"
  echo ""
  echo "✅ 构建完成: $FINAL"
  echo "   大小: $(du -h "$FINAL" | cut -f1)"
  echo "   SHA-256: $(sha256sum "$FINAL" | cut -d' ' -f1)"
else
  DEBUG_APK="$OUTPUT_DIR/debug/app-debug.apk"
  [ -f "$DEBUG_APK" ] && echo "✅ 构建完成: $DEBUG_APK"
fi
