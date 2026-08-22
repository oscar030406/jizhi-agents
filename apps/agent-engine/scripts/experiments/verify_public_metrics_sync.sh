#!/usr/bin/env bash
# 验「改 metrics.json → 重跑 sync-public-metrics → 首页常量跟着变」，
# 并验「口径原文与 value 打架时同步脚本报错」。跑完原样还原 metrics.json（比 sha256）。
#
# 用法（任意工作目录）：
#   bash apps/agent-engine/scripts/experiments/verify_public_metrics_sync.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HERE/../.." && pwd)"
CR="$(cd "$ENGINE/../classroom" && pwd)"
SRC="$ENGINE/data/metrics.json"
BAK="$(mktemp)"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT   # 中途挂掉也把真源还回去

cp "$SRC" "$BAK"
BEFORE=$(sha256sum "$SRC" | cut -d' ' -f1)
echo "== 真源 sha256（改前）: $BEFORE"

echo "== 1) 把口径原文的「12 条判无据」改成 24，重跑同步"
python - "$SRC" <<'PY'
import json,sys
p=sys.argv[1]
d=json.load(open(p,encoding='utf-8'))
m=d['metrics']['api_hallucination_v2']
m['caliber']=m['caliber'].replace('12 条判无据','24 条判无据')
m['value']=24/576
json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
PY
( cd "$CR" && node scripts/sync-public-metrics.mjs )
echo "-- 生成的常量："
python -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['hallucination'])" \
  "$CR/components/home/public-metrics.json"

echo
echo "== 2) 只改 value 不改口径原文（口径与 value 打架）→ 同步脚本必须报错"
cp "$BAK" "$SRC"
python - "$SRC" <<'PY'
import json,sys
p=sys.argv[1]
d=json.load(open(p,encoding='utf-8'))
d['metrics']['api_hallucination_v2']['value']=0.05
json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
PY
( cd "$CR" && node scripts/sync-public-metrics.mjs ) 2>&1 | grep -E "Error|tolerance" | head -3
echo "退出码: ${PIPESTATUS[0]}"

echo
echo "== 3) 还原真源并重跑同步"
cp "$BAK" "$SRC"
AFTER=$(sha256sum "$SRC" | cut -d' ' -f1)
echo "真源 sha256（还原后）: $AFTER"
[ "$BEFORE" = "$AFTER" ] && echo "真源一字未动 ✓" || echo "真源被改坏了 ✗"
( cd "$CR" && node scripts/sync-public-metrics.mjs )
