"""域中文名截断不许切在半个词上。

线上实测（2026-08-24）：疆域写「智能制造技能培训：ROS2 机器人开发与西门子
S7-1200 PLC 编程」，原来的 `line[:24]` 出来是
「智能制造技能培训：ROS2 机器人开发与西门子 」——断在「西门子」后面、
尾巴还挂着空格，读起来像话说了一半。管理端只能靠 label_overridden 手改兜住。
"""

from __future__ import annotations

import pytest

from backend.services.domain_intake import _scope_label, _trim_at_word_boundary


def test_中文断在连词之前不留半句() -> None:
    got = _scope_label(
        "smart-manufacturing", "智能制造技能培训：ROS2 机器人开发与西门子 S7-1200 PLC 编程"
    )
    assert got == "智能制造技能培训：ROS2 机器人开发"
    # 病灶原样：断在「与」后面就是这个难看的样子
    assert not got.endswith("与西门子")
    assert got == got.strip()


def test_没超长就一个字不动() -> None:
    assert _scope_label("iotdb", "Apache IoTDB 时序数据库的使用与运维") == (
        "Apache IoTDB 时序数据库的使用与运维"
    )


def test_空格只兜底不抢真断点() -> None:
    # 中英混排里空格到处都是。它要是和连词平起平坐，就会盖过真正的断点——
    # 实测「…开发与西门子 」里空格在 23、「与」在 19，取最靠后又切出半句。
    assert _trim_at_word_boundary("智能制造技能培训：ROS2 机器人开发与西门子 S7", 24) == (
        "智能制造技能培训：ROS2 机器人开发"
    )
    # 一个真断点都没有时才轮到空格
    assert _trim_at_word_boundary("Kubernetes cluster operations and mesh guide", 24) == (
        "Kubernetes cluster"
    )


def test_一个断点都没有就退回硬切() -> None:
    long = "这是一个没有任何断句点的超长疆域描述文字堆在一起不给你机会断开"
    assert _trim_at_word_boundary(long, 24) == long[:24]


def test_断点太靠前就不用它() -> None:
    # 「智能制造」比「智能制造技能培训：ROS2 机器人开发」信息量少，宁可硬切。
    got = _trim_at_word_boundary("智能：这后面是一长串没有任何断点的描述文字堆在一起看不出边界", 24)
    assert len(got) > 12


@pytest.mark.parametrize("scope", ["", "   ", "\n"])
def test_疆域空着就回退库名不凭空起名(scope: str) -> None:
    # 「不凭空起名」是这个函数原本的纪律，改截断不许把它破坏掉。
    assert _scope_label("some-corpus", scope) == "some-corpus"
