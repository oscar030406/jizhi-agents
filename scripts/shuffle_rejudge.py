"""装饰性引用对照：同一批断言，一次配真引用、一次配打乱的引用，问同一个判官同一句话。

两组 supported 数接近 ⇒ 判官的 supported 不依赖被引资料的内容，引用是装饰性的，
无源率的下降就不能读成"编造减少"。设计出处：
docs/03-design/grounded-prompting-patch-20260816.md §4.6。

用法：python shuffle_rejudge.py <run_id> [样本数=10] [seed=20260817]

本脚本原是 WO-K2 那一轮写在会话 scratchpad 里的临时工具，L2 的复算要靠它，2026-08-17 晚按用户裁决落进 `scripts/`。**除了把写死的绝对路径改成按 __file__ 推导，一个字都没动**——动了 K2 报告里那些数就不再可复算。
"""
import glob
import json
import os
import random
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

KB = os.path.join(ROOT, "apps", "agent-engine", "data", "knowledge_base")
RUNS = os.path.join(KB, "intake_runs")
JUDGE = "Qwen/Qwen3.6-35B-A3B"  # 与生产审核第一判官同型号，尺子不换
URL = "https://api.siliconflow.cn/v1/chat/completions"

with open(os.path.join(ROOT, "apps", "classroom", ".env.local"), encoding="utf-8-sig") as f:
    KEY = next(l.split("=", 1)[1].strip() for l in f if l.startswith("SILICONFLOW_API_KEY="))

# 判定口径逐字取自 hallucination-audit.ts 的 EVIDENCE_ADDENDUM，不另造尺子
SYSTEM = """你是事实审核员。下面每一项给你一条断言和一段【参考资料】。
只判断这段资料能不能支撑这条断言：
- supported：断言被资料直接支持，或是资料内容的合理同义转述
- uncertain：资料未覆盖该断言（即使常识上可能成立——超出证据边界如实标注）
- incorrect：与资料相悖，或与公认知识明显相悖
只输出一个 JSON 对象，不要围栏不要解释：
{"results":[{"index":1,"verdict":"supported|uncertain|incorrect","reason":"一句话理由"}]}"""


def chunk_text(corpus, source_id):
    path = os.path.join(KB, "corpora", corpus, "knowledge_index.jsonl")
    with open(path, encoding="utf-8") as f:
        for line in f:
            if source_id in line:
                d = json.loads(line)
                if d.get("source_id") == source_id:
                    return d.get("content", "")
    return None


def collect(run_id):
    out = []
    for path in sorted(glob.glob(os.path.join(RUNS, run_id, "trial_courses", "*.json"))):
        if "kc_misses" in path:
            continue
        course = json.load(open(path, encoding="utf-8"))
        corpus = course.get("corpus")
        for i, sc in enumerate(course.get("scenes", []), 1):
            a = sc.get("audit") or {}
            if (not a.get("corpus")) or not a.get("evidenceCount"):
                continue
            pool = [s["source_id"] for s in (a.get("sources") or [])]
            for c in a.get("claims") or []:
                ids = c.get("sourceIds") or []
                if c.get("verdict") == "supported" and ids:
                    out.append(dict(corpus=corpus, screen=f"{os.path.basename(path)[:-5]}#{i}",
                                    claim=c["claim"], real=ids[0], pool=pool))
    return out


def ask(items, key):
    """key: 'real' or 'shuf' — which source id field to show."""
    lines = []
    for j, it in enumerate(items, 1):
        lines.append(f"[{j}] 断言：{it['claim']}\n参考资料：\n{it[key + '_text'][:2200]}\n")
    body = json.dumps({
        "model": JUDGE,
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": "\n".join(lines)}],
        "temperature": 0,
        # 判官是思考型模型，思考走 reasoning_content 但仍吃 max_tokens，给窄了正文出不来
        "max_tokens": 12000,
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        msg = json.loads(r.read())["choices"][0]["message"]
    txt = msg.get("content") or msg.get("reasoning_content") or ""
    s, e = txt.find("{"), txt.rfind("}")
    if s < 0 or e <= s:
        raise ValueError(f"判官没吐 JSON，收到 {len(txt)} 字：{txt[:200]!r}")
    return json.loads(txt[s:e + 1])["results"]


def main():
    run_id = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 20260817
    rng = random.Random(seed)

    cands = collect(run_id)
    print(f"{run_id}: supported∧有源的断言 {len(cands)} 条，抽 {k} 条")
    items = rng.sample(cands, min(k, len(cands)))

    # 打乱：每条换成同屏证据池里另一个 id（拿不到别的就跨条借用，保证 != 原引用）
    for it in items:
        alts = [s for s in it["pool"] if s != it["real"]] or \
               [o["real"] for o in items if o["real"] != it["real"]]
        it["shuf"] = rng.choice(alts) if alts else it["real"]

    for it in items:
        for key in ("real", "shuf"):
            t = chunk_text(it["corpus"], it[key])
            if t is None:
                print(f"  !! 语料里找不到 {it[key]}，该条丢弃")
            it[key + "_text"] = t or ""
    items = [it for it in items if it["real_text"] and it["shuf_text"]]
    print(f"两侧语料都取到的：{len(items)} 条\n")

    res = {}
    for key in ("real", "shuf"):
        for attempt in range(3):
            try:
                res[key] = ask(items, key)
                break
            except Exception as e:
                print(f"  {key} 第{attempt+1}次失败：{type(e).__name__} {str(e)[:90]}")
                time.sleep(20)
        else:
            print(f"{key} 组三次都没打通，放弃")
            return

    print(f"{'#':>2} {'真引用':<10} {'打乱引用':<10}  断言")
    same = 0
    for j, it in enumerate(items, 1):
        a = next((r["verdict"] for r in res["real"] if r["index"] == j), "?")
        b = next((r["verdict"] for r in res["shuf"] if r["index"] == j), "?")
        same += a == b
        print(f"{j:>2} {a:<10} {b:<10}  {it['claim'][:44]}")
    sr = sum(r["verdict"] == "supported" for r in res["real"])
    ss = sum(r["verdict"] == "supported" for r in res["shuf"])
    n = len(items)
    print(f"\nsupported：真引用 {sr}/{n}，打乱引用 {ss}/{n}，逐条判词相同 {same}/{n}")
    print("判读：两侧 supported 数接近 ⇒ 引用装饰性；真引用明显更高 ⇒ 引用带信息。")
    json.dump({"run": run_id, "seed": seed, "n": n, "real_supported": sr, "shuf_supported": ss,
               "same": same,
               "detail": [{"claim": it["claim"], "screen": it["screen"], "real": it["real"],
                           "shuf": it["shuf"],
                           "v_real": next((r["verdict"] for r in res["real"] if r["index"] == j), None),
                           "v_shuf": next((r["verdict"] for r in res["shuf"] if r["index"] == j), None)}
                          for j, it in enumerate(items, 1)]},
              open(f"shuffle_{run_id}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
