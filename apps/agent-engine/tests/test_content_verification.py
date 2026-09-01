"""可执行验证课件（KR2）：三态判定与数值复核的行为锁。"""

from backend.services.content_verification import (
    verify_arithmetic,
    verify_content_api,
    verify_python_block,
)


class TestCodeVerdicts:
    def test_general_python_is_unverifiable_without_a_system_sandbox(self):
        snippets = [
            "x = 1 + 1\nassert x == 2",
            "x = [1, 2]\nprint(x[5])",
            "import surely_not_installed_pkg_42",
            "while True:\n    pass",
            "import numpy as np\nprint(np.array([1.0]))",
        ]
        for code in snippets:
            verdict = verify_python_block(code)
            assert verdict.verdict == "unverifiable"
            assert "系统级隔离" in verdict.detail
            assert "未执行" in verdict.detail

    def test_external_marker_is_never_created(self, tmp_path):
        marker = tmp_path / "must-not-exist.txt"
        verdict = verify_python_block(
            f"open({str(marker)!r}, 'w').write('executed')"
        )
        assert verdict.verdict == "unverifiable"
        assert "未执行" in verdict.detail
        assert not marker.exists()

    def test_private_socket_bypass_is_never_executed(self, tmp_path):
        marker = tmp_path / "must-not-exist-after-socket.txt"
        verdict = verify_python_block(
            "import _socket\n"
            "sock = _socket.socket()\n"
            f"open({str(marker)!r}, 'w').write('executed')"
        )
        assert verdict.verdict == "unverifiable"
        assert "未执行" in verdict.detail
        assert not marker.exists()


class TestArithmetic:
    def test_correct_chain_passes(self):
        r = verify_arithmetic("计算分母：2.7183 + 1 = 3.7183，权重 2.7183 / 3.7183 ≈ 0.731")
        assert r.checked == 2
        assert r.passed == 2

    def test_wrong_equation_flagged(self):
        r = verify_arithmetic("于是 (1 × 1) + (0 × 0) = 3")
        assert r.checked == 1
        assert r.passed == 0
        assert r.failures

    def test_percentage_arithmetic_passes_and_fails(self):
        r = verify_arithmetic("命中率 48 / 60 = 80%，折算 80% × 50 = 40；误例 25% × 200 = 40")
        assert r.checked == 3
        assert r.passed == 2
        assert len(r.failures) == 1

    def test_correct_softmax_worked_examples_pass(self):
        r = verify_arithmetic(
            "logits 为 [1.0, 0.0]，softmax 后约为 [0.73, 0.27]；"
            "softmax([2, 1, 0] / 0.5) ≈ [0.87, 0.12, 0.02]"
        )
        assert r.checked == 2
        assert r.passed == 2
        assert not r.failures

    def test_wrong_softmax_worked_example_is_flagged(self):
        r = verify_arithmetic(
            "若分数变为 [4.0, 0.4]，softmax 结果将趋近 [0.98, 0.02]"
        )
        assert r.checked == 1
        assert r.passed == 0
        assert len(r.failures) == 1
        assert "实算" in r.failures[0]

    def test_unsafe_softmax_expression_is_warning_not_pass(self):
        r = verify_arithmetic(
            "softmax([__import__('os').system('x'), 0]) = [0.5, 0.5]"
        )
        assert r.checked == 0
        assert r.passed == 0
        assert r.unverifiable == 1
        assert r.warnings

    def test_non_real_arithmetic_is_warning_not_exception(self):
        r = verify_arithmetic("(-1)^0.5 = 1")
        assert r.checked == 0
        assert r.passed == 0
        assert r.unverifiable == 1
        assert r.warnings

    def test_natural_language_not_misjudged(self):
        # 解析不了的自然语言与纯数字对（L2 = 2 这类）都必须跳过
        r = verify_arithmetic("难度 L2 对应 2 档；得分 0.40，信心 2/5；共 17 = 17 题")
        assert r.checked == 0

    def test_approx_tolerance_looser(self):
        assert verify_arithmetic("1 / 3 ≈ 0.33").passed == 1
        assert verify_arithmetic("sqrt(2) ≈ 1.41").passed == 1

    def test_radical_symbol_normalized(self):
        # 教学文本里 √ 比 sqrt 常见（实测生成内容）
        r = verify_arithmetic("点积标准差 √64 = 8，√(16) = 4")
        assert r.checked == 2
        assert r.passed == 2

    def test_variable_with_digit_suffix_skipped(self):
        # 「α1=2.718/(2.718+1)≈0.73」的 α1 是变量——数字尾巴不许当左值
        # （存量课实测：裸截出「1 = 0.731」假不等式）
        r = verify_arithmetic("e^0=1，所以 α1=2.718/(2.718+1)≈0.73。")
        assert not r.failures
        # e^0=1 仍应被验到且通过
        assert r.passed >= 1

    def test_no_eval_escape(self):
        # 白名单外的名字/调用一律不解析——不许被文本注入带偏
        r = verify_arithmetic("__import__('os').system('x') = 1")
        assert r.checked == 0


def test_api_aggregation():
    out = verify_content_api(
        code_blocks=["print(1+1)", "import surely_not_installed_pkg_42"],
        texts=[
            "2 + 2 = 4",
            "3 × 3 = 8",
            "softmax([unknown, 0]) = [0.5, 0.5]",
        ],
    )
    assert out["code_passed"] == 0
    assert out["code_unverifiable"] == 2
    assert out["code_failed"] == 0
    assert out["arithmetic"]["checked"] == 2
    assert out["arithmetic"]["passed"] == 1
    assert len(out["arithmetic"]["failures"]) == 1
    assert out["arithmetic"]["unverifiable"] == 1
    assert len(out["arithmetic"]["warnings"]) == 1
