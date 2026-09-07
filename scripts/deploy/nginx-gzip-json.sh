#!/usr/bin/env bash
# 让 nginx 也压 JSON。线上 nginx.conf 的 gzip_types 只有 text/plain、js、css、xml，
# 知识宇宙那条 818 KB～1.6 MB 的 JSON 一直是裸传的；补上 application/json 后约缩到五分之一。
# 幂等：已经有就不动。改完 nginx -t 通过才 reload。
set -euo pipefail
CONF=${1:-/xp/server/nginx/conf/nginx.conf}
NGINX=${NGINX_BIN:-/xp/server/nginx/sbin/nginx}

if grep -qE '^\s*gzip_types.*application/json' "$CONF"; then
  echo "已含 application/json，不改：$CONF"
else
  cp -a "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"
  sed -i -E 's#^(\s*gzip_types\s+)(.*);#\1\2 application/json;#' "$CONF"
  grep -nE '^\s*gzip_types' "$CONF"
fi
"$NGINX" -t
if systemctl is-active --quiet xp-nginx; then systemctl reload xp-nginx; else "$NGINX" -s reload; fi
curl -sk --resolve jizhi.chenmingkun.cn:443:127.0.0.1 -H 'Accept-Encoding: gzip' -o /dev/null -D - \
  https://jizhi.chenmingkun.cn/api/knowledge-graph/ai | grep -i 'content-encoding' || echo '仍未压缩，检查 gzip_proxied 与响应头'
