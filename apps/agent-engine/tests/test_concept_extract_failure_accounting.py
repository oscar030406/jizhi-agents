"""抽取解析失败要记账，不能静默丢节。

`structured_chat` 重试几次仍解析不动就返回 None，而 `extract_from_sections`
拿到 None 时**这一节静默贡献零个概念**。不数一下的话，「词表覆盖打了折扣」
打了多少，事后从 readiness 里查不出来。

2026-08-24 实测：SM 那批线代教材有几节说明文本带嵌套引号，撞坏 JSON、
三次重试都没过。解析器**刻意不修**这类（`_parse_json_object` 的注释写着
补引号的规则会误伤正文），所以丢弃是设计内的——但丢弃必须记账。
"""

from __future__ import annotations

from backend.rag.concepts import extract_from_sections

BODY = "高速计数器直接在硬件层计数，不受扫描周期限制。配置时要选对输入通道。"


def _ask_ok(_system: str, _user: str) -> dict:
    return {
        "concepts": [
            {"name": "高速计数器", "evidence": "高速计数器直接在硬件层计数"},
        ]
    }


def test_解析失败的节贡献零个概念_这是既有行为() -> None:
    # 先钉住既有行为：None 不抛、不炸，只是这一节没东西。
    got = extract_from_sections([("s1", BODY)], lambda _s, _u: None)
    assert got == {}


def test_成功的节照常抽出来() -> None:
    got = extract_from_sections([("s1", BODY)], _ask_ok)
    assert "高速计数器" in got


def test_失败与成功混排时只丢失败那节() -> None:
    calls = {"n": 0}

    def flaky(system: str, user: str) -> dict | None:
        calls["n"] += 1
        return None if calls["n"] == 1 else _ask_ok(system, user)

    got = extract_from_sections([("s1", BODY), ("s2", BODY)], flaky)
    assert calls["n"] == 2, "失败那节不许中断后面的抽取"
    assert "高速计数器" in got


def test_调用方数得出失败次数() -> None:
    """记账靠调用方包一层 ask —— 这是 `_extract_concepts` 用的办法。

    这条钉的是「包一层就数得到」这个前提：`extract_from_sections` 每节
    恰好调一次 `ask`，没有内部重试会让计数虚高。
    """
    failures = 0

    def counting(_system: str, _user: str) -> dict | None:
        nonlocal failures
        failures += 1
        return None

    extract_from_sections([("s1", BODY), ("s2", BODY), ("s3", BODY)], counting)
    assert failures == 3
