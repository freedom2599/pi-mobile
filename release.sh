#!/usr/bin/env bash
#
# 发版脚本：分「内部测试」和「公开稳定」两条线。
#
#   ./release.sh test "更新说明"        打包 → 自服务器发布（0.xx，不推 GitHub）
#   ./release.sh stable "更新说明"      打包 → 自服务器发布 → 创建 GitHub Release（0.x）
#
# 版本规则：
#   内部测试  0.xx   例如 0.37, 0.38（两位小数）
#   公开稳定  0.x    例如 0.4, 0.5（一位小数）
#   versionCode 始终递增（前一版 +1），保证能覆盖安装且能检测到升级。
#
# GitHub Release 发布需要审批：脚本会先打印将要发布的内容，等你输入 y 才继续。
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APK_PROJ="/root/pi-apk"
GRADLE="$APK_PROJ/android/app/build.gradle"
WWW_INDEX="$APK_PROJ/www/index.html"
TOKEN="${GITHUB_TOKEN:-$(grep -E '^GITHUB_TOKEN=' "$HERE/.env" 2>/dev/null | cut -d= -f2- || true)}"
REPO="${GITHUB_REPO:-freedom2599/pi-mobile}"

MODE="${1:-}"
NOTES="${2:-}"

die() { echo "❌ $*" >&2; exit 1; }

[ -n "$MODE" ] || { sed -n '3,12p' "$0" | sed 's/^# \?//'; exit 1; }
case "$MODE" in
  test|stable) ;;
  *) die "模式只能是 test 或 stable" ;;
esac

# ---------- 计算下一个版本号 ----------
read -r CUR_CODE CUR_NAME < <(node -e "
  const fs=require('fs');
  let v={versionCode:0,versionName:'0.0'};
  try{ v=JSON.parse(fs.readFileSync('$HERE/apk-version.json','utf8')) }catch{}
  console.log(v.versionCode+' '+v.versionName);
")
[ -n "$CUR_CODE" ] || CUR_CODE=0
NEXT_CODE=$((CUR_CODE + 1))

NEXT_NAME=$(node -e "
  const mode='$MODE', cur='$CUR_NAME';
  const parts=cur.split('.');
  const minor = parts.length>1 ? parseInt(parts[1],10) : 0;

  // 内部号：两位及以上小数（0.37, 0.99）
  const isInternal = String(minor).length >= 2;

  if (mode === 'test') {
    if (isInternal) {
      console.log('0.' + (minor + 1));              // 0.37 -> 0.38, 0.99 -> 0.100
    } else {
      console.log('0.' + (minor * 10 + 1));         // 0.4  -> 0.41
    }
  } else {
    // 稳定版：取比当前内部号大的下一个整数位
    if (isInternal) {
      console.log('0.' + (Math.floor(minor / 10) + 1));   // 0.37 -> 0.4, 0.99 -> 0.10
    } else {
      console.log('0.' + (minor + 1));                     // 0.4 -> 0.5
    }
  }
")

# 防止 stable 版本号不高于已有 stable
if [ "$MODE" = stable ]; then
  LAST_STABLE=$(node -e "
    try{
      const fs=require('fs');
      const f='$HERE/.last-stable';
      console.log(fs.existsSync(f)?fs.readFileSync(f,'utf8').trim():'0.0');
    }catch{console.log('0.0')}
  ")
  if [ "$(node -e "console.log('$NEXT_NAME'.localeCompare('$LAST_STABLE',undefined,{numeric:true}))")" -le 0 ]; then
    die "稳定版 $NEXT_NAME 不高于上一个稳定版 $LAST_STABLE，请检查"
  fi
fi

echo "════════════════════════════════════════════"
echo " 模式      $([ "$MODE" = test ] && echo '内部测试（不发布 GitHub）' || echo '公开稳定（发布 GitHub Release）')"
echo " 当前版本  $CUR_NAME  (code $CUR_CODE)"
echo " 新版本    $NEXT_NAME  (code $NEXT_CODE)"
echo "════════════════════════════════════════════"
[ -n "$NOTES" ] && { echo; echo "更新说明:"; echo "$NOTES"; echo; }

# ---------- stable 先审批，再打包（避免取消后留下半成品版本）----------
if [ "$MODE" = stable ]; then
  [ -n "$TOKEN" ] || die "缺少 GITHUB_TOKEN（放 .env 或环境变量）"

  echo
  echo "────────────────────────────────────────────"
  echo " 即将发布公开稳定版"
  echo " 仓库    $REPO"
  echo " Tag     v$NEXT_NAME"
  echo " 附件    pi-mobile-$NEXT_NAME.apk"
  echo " 类型    公开稳定版（非 prerelease）"
  echo "────────────────────────────────────────────"
  read -rp "确认打包并发布？输入 y 继续，其它键取消: " ans
  [ "$ans" = "y" ] || { echo "已取消，未做任何改动。"; exit 0; }
  echo
fi

# ---------- 更新版本号并打包 ----------
echo "▶️  更新版本号…"
sed -i "s/versionCode [0-9]\+/versionCode $NEXT_CODE/" "$GRADLE"
sed -i "s/versionName \"[^\"]*\"/versionName \"$NEXT_NAME\"/" "$GRADLE"
sed -i "s/window.__APP_VERSION__ = [0-9]\+;/window.__APP_VERSION__ = $NEXT_CODE;/" "$WWW_INDEX"

grep -q "versionCode $NEXT_CODE" "$GRADLE" || die "build.gradle 版本号写入失败"
grep -q "__APP_VERSION__ = $NEXT_CODE" "$WWW_INDEX" || die "index.html 版本号写入失败"

echo "▶️  同步 web 资源…"
cd "$APK_PROJ"
ANDROID_HOME=/opt/android-sdk npx cap sync android >/dev/null 2>&1 || die "cap sync 失败"

echo "▶️  编译 APK…"
cd "$APK_PROJ/android"
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
export ANDROID_HOME=/opt/android-sdk
# 签名配置来自 .env（不进仓库）
if [ -f "$APK_PROJ/.env" ]; then set -a; . "$APK_PROJ/.env"; set +a; fi
./gradlew assembleRelease --no-daemon -q 2>&1 | tail -3 || die "编译失败"

APK_OUT="$APK_PROJ/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK_OUT" ] || die "找不到编译产物"

# ---------- 发布到自建服务器 ----------
echo "▶️  发布到 releases/ …"
cd "$HERE"
./publish-apk.sh "$APK_OUT" "${NOTES:-}" | tail -6

# ---------- GitHub Release（需审批）----------
if [ "$MODE" = stable ]; then
  [ -n "$TOKEN" ] || die "缺少 GITHUB_TOKEN（放 .env 或环境变量）"

  echo "▶️  创建 Release…"
  BODY=$(node -e "
    const fs=require('fs');
    const v=JSON.parse(fs.readFileSync('$HERE/apk-version.json','utf8'));
    const notes=process.env.NOTES||v.notes||'';
    console.log(JSON.stringify({
      tag_name:'v'+v.versionName,
      name:'π mobile '+v.versionName,
      body: notes + '\n\n---\n\n下载下方 pi-mobile-' + v.versionName + '.apk，安装时需允许「安装未知应用」。\n\n服务器只提供 API，启动方式见 README。',
      draft:false,
      prerelease:false,
      target_commitish:'master'
    }));
  ")
  REL=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases" -d "$BODY")
  RELID=$(echo "$REL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id||'')}catch{console.log('')}})")

  if [ -z "$RELID" ]; then
    echo "$REL" | head -c 300; die "创建 Release 失败"
  fi

  echo "▶️  上传 APK…"
  UP=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/vnd.android.package-archive" \
    --data-binary @"$HERE/releases/pi-mobile-$NEXT_NAME.apk" \
    "https://uploads.github.com/repos/$REPO/releases/$RELID/assets?name=pi-mobile-$NEXT_NAME.apk")
  echo "$UP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try{const j=JSON.parse(s); if(j.id) console.log('✅ 已上传:', j.browser_download_url); else console.log('❌', j.message)}catch{console.log('❌ 上传响应异常')}
  })"

  echo "$NEXT_NAME" > "$HERE/.last-stable"
  echo
  echo "✅ 稳定版 $NEXT_NAME 已发布"
  echo "   https://github.com/$REPO/releases/tag/v$NEXT_NAME"
else
  echo
  echo "✅ 内部测试版 $NEXT_NAME 已发到自建服务器"
  echo "   http://<你的服务器>:8848/download/pi-mobile-$NEXT_NAME.apk"
  echo "   （未发布到 GitHub；等测试稳定后用 ./release.sh stable 发正式版）"
fi
