"""入门段代码形态闸 + 自述抽取的两个真事故。

判据不是我们拍的：《Python 编程：从入门到实践》（蟒蛇书）配套源码实测——
1-6 章 129 个文件里 import / def / class 出现率**都是 0%**，行数中位 4、≤5 行占 65%；
全书 563 个文件才是 import 57% / def 31% / class 25%。
所以「入门能读的代码」的分界是**结构**，不只是长度。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.integration.personalize_service import has_beyond_beginner_code  # noqa: E402
from backend.services.profile_intake import extract_profile_seed  # noqa: E402


class TestBeginnerCodeForm:
    def test_plain_statements_pass(self):
        """蟒蛇书 1-6 章的真实形态：没有 import/def/class 的直白语句。"""
        assert not has_beyond_beginner_code('print("Hello Python world!")')
        assert not has_beyond_beginner_code(
            'message = "One of Python\'s strengths is its diverse community."\nprint(message)'
        )
        assert not has_beyond_beginner_code("cars = ['bmw', 'audi']\nfor car in cars:\n    print(car)")

    def test_import_def_class_rejected(self):
        assert has_beyond_beginner_code("import numpy as np\nx = np.array([1, 2])")
        assert has_beyond_beginner_code("from typing import List\n")
        assert has_beyond_beginner_code("def query(question, k=3):\n    return None")
        assert has_beyond_beginner_code("class Dog:\n    pass")
        assert has_beyond_beginner_code("@dataclass\nclass X: ...")

    def test_the_real_excerpt_that_broke_it(self):
        """2026-08-13 实测：零基础学员拿到的就是这一段，行数没超上限、形态整段超纲。"""
        excerpt = (
            "def query(self, question, k=3):\n"
            "    query_vector = get_embedding(question)\n"
            "    sims = np.array([...])\n"
            "    return sims.argsort()[::-1][:k].tolist()\n"
        )
        assert has_beyond_beginner_code(excerpt)

    def test_prose_mentioning_the_words_is_not_code(self):
        """散文里提到「导入」「定义」不该被误判——闸只认行首的结构关键字。"""
        assert not has_beyond_beginner_code("我们把这个过程叫做 import，意思是把别人写好的工具拿过来用。")


class TestProfileIntakeAccidents:
    def test_substring_false_positive_is_fixed(self):
        """「向量数据库」里的「数据库」曾命中后端 3 档，把零基础抬成后端工程师。"""
        seed = extract_profile_seed("我完全不懂技术，也没写过代码，想搞明白向量数据库")
        assert seed.levels.get("programming") == 0, seed.levels
        assert seed.background_hint != "后端工程", seed.background_hint

    def test_assertive_zero_locks_the_dimension(self):
        """一句明确的「我不会」不该被后面偶然提到的名词压过。"""
        seed = extract_profile_seed("我没写过代码，只是听说过后端和数据库这些词")
        assert seed.levels.get("programming") == 0, seed.levels

    def test_real_backend_still_detected(self):
        """修完不能把真后端也压成 0——只有明确否定式才锁定。"""
        seed = extract_profile_seed("我做了三年后端，用 java 写过服务端接口")
        assert seed.levels.get("programming", 0) >= 3, seed.levels

    def test_suppressed_hits_still_recorded_as_evidence(self):
        """被压掉的命中要留痕，否则没人看得出规则跑过。"""
        seed = extract_profile_seed("我没写过代码，想搞明白向量数据库")
        dims = [e.dimension for e in seed.evidence]
        assert "programming" in dims
        assert any(e.level == 0 for e in seed.evidence)

    def test_unmatched_when_nothing_hits(self):
        seed = extract_profile_seed("讲讲这个东西")
        assert seed.unmatched is True
        assert seed.levels == {}
