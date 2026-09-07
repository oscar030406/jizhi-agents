#!/usr/bin/env python3
"""部署后预热：把评委第一眼会碰到的慢路径提前跑一遍，页面打开就是现成的。

在服务器上跑（apply-release 之后，或任何时候手动）：
    python3 scripts/deploy/prewarm.py            # 图谱缓存 + 离线布局 + 四个演示账号的学情诊断
    python3 scripts/deploy/prewarm.py --practice # 再把演示学员的项目带练也生成好（每个约 2 分钟）

预热的是三样：
1. 引擎知识宇宙：每个已开域 GET 一次（建 graph_cache），再 POST /layout 算三维坐标（graph_layout）。
   图没变就是毫秒级复用；变了本机约 15～60 秒一库。
2. 学情诊断：以每个演示账号登录，打 /api/domain-path/<域> 与 /api/adaptive/blueprint，
   引擎侧 blueprint_cache 落盘，之后同一份画像毫秒级。评委答过题掌握度变了会再算一次，
   那是学习行为触发的，不预热。
3. 岗位地图、实操项目清单：各打一次，让 Next 那侧的「最后一次成功数据」兜底也是热的。

只读环境变量 AI_SERVICE_TOKEN（引擎内部令牌，从 /etc/jizhi-engine.env 取）。不打印密钥。
演示登录每角色 15 分钟 5 次配额，这脚本每角色只登一次。
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

WEB = "https://127.0.0.1"
HOST = "jizhi.chenmingkun.cn"
ENGINE = "http://127.0.0.1:8001"
DEMO_ROLES = ("learner", "manager", "learner2", "manager2")


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def token() -> str:
    value = os.environ.get("AI_SERVICE_TOKEN", "").strip()
    if not value:
        for line in open("/etc/jizhi-engine.env", encoding="utf-8"):
            if line.startswith("AI_SERVICE_TOKEN="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not value:
        raise SystemExit("没有 AI_SERVICE_TOKEN，引擎的布局接口调不了")
    return value


class Web:
    """走 nginx 的 https 入口（带 Host 头），cookie 跟着账号走。"""

    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ctx),
        )

    def call(self, path: str, body: dict | None = None, timeout: float = 190) -> tuple[int, float, object]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            WEB + path,
            data=data,
            headers={"Host": HOST, "Content-Type": "application/json", "Accept-Encoding": "gzip"},
            method="POST" if data is not None else "GET",
        )
        started = time.perf_counter()
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as err:
            raw = err.read()
            status = err.code
        elapsed = time.perf_counter() - started
        if raw[:2] == b"\x1f\x8b":
            import gzip

            raw = gzip.decompress(raw)
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except (ValueError, UnicodeDecodeError):
            payload = None
        return status, elapsed, payload


def engine(path: str, method: str = "GET", tok: str | None = None, timeout: float = 600) -> tuple[int, float, object]:
    req = urllib.request.Request(ENGINE + path, method=method)
    if tok:
        req.add_header("x-internal-token", tok)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as err:
        raw = err.read()
        status = err.code
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else None
    except (ValueError, UnicodeDecodeError):
        payload = None
    return status, time.perf_counter() - started, payload


def warm_graphs(tok: str) -> list[str]:
    status, _, registry = engine("/api/domain-intake/corpus-owners")
    corpora: list[str] = []
    if isinstance(registry, dict):
        entries = registry.get("data") if isinstance(registry.get("data"), (dict, list)) else registry
        if isinstance(entries, dict):
            corpora = [k for k in entries.keys() if isinstance(k, str)]
        elif isinstance(entries, list):
            corpora = [e.get("corpus") for e in entries if isinstance(e, dict) and e.get("corpus")]
    if not corpora:
        corpora = ["ai", "iotdb", "smart-manufacturing"]
        log(f"域清单没读到（HTTP {status}），按已知三库预热")
    for name in corpora:
        s, t, g = engine(f"/api/knowledge-graph/{name}")
        n = (g or {}).get("counts", {}).get("nodes") if isinstance(g, dict) else None
        log(f"图谱 {name}: HTTP {s} {t:.1f}s 节点 {n}")
        s, t, info = engine(f"/api/knowledge-graph/{name}/layout", method="POST", tok=tok)
        log(f"布局 {name}: HTTP {s} {t:.1f}s {json.dumps(info, ensure_ascii=False) if isinstance(info, dict) else ''}")
    return corpora


def warm_account(role: str, practice: bool) -> None:
    web = Web()
    s, t, _ = web.call("/api/auth/demo", {"role": role})
    if s >= 400:
        log(f"[{role}] 演示登录 HTTP {s}，跳过（15 分钟配额或账号不在）")
        return
    s, _, profile = web.call("/api/profile")
    prof = profile.get("profile") if isinstance(profile, dict) and isinstance(profile.get("profile"), dict) else profile
    corpus = ""
    goal = ""
    if isinstance(prof, dict):
        corpus = str(prof.get("corpus") or prof.get("domain") or "").strip()
        goal = str(prof.get("learningGoal") or prof.get("learning_goal") or "").strip()
    corpus = corpus or "ai"
    for path in (f"/api/domain-path/{corpus}", f"/api/skills?domain={corpus}", f"/api/practice-scout/{corpus}"):
        s, t, _ = web.call(path)
        log(f"[{role}] {path}: HTTP {s} {t:.1f}s")
    # 报告页的诊断用的是当前课程的阶段名当目标；取学员最近一份课程文档拿它，取不到就用画像目标
    stage_goal = ""
    s, _, docs = web.call("/api/persistence/documents")
    ids = []
    if isinstance(docs, dict):
        items = docs.get("documents") or docs.get("data") or docs.get("items") or []
        if isinstance(items, list):
            ids = [d.get("id") for d in items if isinstance(d, dict) and d.get("id")]
    elif isinstance(docs, list):
        ids = [d.get("id") for d in docs if isinstance(d, dict) and d.get("id")]
    if ids:
        s, _, doc = web.call(f"/api/persistence/documents/{ids[-1]}")
        stage = None
        if isinstance(doc, dict):
            inner = doc.get("document") if isinstance(doc.get("document"), dict) else doc
            stage = (inner.get("stage") or {}) if isinstance(inner, dict) else {}
            if isinstance(stage, dict):
                stage_goal = str(stage.get("name") or "").strip()
    for learning_goal in {g for g in (stage_goal, goal, corpus) if g}:
        s, t, _ = web.call("/api/adaptive/blueprint", {"learningGoal": learning_goal, "profile": prof or {}})
        log(f"[{role}] 学情诊断「{learning_goal[:20]}」: HTTP {s} {t:.1f}s")
    if practice and role.startswith("learner"):
        s, _, scout = web.call(f"/api/practice-scout/{corpus}")
        projects = []
        if isinstance(scout, dict):
            data = scout.get("data") if isinstance(scout.get("data"), dict) else scout
            projects = (data.get("projects") or data.get("items") or []) if isinstance(data, dict) else []
        for project in projects[:2]:
            pid = project.get("id") or project.get("projectId") if isinstance(project, dict) else None
            if not pid:
                continue
            s, t, _ = web.call("/api/practice-guide", {"corpus": corpus, "projectId": pid}, timeout=200)
            log(f"[{role}] 带练 {pid}: HTTP {s} {t:.0f}s")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--practice", action="store_true", help="也预热演示学员的项目带练（每个约 2 分钟）")
    parser.add_argument("--skip-accounts", action="store_true", help="只做图谱与布局")
    args = parser.parse_args()
    tok = token()
    warm_graphs(tok)
    if not args.skip_accounts:
        for role in DEMO_ROLES:
            warm_account(role, args.practice)
    # 复核：预热后再打一次最慢的两条，确认真的变快了
    web = Web()
    web.call("/api/auth/demo", {"role": "learner"})
    for path in ("/api/domain-path/ai",):
        s, t, _ = web.call(path)
        log(f"复核 {path}: HTTP {s} {t:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
