#!/usr/bin/env bash
#
# 发布 APK：从 APK 里读 versionCode/versionName，复制到 releases/，更新 apk-version.json
#
#   ./publish-apk.sh                          # 用默认路径（pi-apk 的 release 产物）
#   ./publish-apk.sh /path/to/app-release.apk # 指定 APK
#   ./publish-apk.sh app.apk "更新说明..."
#
# 效果：
#   releases/pi-mobile-<versionName>.apk
#   apk-version.json  ←  versionCode/versionName/url/size/notes 全部自动对齐
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APK="${1:-/root/pi-apk/android/app/build/outputs/apk/release/app-release.apk}"
NOTES="${2:-}"

# ---------- 找 aapt2 ----------
find_aapt() {
  local c
  for c in "${ANDROID_HOME:-}" /opt/android-sdk "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    [ -n "$c" ] || continue
    local p
    p=$(ls -1 "$c"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)
    if [ -n "$p" ] && [ -x "$p" ]; then echo "$p"; return 0; fi
  done
  if command -v aapt2 >/dev/null 2>&1; then command -v aapt2; return 0; fi
  return 1
}
AAPT=$(find_aapt) || { echo "❌ 找不到 aapt2，请设置 ANDROID_HOME"; exit 1; }

[ -f "$APK" ] || { echo "❌ APK 不存在：$APK"; exit 1; }

# ---------- 从 APK 读版本 ----------
# 注意：不要用 | head -1（会让 aapt2 收到 SIGPIPE，pipefail 下误判失败）
BADGING=$("$AAPT" dump badging "$APK" 2>/dev/null | sed -n '1p')
VCODE=$(echo "$BADGING" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")
VNAME=$(echo "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")
PKG=$(echo "$BADGING" | sed -n "s/.*name='\([^']*\)'.*/\1/p")

[ -n "$VCODE" ] && [ -n "$VNAME" ] || { echo "❌ 无法解析版本信息："$BADGING; exit 1; }

echo "📦 包名       $PKG"
echo "🏷  版本       $VNAME  (code $VCODE)"

# ---------- 校验签名 ----------
APKSIGNER=$(dirname "$AAPT")/apksigner
if [ -x "$APKSIGNER" ]; then
  if "$APKSIGNER" verify "$APK" >/dev/null 2>&1; then
    echo "🔏 签名       有效"
  else
    echo "⚠️  签名验证未通过（debug 包？）"
  fi
fi

# ---------- 复制到 releases ----------
mkdir -p "$HERE/releases"
DEST="$HERE/releases/pi-mobile-${VNAME}.apk"
cp -f "$APK" "$DEST"
SIZE=$(stat -c%s "$DEST" 2>/dev/null || stat -f%z "$DEST")
echo "📁 已复制     releases/$(basename "$DEST")  ($(awk "BEGIN{printf \"%.1f\", $SIZE/1048576}") MB)"

# 同步一份到项目根目录，方便直接分发
cp -f "$DEST" "/root/pi-mobile.apk" 2>/dev/null || true

# ---------- 更新 apk-version.json ----------
export VCODE VNAME SIZE NOTES HERE
node - <<'NODE'
const fs = require('fs');
const path = require('path');

const file = path.join(process.env.HERE, 'apk-version.json');
const vcode = Number(process.env.VCODE);
const vname = process.env.VNAME;
const size  = Number(process.env.SIZE);
let notes   = (process.env.NOTES || '').trim();

let old = {};
try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

// 没给说明就沿用旧的（版本没变时不动）
if (!notes) notes = old.notes || '';

const out = {
  versionCode: vcode,
  versionName: vname,
  publishedAt: new Date().toISOString(),
  notes,
  url: `/download/pi-mobile-${vname}.apk`,
  size,
};

// 版本倒退时警告（versionCode 必须递增，否则手机上装不上/检测不到）
if (old.versionCode && vcode < old.versionCode) {
  console.warn(`⚠️  versionCode 从 ${old.versionCode} 降到 ${vcode}，手机将无法识别为升级！`);
}
if (old.versionCode === vcode && old.versionName === vname) {
  console.log('ℹ️  版本未变，仅刷新时间戳与大小');
}

fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log('✅ apk-version.json 已更新');
console.log('   versionCode ' + out.versionCode + '  versionName ' + out.versionName);
console.log('   url         ' + out.url);
NODE

# ---------- 清理旧版本（保留最近 5 个） ----------
cd "$HERE/releases"
ls -1t pi-mobile-*.apk 2>/dev/null | tail -n +6 | while read -r f; do
  echo "🧹 删除旧版本 $f"
  rm -f "$f"
done

echo
echo "完成。"
echo "  下载地址 http://<服务器>:8848$(node -e "console.log(require('$HERE/apk-version.json').url)")"
echo "  提示：若服务器已在运行，/api/version 会在下次请求时读到新值（无缓存）。"
