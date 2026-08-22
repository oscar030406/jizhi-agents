"""可执行验证课件（KR2）——交付前机械验算生成内容里的代码与数值。

幻觉治理的第三层：文本 claim 审核（已有双判官）管「说得对不对」，
这里管「算得对不对、跑得起来跑不起来」：
- 代码块丢进隔离子进程真跑（10s 超时）。三态判定：passed / failed /
  unverifiable（缺第三方依赖不算生成错误，如实分开——把「装不了 torch」
  记成「代码错」是最坏的误报）。
- 正文/板书里的数值等式（「2.7183 + 1 = 3.7183」「(1×1)+(0×0)=1」）用
  AST 白名单安全求值复核，不用 eval。解析不了的式子跳过不计（宁可少验，
  不能误判自然语言）。

安全边界：代码来自我们自己的生成链（不是用户输入），威胁模型是「模型写错」
不是「恶意注入」，隔离子进程+超时与之相称；不做网络/文件系统封锁。
查新（2026-08-03，Exa）：现有产品只有「学习者自己跑代码」的 playground，
「系统交付前验算课件」没有先例——本服务是接地拼装的自然延伸。
"""

from __future__ import annotations

import ast
import math
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

CODE_TIMEOUT_SECONDS = 10

# ── 代码块验证 ──────────────────────────────────────────────────────────


@dataclass
class CodeVerdict:
    verdict: str  # passed | failed | unverifiable
    detail: str = ""


def verify_python_block(code: str) -> CodeVerdict:
    """隔离子进程跑一个 python 代码块。"""
    if not code.strip():
        return CodeVerdict("unverifiable", "空代码块")
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "snippet.py"
        script.write_text(code, encoding="utf-8")
        try:
            proc = subprocess.run(
                [sys.executable, "-I", str(script)],
                capture_output=True,
                text=True,
                timeout=CODE_TIMEOUT_SECONDS,
                cwd=tmp,
            )
        except subprocess.TimeoutExpired:
            return CodeVerdict("failed", f"超时（>{CODE_TIMEOUT_SECONDS}s），疑似死循环或阻塞")
    if proc.returncode == 0:
        return CodeVerdict("passed")
    stderr = (proc.stderr or "").strip().splitlines()
    last = stderr[-1] if stderr else "未知错误"
    # 缺第三方依赖：不是生成的错，是运行环境的边界——单列，不许算 failed
    if "ModuleNotFoundError" in last:
        return CodeVerdict("unverifiable", last)
    return CodeVerdict("failed", last[:200])


# ── 数值等式复核 ────────────────────────────────────────────────────────

# 允许的运算与函数：算术 + sqrt/exp/log + 常量 e/pi。白名单外一律拒解析。
_ALLOWED_FUNCS = {"sqrt": math.sqrt, "exp": math.exp, "log": math.log, "abs": abs}
_ALLOWED_NAMES = {"e": math.e, "pi": math.pi, "π": math.pi}

_ALLOWED_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.Constant,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Pow,
    ast.USub,
    ast.UAdd,
    ast.Call,
    ast.Name,
    ast.Load,
)


def _safe_eval(expr: str) -> float | None:
    """AST 白名单求值。解析不了/越权返回 None，绝不抛给调用方。"""
    normalized = (
        expr.replace("×", "*").replace("÷", "/").replace("−", "-").replace("^", "**").strip()
    )
    # √ 归一化：√(x)/√64 → sqrt(...)。教学文本里根号比 sqrt 写法更常见（实测）
    normalized = re.sub(r"√\s*\(", "sqrt(", normalized)
    normalized = re.sub(r"√\s*([0-9.]+)", r"sqrt(\1)", normalized)
    if not normalized or not re.search(r"\d", normalized):
        return None
    try:
        tree = ast.parse(normalized, mode="eval")
    except SyntaxError:
        return None
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            return None
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_FUNCS:
                return None
        if isinstance(node, ast.Name) and node.id not in _ALLOWED_FUNCS | _ALLOWED_NAMES.keys():
            return None
    try:
        value = eval(  # noqa: S307 — AST 白名单已过滤，只剩纯算术
            compile(tree, "<arith>", "eval"), {"__builtins__": {}}, {**_ALLOWED_FUNCS, **_ALLOWED_NAMES}
        )
    except (ValueError, ZeroDivisionError, OverflowError):
        return None
    return float(value) if isinstance(value, (int, float)) else None


# 候选等式：含数字的「左 = 右」或「左 ≈ 右」，两侧都不含中文才进入解析。
# 负后顾三类跳过（都以「误报不可接受」为纲，漏验可以接受）：
# ① 字母/下标：「α1=…」的 α1 是变量名，裸截数字尾巴会假阳性（存量课实测）；
# ② 导数撇号：「f'(5) = 2×5」剥掉 f' 后 (5)=2×5 必假阳性（梯度下降课实测）；
# ③ 运算符：「5 − 0.1×10 = 4」中段「0.1×10 = 4」是大表达式的断肢，单独求值
#    必假阳性；'=' 不在此列——链式等式「z = 2×3 = 6」的中段是真验算对象。
_EQUATION_RE = re.compile(
    r"(?<![A-Za-zα-ωΑ-Ω_₀-₉])([0-9eπ().\s+\-*/×÷^√sqrtexplog,\[\]]+?)\s*(=|≈)\s*([0-9eπ().\s+\-*/×÷^,\[\]]+)"
)

# 匹配后前缀守卫（正则后顾挡不住位移重匹配——「− 0.1×10」被挡后引擎会从
# 「.1×10」重试，实测绕过）：跳过左值前紧邻（略过空白后）是这些字符的候选——
# ASCII 字母数字/希腊字母/下标（变量名或被截断的数字尾巴）、导数撇号
# （f'(5)=2×5 剥掉 f' 必假阳性）、运算符含 U+2212（大表达式的断肢）。
# '='/'≈' 不在此列：链式等式「z = 2×3 = 6」的中段是真验算对象。
_BAD_PREV = set(
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'′+*/×÷^√-−"
)


def _fragment_of_larger_expression(text: str, start: int) -> bool:
    prev = text[:start].rstrip()[-1:]
    if not prev:
        return False
    return prev in _BAD_PREV or "Ͱ" <= prev <= "Ͽ" or "₀" <= prev <= "₉"


@dataclass
class ArithmeticReport:
    checked: int = 0
    passed: int = 0
    failures: list[str] = field(default_factory=list)


def verify_arithmetic(text: str) -> ArithmeticReport:
    """复核文本里可机械求值的数值等式。

    宽容度：`=` 相对误差 1%，`≈` 5%（教学文本四舍五入常见）。
    任一侧解析失败即跳过——把自然语言误判成算错是不可接受的误报。
    """
    report = ArithmeticReport()
    for m in _EQUATION_RE.finditer(text):
        lhs_raw, op, rhs_raw = m.group(1), m.group(2), m.group(3)
        # 向量/列表形态（[5, 2]）不是标量等式，跳过
        if "[" in lhs_raw or "[" in rhs_raw:
            continue
        # 断肢守卫：左值其实是更大表达式/变量名的尾巴，单独求值必假阳性
        if _fragment_of_larger_expression(text, m.start(1)):
            continue
        lhs, rhs = _safe_eval(lhs_raw), _safe_eval(rhs_raw)
        if lhs is None or rhs is None:
            continue
        # 纯数字 = 纯数字（如「难度 L2 = 2」误匹配）没有验算意义，要求至少一侧带运算
        if not re.search(r"[+\-*/×÷^√]|sqrt|exp|log", lhs_raw + rhs_raw):
            continue
        report.checked += 1
        tol = 0.01 if op == "=" else 0.05
        denom = max(abs(rhs), 1e-9)
        if abs(lhs - rhs) / denom <= tol:
            report.passed += 1
        else:
            report.failures.append(f"{lhs_raw.strip()} {op} {rhs_raw.strip()}（实算 {lhs:.4g}）")
    return report


# ── 教学记法归一 ────────────────────────────────────────────────────────
# 从评测脚本（scripts/compute_verification_interception.py）移入的单一真源，
# 评测链与产品桥共用。上标数字→^n、全角运算符→半角；下标一律替换为字母 x
# （α₁→αx：变成不可解析 token 自动跳过）。第一版直接删下标酿过误报——
# 「α₁ = 2.718/(2.718+1)」删成「α1 = …」后 α 被正则丢弃、裸 1 当了左值，
# 真值 0.731 被判算错。下标是变量标签，绝不能变成数字。

_SUBSCRIPT = str.maketrans("₀₁₂₃₄₅₆₇₈₉ₖₙᵢⱼ", "xxxxxxxxxxxxxx")
_SUPERSCRIPT = {"⁰": "^0", "¹": "^1", "²": "^2", "³": "^3", "⁴": "^4",
                "⁵": "^5", "⁶": "^6", "⁷": "^7", "⁸": "^8", "⁹": "^9"}
_FULLWIDTH = str.maketrans("＝＋－×（）．", "=+-*().")

_UNIT = re.compile(r"(\d(?:[\d.]*\d)?)\s*(万亿|亿|万|[KMGT])B?(?![A-Za-z])")
_UNIT_MULT = {"万": "1e4", "亿": "1e8", "万亿": "1e12",
              "K": "1e3", "M": "1e6", "G": "1e9", "T": "1e12"}


def normalize_notation(s: str) -> str:
    for k, v in _SUPERSCRIPT.items():
        s = s.replace(k, v)
    s = s.translate(_SUBSCRIPT).translate(_FULLWIDTH)
    # 数量级单位展开成乘法（32M→(32*1e6)），否则「≈ 500MB」剥掉单位后拿裸数
    # 对比必然假失败。M 按十进制 1e6 算，与二进制 2^20 差 4.9%，在 ≈ 的 5% 容差内。
    return _UNIT.sub(lambda m: f"({m.group(1)}*{_UNIT_MULT[m.group(2)]})", s)


# ── 汇总入口（给桥端点用）───────────────────────────────────────────────


def verify_content_api(code_blocks: list[str], texts: list[str]) -> dict:
    code_results = []
    for v in (verify_python_block(c) for c in code_blocks):
        verdict, detail = v.verdict, v.detail
        # 教学片段引用未定义符号（for epoch in range(epochs) 这种示意代码）
        # 是「缺上下文不可验」，不是「代码算错」——KR2 原则：解析不了跳过，
        # 绝不误判。与缺依赖同一类。评测链同口径（compute_verification_interception）。
        if verdict == "failed" and detail.startswith("NameError"):
            verdict = "unverifiable"
        code_results.append({"verdict": verdict, "detail": detail})
    arith = ArithmeticReport()
    for t in texts:
        r = verify_arithmetic(normalize_notation(t))
        arith.checked += r.checked
        arith.passed += r.passed
        arith.failures.extend(r.failures)
    return {
        "code": code_results,
        "code_passed": sum(1 for r in code_results if r["verdict"] == "passed"),
        "code_failed": sum(1 for r in code_results if r["verdict"] == "failed"),
        "code_unverifiable": sum(1 for r in code_results if r["verdict"] == "unverifiable"),
        "arithmetic": {
            "checked": arith.checked,
            "passed": arith.passed,
            "failures": arith.failures[:10],
        },
    }
