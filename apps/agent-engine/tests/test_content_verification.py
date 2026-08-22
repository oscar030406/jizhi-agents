"""可执行验证课件（KR2）：三态判定与数值复核的行为锁。"""

from backend.services.content_verification import (
    verify_arithmetic,
    verify_content_api,
    verify_python_block,
)


class TestCodeVerdicts:
    def test_good_code_passes(self):
        assert verify_python_block("x = 1 + 1\nassert x == 2\nprint(x)").verdict == "passed"

    def test_broken_code_fails_with_detail(self):
        v = verify_python_block("x = [1, 2]\nprint(x[5])")
        assert v.verdict == "failed"
        assert "IndexError" in v.detail

    def test_missing_dependency_is_unverifiable_not_failed(self):
        v = verify_python_block("import surely_not_installed_pkg_42\n")
        assert v.verdict == "unverifiable"

    def test_infinite_loop_times_out_as_failed(self):
        v = verify_python_block("while True:\n    pass\n")
        assert v.verdict == "failed"
        assert "超时" in v.detail


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
        texts=["2 + 2 = 4", "3 × 3 = 8"],
    )
    assert out["code_passed"] == 1
    assert out["code_unverifiable"] == 1
    assert out["code_failed"] == 0
    assert out["arithmetic"]["checked"] == 2
    assert out["arithmetic"]["passed"] == 1
    assert len(out["arithmetic"]["failures"]) == 1
