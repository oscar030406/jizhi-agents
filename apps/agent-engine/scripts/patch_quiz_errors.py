r"""定向修复审计查出的测验语义错误（答案键错、解析自相矛盾、两项同真）。

这些错误在判官不复核的字段里（judge 只查逐句溯源，不查选择题对不对）。每条补丁都：
  1. 先断言"当前的错值确实在"——错值不在就报错退出，绝不盲改（防止重复执行改坏已修数据）；
  2. 再替换成审计给出并经对抗复核确认的正确值。

审计来源：course-content-audit 工作流（每条发现两名独立驳斥者确认存活）。
每条修法的推导写在 PATCHES 的 note 里。course JSON 与 .lesson_cache 两边一起改。

用法：python scripts\patch_quiz_errors.py [--dry-run]
不可重复"套用"，但可重复"运行"——已修过的补丁会因断言不匹配而被跳过并提示。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COURSE = ROOT / "data" / "curriculum" / "llm_basics.json"
CACHE_DIR = ROOT / "data" / ".lesson_cache" / "llm_basics"


def _find_lesson(course: dict, lid: str) -> dict | None:
    for ch in course.get("chapters", []):
        for l in ch["lessons"]:
            if l["lesson_id"] == lid:
                return l
    return None


# 每条补丁是一个作用于单个 check_understanding 题的函数，输入 q（dict），
# 返回 (ok, msg)。断言不满足时返回 (False, 原因)，绝不部分修改。
def patch_llm5_06(q: dict) -> tuple[bool, str]:
    # 序列 [BOS,10,20,30,EOS,PAD,PAD] 共 7 元素，题干误写"长度6"；真答案 B(索引1)。
    if q.get("answer_index") != 0:
        return False, f"answer_index 已非 0（现 {q.get('answer_index')}），跳过"
    if "（长度6" not in q["question"]:
        return False, "题干未见「长度6」，跳过"
    q["question"] = q["question"].replace("（长度6", "（长度7")
    q["answer_index"] = 1
    q["explanation"] = (
        "input_id 共 7 个元素：5 个真实位（BOS,10,20,30,EOS）+ 2 个填充位 PAD。"
        "按 PretrainDataset.__getitem__：X=input_id[:-1]=[BOS,10,20,30,EOS,PAD]，"
        "Y=input_id[1:]=[10,20,30,EOS,PAD,PAD]；原始 loss_mask=[1]*5+[0]*2=[1,1,1,1,1,0,0]"
        "（真实位含 BOS 全标 1、填充位标 0），与 Y 对齐后取 loss_mask[1:]=[1,1,1,1,0,0]。"
        "故选 B。选项 A 的 X、Y 正确但把 loss_mask 首位误标成 0；C、D 的长度都不对。[hl05s03#s11]"
    )
    return True, "answer_index 0→1，题干长度6→7，解析重写"


def patch_llm6_03(q: dict) -> tuple[bool, str]:
    # ΔW=BA，A=(r,k)=(8,1024)、B=(d,r)=(1024,8)，即选项 C(索引2)；当前误设 B(索引1)。
    if q.get("answer_index") != 1:
        return False, f"answer_index 已非 1（现 {q.get('answer_index')}），跳过"
    if q["options"][2] != "A: (8, 1024), B: (1024, 8)":
        return False, "选项[2]不是预期的 C 文本，跳过"
    q["answer_index"] = 2
    q["explanation"] = (
        "按 LoRA 公式 ΔW=BA，其中 W0∈R^{d×k}、B∈R^{d×r}、A∈R^{r×k}。原层输入输出均为 1024，"
        "故 d=k=1024、秩 r=8，得 A=(r,k)=(8,1024)、B=(d,r)=(1024,8)，即选项 C。"
        "代码侧一致：nn.Linear(in,out) 的 weight 形状是 (out,in)，"
        "所以 lora_A=nn.Linear(1024,8) 的权重为 (8,1024)、lora_B=nn.Linear(8,1024) 的权重为 (1024,8)。"
        "选项 B 把两者对调，是最常见的错法。[hl06s03#s4]"
    )
    return True, "answer_index 1→2，解析重写（去掉自我推翻段）"


def patch_llm7_03(q: dict) -> tuple[bool, str]:
    # answer_index=3(D) 正确；解析末「D错误」指的是洗牌前的旧 D（现在 C 位），应改「C错误」。
    if q.get("answer_index") != 3:
        return False, f"answer_index 非 3（现 {q.get('answer_index')}），跳过"
    old = "D错误，打印发生在第二次请求模型之前"
    if old not in q["explanation"]:
        return False, "解析未见「D错误，打印发生在第二次请求模型之前」，跳过"
    q["explanation"] = q["explanation"].replace(old, "C错误，打印发生在第二次请求模型之前")
    return True, "解析末「D错误」→「C错误」（旧D洗牌后落在C位）"


def patch_llm2_08(q: dict) -> tuple[bool, str]:
    # C、D 同真（都是 vocab_size×n_embd 的换序）。把 D 改成假命题，保留 C 唯一正确。
    if q.get("answer_index") != 2:
        return False, f"answer_index 非 2（现 {q.get('answer_index')}），跳过"
    if q["options"][3] != "lm_head 的参数量是 n_embd × vocab_size":
        return False, "选项[3]不是预期的 D 文本，跳过"
    q["options"][3] = "lm_head 的参数量是 n_embd × n_embd"
    q["explanation"] = (
        "wte 是词嵌入层，参数量 = vocab_size × n_embd（如 vocab_size=10000、n_embd=128 则 1,280,000），"
        "故 C 正确。D 错在维度：lm_head 把 n_embd 映射到 vocab_size，其权重形状是 n_embd × vocab_size，"
        "不是 n_embd × n_embd。A、B 也错——正文说 get_num_params() 默认统计全部参数，"
        "且 non_embedding=True 时减去的是 wte.weight 而非 wpe。[hl02s03#s10]"
    )
    return True, "选项D改为假命题(n_embd×n_embd)，解析重写，C 成唯一正确"


PATCHES = {
    ("llm5-06", 0): patch_llm5_06,
    ("llm6-03", 1): patch_llm6_03,
    ("llm7-03", 3): patch_llm7_03,
    ("llm2-08", 1): patch_llm2_08,
}


def apply_to(lesson: dict, cu_index: int, fn) -> tuple[bool, str]:
    cu = lesson.get("check_understanding") or []
    if cu_index >= len(cu):
        return False, f"check_understanding[{cu_index}] 不存在"
    return fn(cu[cu_index])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    course = json.loads(COURSE.read_text(encoding="utf-8"))
    results = []
    course_dirty = False
    for (lid, idx), fn in PATCHES.items():
        lesson = _find_lesson(course, lid)
        if lesson is None:
            results.append((lid, idx, False, "课程里找不到该课时"))
            continue
        ok, msg = apply_to(lesson, idx, fn)
        results.append((lid, idx, ok, msg))
        course_dirty = course_dirty or ok

        # 缓存里同一课时单独一份，用它自己的副本再跑一次同一补丁（幂等断言各自判定）
        cache_f = CACHE_DIR / f"{lid}.json"
        if ok and cache_f.is_file():
            cl = json.loads(cache_f.read_text(encoding="utf-8"))
            c_ok, c_msg = apply_to(cl, idx, fn)
            if c_ok and not args.dry_run:
                cache_f.write_text(json.dumps(cl, ensure_ascii=False, indent=2), encoding="utf-8")
            results.append((lid, idx, c_ok, f"[cache] {c_msg}"))

    if course_dirty and not args.dry_run:
        COURSE.write_text(json.dumps(course, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"{'[dry-run] ' if args.dry_run else ''}补丁结果：")
    for lid, idx, ok, msg in results:
        print(f"  {'✓' if ok else '·'} {lid} cu[{idx}]：{msg}")


if __name__ == "__main__":
    main()
