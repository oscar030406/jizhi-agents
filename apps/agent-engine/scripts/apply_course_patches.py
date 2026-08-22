r"""应用 course-patch-resolver 工作流产出的补丁 ops，带强断言，改 course JSON + 缓存。

每个 op：
  {"type":"replace","field_path":"sections[3].body_md","find":"<原文>","replace":"<新文>"}
      —— find 必须在目标字段里恰好出现一次，否则整条补丁跳过（不做部分修改）。
  {"type":"set","field_path":"check_understanding[0].answer_index","value":2}

field_path 语法：形如 a.b[3].c —— 点分段 + 方括号下标混用。

输入：补丁 JSON 文件（{"patches":[{lesson_id,ops,note,confidence}, ...]}）。
用法：python scripts\apply_course_patches.py <patches.json> [--dry-run] [--min-confidence high|medium|low]
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COURSE = ROOT / "data" / "curriculum" / "llm_basics.json"
CACHE_DIR = ROOT / "data" / ".lesson_cache" / "llm_basics"

_SEG = re.compile(r"([A-Za-z_]+)|\[(\d+)\]")


def _parse_path(path: str) -> list:
    """'sections[3].body_md' -> ['sections', 3, 'body_md']"""
    out: list = []
    for name, idx in _SEG.findall(path):
        if name:
            out.append(name)
        else:
            out.append(int(idx))
    return out


def _navigate(root, segs: list):
    """返回 (容器, 末段 key)，供读写。路径无效抛 KeyError/IndexError。"""
    cur = root
    for s in segs[:-1]:
        cur = cur[s]
    return cur, segs[-1]


def _lesson(course: dict, lid: str) -> dict | None:
    for ch in course.get("chapters", []):
        for l in ch["lessons"]:
            if l["lesson_id"] == lid:
                return l
    return None


def apply_ops(lesson: dict, ops: list) -> tuple[bool, list[str]]:
    """原子应用一条补丁的所有 op：先在副本上全过一遍断言，全 OK 才落到 lesson。"""
    import copy
    work = copy.deepcopy(lesson)
    msgs = []
    for op in ops:
        segs = _parse_path(op["field_path"])
        try:
            container, key = _navigate(work, segs)
        except (KeyError, IndexError, TypeError) as e:
            return False, [f"路径无效 {op['field_path']}: {e}"]
        if op["type"] == "replace":
            try:
                cur = container[key]
            except (KeyError, IndexError):
                return False, [f"字段不存在 {op['field_path']}"]
            if not isinstance(cur, str):
                return False, [f"字段非字符串 {op['field_path']}"]
            n = cur.count(op["find"])
            if n != 1:
                return False, [f"find 在 {op['field_path']} 出现 {n} 次（需恰好1次）：{op['find'][:40]!r}"]
            container[key] = cur.replace(op["find"], op["replace"])
            msgs.append(f"replace {op['field_path']}: {op['find'][:30]!r}→{op['replace'][:30]!r}")
        elif op["type"] == "set":
            try:
                _ = container[key] if not isinstance(key, str) else container.get(key)
            except (IndexError, TypeError):
                return False, [f"set 目标不可达 {op['field_path']}"]
            container[key] = op["value"]
            msgs.append(f"set {op['field_path']} = {json.dumps(op['value'], ensure_ascii=False)[:40]}")
        else:
            return False, [f"未知 op 类型 {op['type']}"]
    # 全部通过：把 work 的内容搬回 lesson（原地替换字段）
    lesson.clear()
    lesson.update(work)
    return True, msgs


CONF_RANK = {"low": 0, "medium": 1, "high": 2}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("patches")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--min-confidence", default="low", choices=["low", "medium", "high"])
    args = ap.parse_args()

    data = json.loads(Path(args.patches).read_text(encoding="utf-8"))
    patches = data.get("patches", data if isinstance(data, list) else [])
    floor = CONF_RANK[args.min_confidence]

    course = json.loads(COURSE.read_text(encoding="utf-8"))
    applied = skipped = 0
    course_dirty = False
    for p in patches:
        lid, ops = p["lesson_id"], p.get("ops", [])
        conf = p.get("confidence", "low")
        tag = f"{lid} [{p.get('finding','?')}] ({conf})"
        if not ops:
            print(f"  · {tag}：无 op — {p.get('note','')[:60]}")
            skipped += 1
            continue
        if CONF_RANK.get(conf, 0) < floor:
            print(f"  · {tag}：置信度低于门槛，跳过")
            skipped += 1
            continue
        lesson = _lesson(course, lid)
        if lesson is None:
            print(f"  ✗ {tag}：课程里没有 {lid}")
            skipped += 1
            continue
        ok, msgs = apply_ops(lesson, ops)
        if ok:
            applied += 1
            course_dirty = True
            print(f"  ✓ {tag}：{len(ops)} op — {p.get('note','')[:50]}")
            for m in msgs:
                print(f"        {m}")
            # 缓存副本同步
            cache_f = CACHE_DIR / f"{lid}.json"
            if not args.dry_run and cache_f.is_file():
                cl = json.loads(cache_f.read_text(encoding="utf-8"))
                c_ok, _ = apply_ops(cl, ops)
                if c_ok:
                    cache_f.write_text(json.dumps(cl, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            print(f"  ✗ {tag}：断言失败 — {msgs[0]}")
            skipped += 1

    if course_dirty and not args.dry_run:
        COURSE.write_text(json.dumps(course, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{'[dry-run] ' if args.dry_run else ''}应用 {applied}，跳过 {skipped}")


if __name__ == "__main__":
    main()
