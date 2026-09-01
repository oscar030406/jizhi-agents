"""课件内容机械验算（KR2）——交付前复核生成内容里的数值。

幻觉治理的第三层：文本 claim 审核（已有双判官）管「说得对不对」，
这里管「能否在不执行不可信代码的前提下机械复核」：
- 当前未接入系统级隔离沙箱，所有一般 Python 代码块均标记为 unverifiable，
  绝不在服务进程或子进程中执行。
- 正文/板书里的数值等式（「2.7183 + 1 = 3.7183」「(1×1)+(0×0)=1」）用
  AST 白名单解释器复核，不用 eval/compile；softmax 微例也只用确定性数学函数计算。

安全边界：模型生成代码按不可信输入处理。没有非 root、禁网、只读文件系统和
系统调用限制等外部隔离时，本模块不提供 Python 执行能力，也不声称具备沙箱。
查新（2026-08-03，Exa）：现有产品只有「学习者自己跑代码」的 playground，
「系统交付前验算课件」没有先例——本服务是接地拼装的自然延伸。
"""

from __future__ import annotations

import ast
import math
import operator
import re
from dataclasses import dataclass, field

# ── 代码块验证 ──────────────────────────────────────────────────────────


@dataclass
class CodeVerdict:
    verdict: str  # passed | failed | unverifiable
    detail: str = ""


def verify_python_block(code: str) -> CodeVerdict:
    """一般 Python 必须进入外部系统级沙箱；当前只报告未验证，绝不执行。"""
    if not code.strip():
        return CodeVerdict("unverifiable", "空代码块")
    return CodeVerdict(
        "unverifiable",
        "未配置系统级隔离执行环境；一般 Python 代码未执行",
    )


# ── 数值等式复核 ────────────────────────────────────────────────────────

# 允许的运算与函数：算术 + sqrt/exp/log + 常量 e/pi。白名单外一律拒解析。
_ALLOWED_FUNCS = {"sqrt": math.sqrt, "exp": math.exp, "log": math.log, "abs": abs}
_ALLOWED_NAMES = {"e": math.e, "pi": math.pi, "π": math.pi}
_BINARY_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_MAX_AST_NODES = 64
_MAX_AST_DEPTH = 16


def _eval_node(node: ast.AST, depth: int = 0) -> float | None:
    """递归解释纯数值 AST；不 compile、不 eval，也不访问对象属性。"""
    if depth > _MAX_AST_DEPTH:
        return None
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            return None
        value = float(node.value)
    elif isinstance(node, ast.Name):
        value = _ALLOWED_NAMES.get(node.id)
        if value is None:
            return None
    elif isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        operand = _eval_node(node.operand, depth + 1)
        if operand is None:
            return None
        value = _UNARY_OPS[type(node.op)](operand)
    elif isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPS:
        left = _eval_node(node.left, depth + 1)
        right = _eval_node(node.right, depth + 1)
        if left is None or right is None:
            return None
        # 防止极大幂在进入 float 有限性检查前耗尽 CPU/内存。
        if isinstance(node.op, ast.Pow) and (abs(right) > 100 or abs(left) > 1e100):
            return None
        try:
            value = _BINARY_OPS[type(node.op)](left, right)
        except (ValueError, ZeroDivisionError, OverflowError):
            return None
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        func = _ALLOWED_FUNCS.get(node.func.id)
        if func is None or node.keywords or not (1 <= len(node.args) <= 2):
            return None
        args = [_eval_node(arg, depth + 1) for arg in node.args]
        if any(arg is None for arg in args):
            return None
        try:
            value = func(*args)  # type: ignore[arg-type]
        except (TypeError, ValueError, ZeroDivisionError, OverflowError):
            return None
    else:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _safe_eval(expr: str) -> float | None:
    """AST 白名单解释。解析不了/越权返回 None，绝不执行任意代码。"""
    normalized = (
        expr.replace("×", "*")
        .replace("÷", "/")
        .replace("−", "-")
        .replace("^", "**")
        .strip()
    )
    # 后缀百分号是除以 100；不支持 Python 取模，避免把自然语言百分比误读为模运算。
    normalized = re.sub(
        r"(?<![A-Za-z0-9_.])((?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?)\s*[%％]",
        r"(\1/100)",
        normalized,
        flags=re.I,
    )
    # √ 归一化：√(x)/√64 → sqrt(...)。教学文本里根号比 sqrt 写法更常见（实测）
    normalized = re.sub(r"√\s*\(", "sqrt(", normalized)
    normalized = re.sub(r"√\s*([0-9.]+)", r"sqrt(\1)", normalized)
    if not normalized or len(normalized) > 256 or not re.search(r"\d", normalized):
        return None
    try:
        tree = ast.parse(normalized, mode="eval")
    except SyntaxError:
        return None
    if sum(1 for _ in ast.walk(tree)) > _MAX_AST_NODES:
        return None
    return _eval_node(tree.body)


# 候选等式：含数字的「左 = 右」或「左 ≈ 右」，两侧都不含中文才进入解析。
# 负后顾三类跳过（都以「误报不可接受」为纲，漏验可以接受）：
# ① 字母/下标：「α1=…」的 α1 是变量名，裸截数字尾巴会假阳性（存量课实测）；
# ② 导数撇号：「f'(5) = 2×5」剥掉 f' 后 (5)=2×5 必假阳性（梯度下降课实测）；
# ③ 运算符：「5 − 0.1×10 = 4」中段「0.1×10 = 4」是大表达式的断肢，单独求值
#    必假阳性；'=' 不在此列——链式等式「z = 2×3 = 6」的中段是真验算对象。
_EQUATION_RE = re.compile(
    r"(?<![A-Za-zα-ωΑ-Ω_₀-₉])"
    r"([0-9eπ().\s+\-*/×÷^√%％sqrtexplog,]+?)\s*(=|≈)\s*"
    r"([0-9eπ().\s+\-*/×÷^√%％sqrtexplog,]+)"
)

_DIRECT_SOFTMAX_RE = re.compile(
    r"softmax\s*\(\s*(?P<input>\[[^\]\n]{1,512}\])"
    r"(?P<scale>\s*/\s*[^)\n]{1,64})?\s*\)\s*"
    r"(?P<connector>=|≈|约(?:为)?|大约(?:为)?|近似(?:为)?|结果(?:为)?)\s*"
    r"(?P<output>\[[^\]\n]{1,512}\])",
    re.I,
)
_PROSE_SOFTMAX_RE = re.compile(
    r"(?P<input>\[[^\]\n]{1,512}\])"
    r"(?P<context>[^。\n\[]{0,160}?"
    r"(?:softmax\s*(?:后|结果|得到|输出|概率)|概率(?:分布)?|归一化(?:后)?(?:权重)?|权重)"
    r"[^。\n\[]{0,100}?)"
    r"(?P<output>\[[^\]\n]{1,512}\])",
    re.I,
)
_TEMPERATURE_RE = re.compile(
    r"(?:\bT\b|temperature|温度)\s*(?:=|为)\s*"
    r"((?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?)",
    re.I,
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
    unverifiable: int = 0
    warnings: list[str] = field(default_factory=list)


def _parse_numeric_vector(raw: str) -> tuple[list[float], list[str]] | None:
    """解析纯数值向量；元素仍复用同一 AST 白名单解释器。"""
    if not raw.startswith("[") or not raw.endswith("]"):
        return None
    parts = [part.strip() for part in re.split(r"[,，]", raw[1:-1])]
    if not (2 <= len(parts) <= 128) or any(not part for part in parts):
        return None
    values = [_safe_eval(part) for part in parts]
    if any(value is None for value in values):
        return None
    return [float(value) for value in values if value is not None], parts


def _softmax(logits: list[float], temperature: float) -> list[float] | None:
    if temperature <= 0:
        return None
    try:
        scaled = [value / temperature for value in logits]
    except OverflowError:
        return None
    if any(not math.isfinite(value) for value in scaled):
        return None
    peak = max(scaled)
    weights = [math.exp(value - peak) for value in scaled]
    total = sum(weights)
    if not total or not math.isfinite(total):
        return None
    return [value / total for value in weights]


def _rounding_tolerance(token: str) -> float:
    """由展示精度推导四舍五入误差；两位小数即半个 0.01。"""
    raw = token.strip().replace("％", "%")
    percent = raw.endswith("%")
    if percent:
        raw = raw[:-1].strip()
    match = re.fullmatch(r"[+\-]?(\d+)(?:\.(\d*))?(?:e([+\-]?\d+))?", raw, re.I)
    if not match:
        return 1e-9
    decimals = len(match.group(2) or "")
    exponent = int(match.group(3) or 0)
    if decimals == 0 and exponent == 0 and not percent:
        return 1e-9
    quantum = 10.0 ** (exponent - decimals)
    if percent:
        quantum /= 100.0
    return abs(quantum) / 2 + 1e-12


def _record_softmax_example(
    report: ArithmeticReport,
    input_raw: str,
    output_raw: str,
    label: str,
    temperature: float,
) -> None:
    parsed_input = _parse_numeric_vector(input_raw)
    parsed_output = _parse_numeric_vector(output_raw)
    if parsed_input is None or parsed_output is None:
        report.unverifiable += 1
        report.warnings.append(f"{label}：含非白名单或不可解析的向量表达式，未判为通过")
        return
    logits, _ = parsed_input
    claimed, claimed_tokens = parsed_output
    if temperature <= 0:
        report.checked += 1
        report.failures.append(f"{label}：softmax 温度必须大于 0")
        return
    expected = _softmax(logits, temperature)
    if expected is None:
        report.unverifiable += 1
        report.warnings.append(f"{label}：数值超出安全计算范围，未判为通过")
        return
    report.checked += 1
    expected_text = ", ".join(f"{value:.4g}" for value in expected)
    if len(expected) != len(claimed):
        report.failures.append(
            f"{label}：概率向量维度不匹配（实算 [{expected_text}]）"
        )
        return
    if all(
        abs(actual - wanted) <= _rounding_tolerance(token)
        for actual, wanted, token in zip(claimed, expected, claimed_tokens, strict=True)
    ):
        report.passed += 1
        return
    report.failures.append(f"{label}（实算 [{expected_text}]）")


def _verify_softmax_examples(text: str, report: ArithmeticReport) -> None:
    """验证显式 softmax 调用和自然语言中的 logits→概率 worked example。"""
    direct_spans: list[tuple[int, int]] = []
    for match in _DIRECT_SOFTMAX_RE.finditer(text):
        direct_spans.append(match.span())
        scale = match.group("scale")
        temperature = _safe_eval(scale.lstrip().removeprefix("/").strip()) if scale else 1.0
        if temperature is None:
            report.unverifiable += 1
            report.warnings.append("softmax 温度含非白名单或不可解析表达式，未判为通过")
            continue
        label = f"softmax({match.group('input')}{scale or ''}) {match.group('connector')} {match.group('output')}"
        _record_softmax_example(
            report,
            match.group("input"),
            match.group("output"),
            label,
            temperature,
        )

    for match in _PROSE_SOFTMAX_RE.finditer(text):
        if any(start <= match.start() < end for start, end in direct_spans):
            continue
        context = match.group("context")
        temp_match = _TEMPERATURE_RE.search(context)
        temperature = _safe_eval(temp_match.group(1)) if temp_match else 1.0
        if temperature is None:
            report.unverifiable += 1
            report.warnings.append("softmax 温度超出安全计算范围，未判为通过")
            continue
        label = f"{match.group('input')} … {context.strip()} {match.group('output')}"
        _record_softmax_example(
            report,
            match.group("input"),
            match.group("output"),
            label,
            temperature,
        )


def verify_arithmetic(text: str) -> ArithmeticReport:
    """复核文本里可机械求值的标量等式与 softmax 数值微例。

    宽容度：`=` 相对误差 1%，`≈` 5%（教学文本四舍五入常见）。
    已识别但无法安全解析的表达式只记 warning，不得判为通过。
    """
    report = ArithmeticReport()
    _verify_softmax_examples(text, report)
    for m in _EQUATION_RE.finditer(text):
        lhs_raw, op, rhs_raw = m.group(1), m.group(2), m.group(3)
        if not re.search(r"\d", lhs_raw) or not re.search(r"\d", rhs_raw):
            continue
        # 断肢守卫：左值其实是更大表达式/变量名的尾巴，单独求值必假阳性
        if _fragment_of_larger_expression(text, m.start(1)):
            continue
        lhs, rhs = _safe_eval(lhs_raw), _safe_eval(rhs_raw)
        if lhs is None or rhs is None:
            report.unverifiable += 1
            report.warnings.append(
                f"{lhs_raw.strip()} {op} {rhs_raw.strip()}：不可安全解析，未判为通过"
            )
            continue
        # 纯数字 = 纯数字（如「难度 L2 = 2」误匹配）没有验算意义，要求至少一侧带运算
        if not re.search(r"[+\-*/×÷^√%％]|sqrt|exp|log", lhs_raw + rhs_raw):
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
_FULLWIDTH = str.maketrans("＝＋－×（）．％，", "=+-*().%,")

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
        arith.unverifiable += r.unverifiable
        arith.warnings.extend(r.warnings)
    return {
        "code": code_results,
        "code_passed": sum(1 for r in code_results if r["verdict"] == "passed"),
        "code_failed": sum(1 for r in code_results if r["verdict"] == "failed"),
        "code_unverifiable": sum(1 for r in code_results if r["verdict"] == "unverifiable"),
        "arithmetic": {
            "checked": arith.checked,
            "passed": arith.passed,
            "failures": arith.failures[:10],
            "unverifiable": arith.unverifiable,
            "warnings": arith.warnings[:10],
        },
    }
