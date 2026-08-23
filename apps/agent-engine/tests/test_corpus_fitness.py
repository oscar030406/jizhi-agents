"""语料适配性前置闸。

这道闸的价值全在「判得对不对」，所以测的是判定逻辑本身：
玩具库必须标红、够量的库不能被画像误判成红、以及**它永远不删块**。
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from corpus_fitness import (  # noqa: E402
    RED_CHUNKS,
    YELLOW_CHUNKS,
    gate_a,
    notes,
    profile_chunk,
    verdict,
)

ROOT = Path(__file__).resolve().parents[1]


def rows(n: int, content: str = "这是一段够长的中文正文。" * 12) -> list[dict]:
    return [{"content": content, "title": f"第{i}章 / 小节"} for i in range(n)]


def test_toy_corpus_is_red():
    """4 块 / 12 块的玩具库必须标红——标不红这道闸就没有存在意义。"""
    for n in (4, 12):
        light, why = verdict(gate_a(rows(n)))
        assert light == "red", n
        assert str(n) in why[0]


def test_enough_chunks_is_green_even_with_ugly_profile():
    """块够就是绿灯。短块、无标题这些画像**没有通过效果标定**，不许把库判红——
    真按它们判红过的话，接地率最高的主语料反而会被误伤。"""
    ugly = [{"content": "短", "title": "a.md"} for _ in range(YELLOW_CHUNKS)]
    light, _ = verdict(gate_a(ugly))
    assert light == "green"
    assert notes(gate_a(ugly)), "画像异常要照样报出来，只是不判灯"


def test_yellow_band_is_between_the_two_course_lengths():
    assert verdict(gate_a(rows(RED_CHUNKS)))[0] == "yellow"
    assert verdict(gate_a(rows(YELLOW_CHUNKS - 1)))[0] == "yellow"
    assert verdict(gate_a(rows(YELLOW_CHUNKS)))[0] == "green"


def test_gopher_flags_are_per_block_and_language_neutral():
    """符号比/项目符号/省略号三条按 Gopher 已发表阈值逐块判。中文块不因为不含空格被误判。"""
    plain = profile_chunk("这是一段正常的中文说明文字，讲清楚了一件事的来龙去脉。", "标题")
    assert not (plain["bad_symbol"] or plain["bad_bullet"] or plain["bad_ellipsis"])
    bullets = profile_chunk("- 一\n- 二\n- 三\n- 四", "标题")
    assert bullets["bad_bullet"]
    assert profile_chunk("正文……\n还是……\n又是……", "标题")["bad_ellipsis"]


def test_markdown_heading_markers_do_not_count_as_symbols():
    """块正文以 markdown 标题开头是结构不是噪声。不剥掉的话六个库会被同一条语法一起判死。"""
    assert not profile_chunk("# 标题\n\n## 小标题\n\n正文内容写在这里，说明一件事。", "标题")["bad_symbol"]


def test_run_does_not_touch_the_corpus_files(tmp_path):
    """**只报警不拒绝**：跑完一遍，语料索引一个字节都不能变。"""
    index = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"
    if not index.is_file():
        return  # 本机没有引擎数据目录
    before = index.stat().st_size, index.stat().st_mtime_ns
    out = tmp_path / "fitness.json"
    proc = subprocess.run(
        [sys.executable, "scripts/corpus_fitness.py", "--out", str(out)],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    assert proc.returncode == 0, proc.stderr
    assert (index.stat().st_size, index.stat().st_mtime_ns) == before
    report = json.loads(out.read_text(encoding="utf-8"))
    # 不写死库名。原来钉的是 {ai, iotdb, odoo}，2026-08-23 泛化域收敛到
    # 智能制造 + iotdb、odoo 删掉之后这条直接红——**测试挂在会被删的库上，
    # 测的就不再是判据本身**（同一天在 knowledge-fitness 上已经栽过一次）。
    # 这里要证的是「盘上有几个库就量几个」，不是「某某库必须在」。
    on_disk = {
        p.name
        for p in (ROOT / "data" / "knowledge_base" / "corpora").iterdir()
        if p.is_dir() and (p / "knowledge_index.jsonl").is_file()
    } if (ROOT / "data" / "knowledge_base" / "corpora").is_dir() else set()
    assert "ai" in report["corpora"], "主语料任何时候都该在"
    assert on_disk <= set(report["corpora"]), (
        f"盘上有这些库却没量到：{on_disk - set(report['corpora'])}"
    )
    assert all(c["light"] in {"red", "yellow", "green"} for c in report["corpora"].values())
