# -*- coding: utf-8 -*-
"""策展课程库生产流水线（市场调研 §六 决策落地）。

人写脚手架 + LLM 即兴 + 双重门禁：
    课程大纲（本文件人工策展）→ 每课时定向检索 hello-agents chunks
    → strong 模型生成 grounded 课时（正文逐段带 [source_id] 引用标记）
    → 引用门禁（确定性：标记必须来自本课时检索集，且每小节 ≥1）
    → judge 模型逐小节复核（是否被所引证据支持）
    → 落盘 data/curriculum/<concept>.json + catalog.json

用法（引擎目录下）：
    $env:AGENT_GENERATION_MODE="api"; python scripts\\build_curriculum.py --concept rag
    python scripts\\build_curriculum.py --catalog-only   # 只重建目录（无需网络）

课程 JSON 是入库的静态资产：生成一次、可审计、可复算指认（答辩口径：
「平台上的每一课都经过检索约束生成 + 引用门禁 + 独立 judge 复核」）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import os
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.rag.retriever import get_retriever  # noqa: E402
from backend.schemas.curriculum import (  # noqa: E402
    Capstone,
    Catalog,
    CatalogConcept,
    Chapter,
    CheckQuestion,
    Course,
    GeneratedBy,
    GradedExercise,
    HandsOn,
    InteractiveEmbed,
    KeyTerm,
    Lesson,
    LessonAudit,
    Section,
    TextbookEntry,
    VideoIntro,
)
from backend.services.goal_concepts import KEYWORD_CONCEPTS  # noqa: E402
from backend.services.llm_gateway import LLMGateway  # noqa: E402
from backend.services import course_studio as studio  # noqa: E402  # 无任务在跑时全部 no-op

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "curriculum"
CONCEPT_GRAPH = ROOT / "data" / "knowledge_base" / "concept_graph.json"

CITATION_RE = re.compile(r"\[([a-z]{2}\d{2}s\d{2}#s\d+)\]")  # ha=hello-agents, hl=happy-llm, ag=agentguide

# 课程生成器模型：受控策展改写是「按给定资料重写」任务，不需要推理模型——
# 实测 DeepSeek-V4-Flash（推理型）思考 token 不可控且 ~17 tok/s 必超时；
# Qwen3-Instruct 非推理 ~50 tok/s。judge 复核仍走 GLM（异构交叉验证不变）。
GENERATOR_MODEL_ENV = "CURRICULUM_GENERATOR_MODEL"
DEFAULT_GENERATOR_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507"


def _build_gateway() -> LLMGateway:
    env = dict(os.environ)
    env["LLM_MODEL_STRONG"] = env.get(GENERATOR_MODEL_ENV, DEFAULT_GENERATOR_MODEL)
    return LLMGateway(env=env)


# B 站官方账号白名单（调研 §五 一手核验；新增账号必须先验 uid 归属再入列）
VIDEO_ACCOUNT_WHITELIST = [
    {"account": "跟李沐学AI", "uid": "1567748478", "note": "论文精读系列，作者本人官方号"},
    {"account": "deeplearning_ai", "uid": "1065788740", "note": "吴恩达官方号（约 2022 后未更新）"},
    {"account": "3Blue1Brown", "uid": "88461692", "note": "官方双语号（B站 API 验证 2026-07），神经网络/数学可视化"},
]

# 教材登记制：把授权做成数据结构（站底与课程页展示）。
# license_basis 为「高校教学授权」的条目=项目方口径（团队持有出版社/作者教学使用许可），
# 该类教材只做深度骨架/出题参照（ingested=False），正文语料一律来自开源许可条目。
TEXTBOOK_REGISTRY = [
    {"title": "Hello-Agents（Datawhale）", "author": "Datawhale 社区", "source": "github.com/datawhalechina/hello-agents",
     "license_basis": "CC BY-NC-SA 4.0", "usage": "正文语料（逐句引用）", "ingested": True},
    {"title": "Happy-LLM（Datawhale）", "author": "Datawhale 社区", "source": "github.com/datawhalechina/happy-llm",
     "license_basis": "CC BY-NC-SA 4.0", "usage": "正文语料（逐句引用）", "ingested": True},
    {"title": "动手学深度学习（第二版）", "author": "阿斯顿·张、李沐 等", "source": "github.com/d2l-ai/d2l-zh",
     "license_basis": "开源（Apache-2.0 仓库）", "usage": "正文语料（待入库）", "ingested": False},
    {"title": "从零构建大模型", "author": "Sebastian Raschka", "source": "人民邮电出版社",
     "license_basis": "高校教学授权", "usage": "深度骨架参照", "ingested": False},
    {"title": "图解大模型：生成式AI原理与实战", "author": "Jay Alammar 等", "source": "人民邮电出版社",
     "license_basis": "高校教学授权", "usage": "图解叙事参照", "ingested": False},
    {"title": "高等数学（上/下）", "author": "南京邮电大学", "source": "校用教材",
     "license_basis": "高校教学授权", "usage": "课内轨正文语料（OCR 后入库）", "ingested": False},
    {"title": "Python编程：从入门到实践（第3版）", "author": "Eric Matthes", "source": "人民邮电出版社",
     "license_basis": "高校教学授权", "usage": "课内轨正文语料（待入库）", "ingested": False},
    {"title": "LLMs 大模型面试问题和答案（97 问）", "author": "社区整理", "source": "公开流传面试题集",
     "license_basis": "高校教学授权", "usage": "结业理论卷出题参照（求职级口径）", "ingested": True},
    {"title": "大模型方向期末试卷五套（推理部署/Agent+RAG/微调RLHF/训练分布式/多模态）", "author": "课程组命题",
     "source": "用户供卷（挑战杯/题库，扫描 68 页含逐题解析）",
     "license_basis": "高校教学授权", "usage": "理论卷三大题范式锚点 + 数值解答题出题参照", "ingested": True},
    {"title": "200+ 即插即用深度学习模块集（论文 PDF+第三方代码）", "author": "多来源汇编",
     "source": r"D:\UserData\Desktop\200+即插即用模块代码（注意力/卷积/特征融合/mamba/时序等分类）",
     "license_basis": "许可不明（论文+第三方仓打包）", "usage": "第二领域 L3 实操项目出题参照（如复现 CBAM 插入 LeNet）；不吸入知识库正文", "ingested": False},
    # 权威延伸书目（2026-07-25 入库）：在售版权书一律只做书目背书与人工策展参照，
    # 不切片入 KB——提交包里的知识库切片必须全部来自开源协议语料。
    {"title": "Prompt Engineering for LLMs", "author": "John Berryman, Albert Ziegler（O'Reilly）",
     "source": "O'Reilly Media（ISBN 978-1-098-15615-2）",
     "license_basis": "在售版权书", "usage": "提示工程课程的权威骨架参照；正文语料另采开源 Prompt-Engineering-Guide", "ingested": False},
    {"title": "Hands-On RAG for Production", "author": "Ofer Mendelevitch, Forrest Sheng Bao（O'Reilly）",
     "source": "O'Reilly Media", "license_basis": "在售版权书",
     "usage": "RAG 课深化的权威参照（生产化视角）；不吸入知识库正文", "ingested": False},
    {"title": "AI Systems Performance Engineering", "author": "Chris Fregly（O'Reilly）",
     "source": "O'Reilly Media", "license_basis": "在售版权书",
     "usage": "进阶延伸书目（GPU/训练推理性能）；超出入门课程定位，仅书目推荐", "ingested": False},
    {"title": "Prompt Engineering Guide（DAIR.AI）", "author": "DAIR.AI 社区（Elvis Saravia 等）",
     "source": "github.com/dair-ai/Prompt-Engineering-Guide",
     "license_basis": "MIT（含官方中文版）",
     "usage": "提示工程课程正文语料（2026-08-10 入库：中文版 10 篇 32 chunks，pg01–pg10）", "ingested": True},
    {"title": "LLM-Deploy（Datawhale）", "author": "Datawhale 社区", "source": "github.com/datawhalechina/llm-deploy",
     "license_basis": "CC BY-NC-SA 4.0（README LICENSE 节声明，仓库无 LICENSE 文件）",
     "usage": "推理部署与模型压缩正文语料，给入门主题补 L3 档摘录（2026-08-10 入库：量化/蒸馏/剪枝/内存 15 篇 92 chunks，ld01–ld10）",
     "ingested": True},
    {"title": "Tiny-Universe（Datawhale）", "author": "Datawhale 社区", "source": "github.com/datawhalechina/tiny-universe",
     "license_basis": "CC BY-NC-SA 4.0（README LICENSE 节声明，仓库无 LICENSE 文件）",
     "usage": "RAG 整链白盒实现正文语料：TinyRAG 五模块与 TinyGraphRAG 图检索（2026-08-11 入库：11 篇 41 chunks，tu01–tu11）",
     "ingested": True},
    {"title": "Self-LLM（Datawhale）", "author": "Datawhale 社区", "source": "github.com/datawhalechina/self-llm",
     "license_basis": "Apache-2.0（仓库 LICENSE 文件）",
     "usage": "MoE 架构解析与端侧部署正文语料，人工策展 9 篇（仓库 280+ 篇部署实操全量入库会拉塌部署主题 IDF，故只收架构解析 Blog 与三条端侧实操线）"
              "（2026-08-11 入库：9 篇 42 chunks，sl01–sl09）",
     "ingested": True},
]

# ---------------------------------------------------------------- 学期课大纲（v2：重编排全覆盖）
# 每节 45min；source_range=有序源文块（全文喂入，顺序覆盖不检索采样）；parts=生成篇数。
# focus 策展纪律（2026-07-24 血泪）：①资料没写的名词在 focus 里一个不许出现——
#   连「X 只点名不展开」都是埋雷，生成器会照着点名然后被判官毙；②数字（步数/参数量/
#   版本演进）要么照抄资料原句进 focus，要么显式禁止提及，不许留给生成器发挥；
#   ③禁令要禁到句式级（不许「远超/更长/演进趋势/完全开源」式引申）。
SEMESTER_OUTLINES: dict[str, dict] = {
    "llm_basics": {
        "tagline": "一学期学透大模型：从 NLP 基础到亲手搭一个 Transformer",
        "textbooks": ["Happy-LLM（Datawhale）", "Hello-Agents（Datawhale）", "从零构建大模型", "图解大模型：生成式AI原理与实战", "LLMs 大模型面试问题和答案（97 问）"],
        "theory_exam_n": 20,
        "chapters": [
            {
                "chapter_id": "ch1",
                "title": "第一章 NLP 与语言模型基础",
                "intro": "从「计算机怎么理解语言」这个最朴素的问题出发，走到语言模型的门口。",
                "lessons": [
                    {
                        "lesson_id": "llm1-01",
                        "title": "初识 NLP：任务版图与发展脉络",
                        "source_range": ["hl01s01#s1", "hl01s02#s1", "hl01s02#s2",
                                         "hl01s03#s1", "hl01s03#s2", "hl01s03#s3", "hl01s03#s4",
                                         "hl01s03#s5", "hl01s03#s6", "hl01s03#s7", "hl01s03#s8"],
                        "focus": "NLP 是什么、发展脉络、核心任务逐一讲透（每个任务：定义+例子+资料提到的难点）。"
                                 "让完全没接触过的大一学生建立领域地图感。"
                                 "发展历程严格按资料三段概述——每阶段只写资料明确提到的事实，"
                                 "不要自行补充各阶段方法的机制细节或优劣对比；"
                                 "子词切分只讲『拆成频繁片段』的思想并注明第三章详解，"
                                 "不要编写 BPE 合并步骤的手算示例（资料没有）；"
                                 "手算示例用分词或词性标注这类资料明确描述过的任务。",
                        "exercise": {
                            "function_name": "top_word",
                            "hint": "实现 top_word(words)：返回字符串列表中出现次数最多的词"
                                    "（并列取字典序最小；空列表返回空串）。这是最朴素的文本统计——一切 NLP 的起点。",
                        },
                    },
                    {
                        "lesson_id": "llm1-02",
                        "title": "文本表示（上）：One-Hot 与向量空间模型",
                        "source_range": ["hl01s04#s1", "hl01s04#s2"],
                        "focus": "文本表示要解决什么问题；向量空间模型的构造（维度=特征项、元素=权重）。"
                                 "重头戏=资料自带的『雍和宫的荷花很美』16384 维稀疏向量例子：把稀疏率 99.97% "
                                 "的计算一步步带学生手算，讲透数据稀疏与维数灾难。"
                                 "权重计算严格按资料口径：只说『通过 TF、TF-IDF 等公式确定、反映重要程度』，"
                                 "不要展开 TF-IDF 的定义、公式或计算示例（资料没给，注明『信息检索课程详解』）。"
                                 "独立性假设忽略词序和上下文=模型的局限（按资料表述）。",
                        "exercise": {
                            "function_name": "one_hot",
                            "hint": "实现 one_hot(vocab, word)：vocab 是词表列表，返回该词的 One-Hot 向量"
                                    "（列表，词不在表中返回全 0）。",
                        },
                    },
                    {
                        "lesson_id": "llm1-03",
                        "title": "语言模型与 N-gram：下一个词的概率游戏",
                        "source_range": ["hl01s04#s3", "ha03s01#s2", "ha03s01#s5"],
                        "focus": "语言模型的本质=给词序列算概率；N-gram 的马尔可夫简化与最大似然计数（手算完整例子）；"
                                 "数据稀疏与平滑的边界（按资料表述）。破掉『大模型=检索答案的数据库』误区；"
                                 "神经方法只提『后续展开』。",
                        "exercise": {
                            "function_name": "predict_next",
                            "hint": "实现 predict_next(words, prev)：统计词列表中紧跟 prev 后出现次数最多的词"
                                    "（并列取字典序最小；未出现返回空串）——最小可用的 bigram 语言模型。",
                        },
                    },
                    {
                        "lesson_id": "llm1-04",
                        "title": "文本表示（下）：词嵌入与语义的几何学",
                        "source_range": ["ha03s01#s6", "hl01s04#s4", "hl01s04#s5"],
                        "focus": "重心=词嵌入的语义几何（资料对此最厚）：向量距离=语义远近、"
                                 "King-Man+Woman≈Queen 手算余弦示例、稠密向量对稀疏表示的改进。"
                                 "Word2Vec 两种架构严格只按资料的两句话讲（CBOW 由上下文词向量计算目标词向量、"
                                 "Skip-Gram 反之；CBOW 适合小数据集、Skip-Gram 大语料更好），"
                                 "不要描述内部计算机制（不要写平均/求和/预测概率等资料没有的步骤），"
                                 "注明『训练细节见原论文』；ELMo 只按资料讲上下文相关嵌入解决一词多义，"
                                 "不要与 BERT 建立历史关系。",
                        "exercise": {
                            "function_name": "most_similar",
                            "hint": "实现 most_similar(word_vecs, query_vec)：word_vecs 是 {词: 向量} 字典，"
                                    "返回与 query_vec 余弦相似度最高的词（并列取字典序最小）。math.sqrt 手写余弦。",
                        },
                    },
                ],
            },
            {
                "chapter_id": "ch2",
                "title": "第二章 注意力机制与 Transformer",
                "intro": "现代大模型的心脏。这一章我们把 Transformer 拆到螺丝钉，再亲手装回去。",
                "lessons": [
                    {
                        "lesson_id": "llm2-01",
                        "title": "为什么需要注意力：从 RNN 的困境说起",
                        "source_range": ["ha03s01#s7", "ha03s01#s8", "hl02s01#s2"],
                        "focus": "RNN 隐藏状态的记忆机制与长距离依赖困境；LSTM 的缓解与极限；"
                                 "注意力机制的核心思想如何破局（并行 + 全局视野）。历史叙事讲成侦探故事。",
                        "exercise": {
                            "function_name": "dot",
                            "hint": "实现 dot(a, b)：两个等长向量的点积（列表推导+sum 即可）。"
                                    "热身题——下一课它就是注意力打分的核心。",
                        },
                    },
                    {
                        "lesson_id": "llm2-02",
                        "title": "注意力机制：Q、K、V 与缩放点积",
                        "source_range": ["hl02s01#s3", "hl02s01#s4", "hl02s01#s5"],
                        "focus": "Q 问、K 答、V 供货的类比讲透三变量；缩放点积公式逐符号拆解 + 完整手算"
                                 "（点积→缩放→softmax→加权求和每步都算出数字）。"
                                 "除以 √d 的原因严格按资料一句话讲（维度大时影响 softmax 放缩与梯度稳定性），"
                                 "不要展开统计推导、不要发明术语、不要谈具体模型产品。",
                        "interactive_embed": {
                            "name": "Transformer Explainer（佐治亚理工 Poloclub）",
                            "url": "https://poloclub.github.io/transformer-explainer/",
                            "license_note": "MIT 许可，官方在线版",
                            "guide": "输入一句话，观察注意力矩阵：哪个词在看哪个词？",
                        },
                        "exercise": {
                            "function_name": "attention",
                            "hint": "实现 attention(q, keys, values)：点积打分→除以 math.sqrt(len(q))→softmax→"
                                    "对 values 加权求和，每维 round 4 位小数。纯 Python 列表。",
                        },
                    },
                    {
                        "lesson_id": "llm2-03",
                        "title": "注意力的代码实现与自注意力",
                        "source_range": ["hl02s01#s6", "hl02s01#s7"],
                        "focus": "PyTorch 版注意力代码逐行走读（给没写过 torch 的人讲清每个张量形状）；"
                                 "自注意力=Q/K/V 同源，为什么这让模型『让每个词看见彼此』。",
                        "exercise": {
                            "function_name": "attention_matrix",
                            "hint": "实现 attention_matrix(X)：对向量列表 X 计算 n×n 注意力权重矩阵"
                                    "（Q=K=X，缩放点积+softmax 按行归一），每个权重 round 4 位。",
                        },
                    },
                    {
                        "lesson_id": "llm2-04",
                        "title": "掩码自注意力与多头注意力",
                        "source_range": ["hl02s01#s8", "hl02s01#s9", "hl02s01#s10",
                                         "hl02s01#s11", "hl02s01#s12", "hl02s01#s13"],
                        "focus": "因果掩码：为什么生成时不能偷看未来（上三角遮蔽代码走读）；"
                                 "多头注意力的拆分-并行-拼接全流程（形状变换逐步讲）；多头=多位专家的类比。"
                                 "多头的动机严格按资料表述（一次注意力只能拟合一种相关关系，多头拟合多种），"
                                 "不要写参数量增减、GPU 效率、泛化能力等资料没有的优劣结论，"
                                 "也不要给数学性质起资料没用过的名字。",
                        "exercise": {
                            "function_name": "causal_mask",
                            "hint": "实现 causal_mask(n)：返回 n×n 的 0/1 下三角矩阵（列表的列表，"
                                    "i 行 j 列为 1 当且仅当 j<=i）——这就是『不许偷看未来』的数学形状。",
                        },
                    },
                    {
                        "lesson_id": "llm2-05",
                        "title": "Encoder 的另外两块积木：FFN 与层归一化",
                        "source_range": ["hl02s02#s1", "hl02s02#s2", "hl02s02#s3",
                                         "hl02s02#s4", "hl02s02#s5", "hl02s02#s6"],
                        "focus": "Seq2Seq 任务背景；前馈网络在注意力之后做什么；层归一化的动机与公式"
                                 "（手算一个向量的归一化）；残差连接为什么能让深网络可训练。",
                        "exercise": {
                            "function_name": "layer_norm",
                            "hint": "实现 layer_norm(x, eps)：对向量 x 做层归一化 (x-均值)/sqrt(方差+eps)，"
                                    "每维 round 4 位小数。方差用总体方差（除以 n）。",
                        },
                    },
                    {
                        "lesson_id": "llm2-06",
                        "title": "组装 Encoder 与 Decoder",
                        "parts": 1,
                        "source_range": ["hl02s02#s7", "hl02s02#s8", "hl02s02#s9", "hl02s02#s10",
                                         "hl02s01#s8", "ha03s01#s10"],
                        "focus": "Encoder Layer/Decoder Layer 的代码结构逐块走读；Decoder 的两层注意力"
                                 "（掩码自注意 + 对编码器输出的交叉注意力）各自在干什么；N 层堆叠按资料表述讲。"
                                 "硬禁令（都是资料没写的）：不描述 MLP/前馈层的内部结构（资料只给了调用行，"
                                 "就只说『前馈网络模块，第五课已详解』）；掩码只说『上三角矩阵遮蔽未来信息』"
                                 "（方向以资料为准：上三角被遮蔽），不写负无穷、softmax 置零等数值细节；"
                                 "不解释 src_mask 的用途（资料没讲）；N 只说『是超参数』，不给典型取值；"
                                 "不写参数共享、层次抽象、推理自回归等结论；不起 Pre-Norm/Post-Norm 等资料外名字。",
                        "exercise": {
                            "function_name": "ffn",
                            "hint": "实现 ffn(x, w1, b1, w2, b2)：两层线性+ReLU（max(0,·)）的前馈网络，"
                                    "输入输出都是向量（列表），每维 round 4 位。矩阵按行存（w[i][j]=第i输出第j输入）。",
                        },
                    },
                    {
                        "lesson_id": "llm2-07",
                        "title": "Embedding 层与位置编码",
                        "source_range": ["hl02s03#s2", "hl02s03#s3", "hl02s03#s4",
                                         "hl02s03#s5", "hl02s03#s6", "hl02s03#s7", "hl02s03#s8"],
                        "focus": "Embedding 层=可学习的查表；注意力为什么天生不知道顺序；正弦位置编码公式"
                                 "手算（含资料中的推导直觉），代码走读。",
                        "exercise": {
                            "function_name": "positional_encoding",
                            "hint": "实现 positional_encoding(pos, d_model)：偶数维 sin、奇数维 cos，"
                                    "频率 10000**(2i/d_model)，返回长度 d_model 的列表，每维 round 4 位。",
                        },
                    },
                    {
                        "lesson_id": "llm2-08",
                        "title": "从零手搓一个完整的 Transformer",
                        "parts": 1,
                        "source_range": ["hl02s03#s9", "hl02s03#s10", "hl02s03#s11",
                                         "hl02s03#s12", "ha03s01#s16",
                                         "hl02s02#s7", "hl02s02#s9", "hl02s03#s3"],
                        "focus": "所有组件按结构图组装成完整模型（代码逐段走读：前向传播的完整数据流）；"
                                 "参数量怎么数（按资料代码讲，不解释为什么排除 embedding——资料没说原因）；"
                                 "Decoder-Only 架构与 GPT 的选择（按 ha03 资料表述）。"
                                 "组件回顾（Encoder/Decoder 内部、位置编码）严格按所附资料块的表述，"
                                 "不起 Pre-Norm/Post-Norm 等资料外名字、不展开结构对比或梯度稳定性结论。",
                        "exercise": {
                            "function_name": "total_params",
                            "hint": "实现 total_params(shapes)：shapes 是 [(输入维,输出维), …] 的线性层列表，"
                                    "返回总参数量（每层=in*out+out 偏置）。数一数你手搓的模型有多大。",
                        },
                    },
                ],
            },
            {
                "chapter_id": "ch3",
                "title": "第三章 预训练语言模型：三大家族",
                "intro": "Transformer 造好了积木，这一章看三条路线怎么用它盖房子：只用 Encoder、Encoder-Decoder 全用、只用 Decoder。",
                "lessons": [
                    {
                        "lesson_id": "llm3-01",
                        "title": "Encoder-only：BERT",
                        "parts": 1,
                        "source_range": ["hl03s01#s1", "hl03s01#s2", "hl03s01#s3",
                                         "hl03s01#s4", "hl03s01#s5", "hl03s01#s6",
                                         "hl03s01#s7"],
                        "focus": "BERT 的架构与输入输出形态、MLM 完形填空式预训练任务的动机与做法、"
                                 "预训练+微调范式；资料的输入输出示例当验收锚点。"
                                 "GELU 只讲『随机正则思想引入激活函数』这一句思路，不补公式推导；"
                                 "不写 token id 具体数字、不列嵌入种类清单（资料没写）；"
                                 "微调策略只许复述资料原话『和训练时更新模型参数的策略一致』；"
                                 "不写提出年份与机构；成绩只许说资料原话（NLP 11 个赛道 SOTA）。"
                                 "全课禁止『表明/证明/因此提升/更擅长』式的引申结论——"
                                 "只复述资料写明的事实。",
                        "exercise": {
                            "function_name": "mask_tokens",
                            "hint": "实现 mask_tokens(tokens, positions)：把列表 tokens 中指定下标位置的词"
                                    "替换为 '[MASK]'，返回 (新列表, 被盖住的原词列表)——模拟 MLM 的完形填空。",
                        },
                    },
                    {
                        "lesson_id": "llm3-02",
                        "title": "BERT 的改良者：RoBERTa 与 ALBERT",
                        "parts": 1,
                        "source_range": ["hl03s01#s8", "hl03s01#s9", "hl03s01#s10",
                                         "hl03s01#s11", "hl03s01#s12", "hl03s01#s13"],
                        "focus": "RoBERTa 的优化各条只许复述资料表述，逐条讲清资料写明的做法与资料写明的"
                                 "结论，禁止追加任何引申（不写『表明步长提升性能』——资料说的是"
                                 "『证明了大 batch size 的意义』，照抄；词表扩大的影响照抄资料原话"
                                 "『越大的词表也会带来模型参数的增加』，禁止反着说；"
                                 "不编『处理复合词缩写表现更佳』这类资料外性能结论）。"
                                 "训练数字铁律：只许原样复述『在 8K 的 batch size 下训练了 31K Step』"
                                 "『一共训练了 500K Step』；禁止引入 BERT 的任何训练数字做对比"
                                 "（资料没写 BERT 的总步数和 batch size——不要编），"
                                 "禁止比较级评价与 Epoch 换算。ALBERT 参数共享只许说『仅初始化了一个 "
                                 "Encoder 层，计算过程仍进行 24 次、每次都经过这一层』；"
                                 "不写任何模型的提出年份、机构、全称展开。",
                        "exercise": {
                            "function_name": "shared_layer_calls",
                            "hint": "实现 shared_layer_calls(n_layers, n_shared)：返回每个共享层被复用的次数，"
                                    "即 n_layers // n_shared（输入保证整除，无需异常处理）"
                                    "——ALBERT 参数共享的算术。",
                        },
                    },
                    {
                        "lesson_id": "llm3-03",
                        "title": "Encoder-Decoder：T5 与「万物皆文本」",
                        "source_range": ["hl03s02#s1", "hl03s02#s2", "hl03s02#s3",
                                         "hl03s02#s4"],
                        "focus": "T5 把一切 NLP 任务统一成 text-to-text 的核心思想（输入加任务前缀）；"
                                 "架构上与 BERT 的 Self-Attention 同构点、与 Transformer 原始结构的关系；"
                                 "大规模预训练是 T5 成功的关键。本节资料短，宁浅勿编："
                                 "只讲资料明确写到的内容，不展开 span corruption 等资料未提的预训练细节，"
                                 "不与 BART 等资料未提的模型做对比。",
                        "exercise": {
                            "function_name": "prefix_task",
                            "hint": "实现 prefix_task(pairs)：pairs 是 (任务名, 文本) 元组列表，"
                                    "返回 ['任务名: 文本', …] 格式的字符串列表——体验万物皆文本的输入构造。",
                        },
                    },
                    {
                        "lesson_id": "llm3-04",
                        "title": "Decoder-only（上）：GPT 系列与「力大砖飞」",
                        "source_range": ["hl03s03#s1", "hl03s03#s2", "hl03s03#s3",
                                         "hl03s03#s4", "hl03s03#s5"],
                        "focus": "Decoder-only 架构：没有 Encoder 编码结果后，掩码注意力如何变成自注意力；"
                                 "GPT-1 到 GPT-3 的结构与语料规模演进（资料的对比表当重头戏逐行讲）；"
                                 "GPT-3 的 few-shot 能力与『力大砖飞』路线的开创意义。"
                                 "严格按资料的表与叙述讲演进，不补充资料外的参数数字或训练细节。",
                        "exercise": {
                            "function_name": "argmax_token",
                            "hint": "实现 argmax_token(probs)：probs 是 {token: 概率} 字典，"
                                    "返回概率最大的 token（并列取字典序最小）——贪心解码每一步在做的事。",
                        },
                    },
                    {
                        "lesson_id": "llm3-05",
                        "title": "Decoder-only（下）：LLaMA 与 GLM",
                        "source_range": ["hl03s03#s6", "hl03s03#s7", "hl03s03#s8",
                                         "hl03s03#s9", "hl03s03#s10"],
                        "focus": "LLaMA 一到三代的参数量与上下文长度演进（按资料时间线讲）、"
                                 "开源路线的意义；GLM 的自回归空白填充任务怎么结合 MLM 与 CLM 思想"
                                 "（核心机制当重头戏）、GLM 系列到 GLM-4 的演进。"
                                 "架构组件细节资料没写就一个不提（不提 RMSNorm/SwiGLU/旋转位置编码等名词，"
                                 "第五章动手实现时才讲）；参数量与上下文长度只许照资料原文逐个列举"
                                 "（LLaMA-1 是 7B/13B/30B/65B，LLaMA-2 是 7B/13B/34B/70B），"
                                 "禁止自行做『演进趋势』总结；开源表述照资料（LLaMA-2 的 34B 未开源，"
                                 "不许说『完全开源』）；"
                                 "模型能力对比严格按资料表述（如 GLM-4 英文基准达 GPT-4 水平即资料原话）。",
                        "exercise": {
                            "function_name": "max_fit_suffix",
                            "hint": "实现 max_fit_suffix(lengths, window)：lengths 是各条消息的 token 数列表，"
                                    "返回从末尾往前最多能装进 window 的连续消息条数——上下文窗口的取舍逻辑。",
                        },
                    },
                ],
            },
            {
                "chapter_id": "ch4",
                "title": "第四章 大语言模型：定义、能力与训练全流程",
                "intro": "预训练模型长到千亿参数后发生了什么？这一章讲清 LLM 是什么，以及 Pretrain→SFT→RLHF 三段式训练的完整地图。",
                "lessons": [
                    {
                        "lesson_id": "llm4-01",
                        "title": "什么是 LLM：定义、能力与特点",
                        "source_range": ["hl04s01#s1", "hl04s01#s2", "hl04s01#s3",
                                         "hl04s01#s4", "hl04s01#s5", "hl04s01#s6"],
                        "focus": "LLM 的定义与判别口径（按资料）；开源/闭源代表模型时间表如实过一遍；"
                                 "三大能力：涌现能力、指令遵循、上下文学习（每个能力：资料的定义+例子）；"
                                 "LLM 相对传统预训练模型的特点。"
                                 "只列资料时间表里出现的模型，不补充资料外的新模型八卦。",
                        "exercise": {
                            "function_name": "filter_open_models",
                            "hint": "实现 filter_open_models(models)：models 是 (名字, 是否开源, 参数量) 元组列表，"
                                    "返回开源模型按参数量降序的名字列表（并列取字典序最小在前）。",
                        },
                    },
                    {
                        "lesson_id": "llm4-02",
                        "title": "Pretrain：Scaling Law 与分布式训练",
                        "source_range": ["hl04s02#s1", "hl04s02#s2", "hl04s02#s3",
                                         "hl04s02#s4", "hl04s02#s5"],
                        "focus": "预训练的目标与代价；Scaling Law（C~6ND）怎么指导算力/参数/数据的配比"
                                 "（用资料的公式与表述当重头戏）；ZeRO 一二三档各分片什么（按资料逐档讲）；"
                                 "预训练数据准备流水线：文档准备→URL 过滤→去重等步骤按资料顺序讲。"
                                 "ZeRO 只讲资料列出的分片对象，不展开通信量分析；"
                                 "Scaling Law 不引入资料外的 Chinchilla 等结论。",
                        "exercise": {
                            "function_name": "scaling_flops",
                            "hint": "实现 scaling_flops(n, d)：按 C=6ND 返回训练所需计算量"
                                    "（n=参数量，d=token 数）——Scaling Law 的算术直觉。",
                        },
                    },
                    {
                        "lesson_id": "llm4-03",
                        "title": "SFT：指令微调与多轮对话怎么构造",
                        "source_range": ["hl04s02#s6", "hl04s02#s7", "hl04s02#s8",
                                         "hl04s02#s9"],
                        "focus": "SFT 与预训练在数据上的本质区别（有监督指令语料）；"
                                 "高质量指令数据集为什么难获取；多轮对话的三种样本构造方式"
                                 "（资料的对话例子当重头戏，讲透为什么只有第三种既不丢信息也不重复计算）。"
                                 "不展开资料未提的指令数据合成方法。",
                        "exercise": {
                            "function_name": "dialog_samples",
                            "hint": "实现 dialog_samples(turns)：turns 是 n 轮 (提问, 回答) 列表，"
                                    "按『一条样本包含全部历史、只训练最后一轮回答』的方式返回样本数与"
                                    "最长样本包含的轮数元组 (n, n)——理解多轮构造的第三种方式。",
                        },
                    },
                    {
                        "lesson_id": "llm4-04",
                        "title": "RLHF 与 DPO：让模型对齐人类偏好",
                        "source_range": ["hl04s02#s10", "hl04s02#s11", "hl04s02#s12",
                                         "hl04s02#s13"],
                        "focus": "RLHF 在三段式训练中的位置；奖励模型的训练数据形态（chosen/rejected 对，"
                                 "用资料的例子）；PPO 阶段的四个模型各自角色（按资料的初始化关系讲）；"
                                 "RLHF 门槛为什么高，DPO 从监督学习出发的替代思路。"
                                 "PPO 只讲资料给出的流程角色，不展开策略梯度数学推导。",
                        "exercise": {
                            "function_name": "rm_accuracy",
                            "hint": "实现 rm_accuracy(pairs, scores)：pairs 是 (chosen, rejected) 文本对列表，"
                                    "scores 是 {文本: 分数} 字典，返回奖励模型把 chosen 打分严格高于 rejected "
                                    "的比例（保留三位小数）。",
                        },
                    },
                ],
            },
            {
                "chapter_id": "ch5",
                "title": "第五章 亲手搭一个 LLaMA2",
                "intro": "前四章的所有概念，这一章全部落成代码：从 RMSNorm 到完整模型，从训练 Tokenizer 到预训练、SFT、生成文本，走完一个小型 LLM 的全生命周期。",
                "lessons": [
                    {
                        "lesson_id": "llm5-01",
                        "title": "超参数与 RMSNorm",
                        "source_range": ["hl05s01#s1", "hl05s01#s2", "hl05s01#s3",
                                         "hl05s01#s4"],
                        "focus": "ModelArgs 超参数逐个讲含义（dim/n_layers/n_heads 等，按资料注释）；"
                                 "RMSNorm 的公式与代码实现逐行走读、它和第二章 LayerNorm 的差异"
                                 "（只按资料表述，不引入资料外的归一化对比结论）。",
                        "exercise": {
                            "function_name": "rms_norm",
                            "hint": "实现 rms_norm(xs, eps)：对一维浮点列表做 RMSNorm"
                                    "（除以 sqrt(均方+eps)），返回新列表（元素保留四位小数）。",
                        },
                    },
                    {
                        "lesson_id": "llm5-02",
                        "title": "LLaMA2 Attention：旋转位置编码与注意力实现",
                        "source_range": ["hl05s01#s5", "hl05s01#s6", "hl05s01#s7",
                                         "hl05s01#s8", "hl05s01#s9", "hl05s01#s10",
                                         "hl05s01#s11", "hl05s01#s12"],
                        "focus": "RoPE 旋转位置编码的代码走读（预计算频率、复数旋转、应用到 Q/K）；"
                                 "Attention 模块的完整实现：KV 头数与重复、Flash Attention 的检测与两种实现分支；"
                                 "输出形状的变换链路（资料代码注释当锚点逐段讲）。"
                                 "RoPE 的数学背景只讲到资料代码注释的深度，不补写复数域推导。",
                        "exercise": {
                            "function_name": "rotate_pairs",
                            "hint": "实现 rotate_pairs(vec)：偶数长度浮点列表按 (x,y)->(-y,x) 两两旋转 90 度，"
                                    "返回新列表——旋转位置编码最机械的一步。",
                        },
                    },
                    {
                        "lesson_id": "llm5-03",
                        "title": "MLP、DecoderLayer 与整装 LLaMA2",
                        "source_range": ["hl05s01#s13", "hl05s01#s14", "hl05s01#s15",
                                         "hl05s01#s16", "hl05s01#s17", "hl05s01#s18",
                                         "hl05s01#s19", "hl05s01#s20", "hl05s01#s21"],
                        "focus": "MLP 模块三个线性层的结构与激活（按资料代码）；DecoderLayer 怎么把 "
                                 "Attention 与 MLP 用残差接起来；完整 Transformer 类的组装：权重初始化、"
                                 "前向传播、inference_mode 下的生成方法；两处形状测试的输出当验收锚点。"
                                 "初始化策略只讲资料代码做了什么，不展开为什么这样初始化。",
                        "exercise": {
                            "function_name": "mlp_params",
                            "hint": "实现 mlp_params(dim, hidden)：LLaMA2 MLP 三个无偏置线性层"
                                    "（dim→hidden、dim→hidden、hidden→dim）的总参数量。",
                        },
                    },
                    {
                        "lesson_id": "llm5-04",
                        "title": "训练一个 Tokenizer",
                        "source_range": ["hl05s02#s1", "hl05s02#s2", "hl05s02#s3",
                                         "hl05s02#s4", "hl05s02#s5", "hl05s02#s6",
                                         "hl05s02#s7", "hl05s02#s8", "hl05s02#s9",
                                         "hl05s02#s10"],
                        "focus": "字符级/子词级 Tokenizer 的取舍（衔接第一章第 2 课的思想，按本节资料展开）；"
                                 "用 tokenizers 库训练 BPE 的完整流程：语料、特殊 token、训练器配置、"
                                 "special_tokens_map 与 tokenizer_config 各字段含义、训练后基本属性测试。"
                                 "库的用法严格按资料代码讲，不引入资料外的 sentencepiece 对比。",
                        "exercise": {
                            "function_name": "char_vocab",
                            "hint": "实现 char_vocab(text)：统计字符频次，返回按频次降序"
                                    "（并列取字典序最小在前）的字符列表——字符级分词器的词表构建。",
                        },
                    },
                    {
                        "lesson_id": "llm5-05",
                        "title": "预训练数据流（上）：下载、转换与 Tokenizer 配置",
                        "source_range": ["hl05s03#s1", "hl05s03#s2", "hl05s03#s3",
                                         "hl05s03#s4", "hl05s03#s5", "hl05s03#s6",
                                         "hl05s03#s7", "hl05s03#s8", "hl05s03#s9"],
                        "focus": "预训练语料与 SFT 语料的下载与格式转换（convert_message 的字段映射逐行讲）；"
                                 "为本项目训练 Tokenizer：配置文件生成、聊天模板的测试输出当验收锚点。"
                                 "数据集只讲资料用到的，不推荐资料外的数据源。",
                        "exercise": {
                            "function_name": "convert_roles",
                            "hint": "实现 convert_roles(msgs)：msgs 是 {'role':…,'content':…} 字典列表，"
                                    "把 role 按 {'human':'user','assistant':'assistant'} 映射后返回新列表；"
                                    "未知 role 原样保留不改写（判题器只比返回值，不要抛异常）"
                                    "——数据格式转换的核心逻辑。",
                        },
                    },
                    {
                        "lesson_id": "llm5-06",
                        "title": "预训练数据流（下）：Dataset 与 loss mask",
                        "source_range": ["hl05s03#s10", "hl05s03#s11", "hl05s03#s12",
                                         "hl05s03#s13", "hl05s03#s14", "hl05s03#s15"],
                        "focus": "PretrainDataset 的 X/Y 错位构造（__getitem__ 逐行讲）；"
                                 "SFTDataset 的多轮对话目标与 loss mask 生成算法（generate_loss_mask 当重头戏）；"
                                 "两个 Dataset 的 X/Y 相同、差别只在 mask 这一关键观察。",
                        "exercise": {
                            "function_name": "loss_mask",
                            "hint": "实现 loss_mask(n, spans)：返回长度 n 的 0/1 列表，spans 里的 "
                                    "(起, 止) 区间（含起不含止）置 1 其余 0——只对回答部分算损失的 mask。",
                        },
                    },
                    {
                        "lesson_id": "llm5-07",
                        "title": "预训练循环：从 train_epoch 到跑起来",
                        "source_range": ["hl05s03#s16", "hl05s03#s17", "hl05s03#s18",
                                         "hl05s03#s19", "hl05s03#s20", "hl05s03#s21",
                                         "hl05s03#s22", "hl05s03#s23", "hl05s03#s24",
                                         "hl05s03#s25"],
                        "focus": "预训练主循环逐段走读：学习率调度、梯度累积（每 accumulation_steps 步"
                                 "更新一次优化器）、定期保存 checkpoint、init_model 与命令行参数、"
                                 "模型和数据初始化的完整启动序列；generate 方法取最后位置 logits 的生成逻辑。"
                                 "分布式细节只讲资料代码出现的部分。",
                        "exercise": {
                            "function_name": "update_steps",
                            "hint": "实现 update_steps(total_batches, accumulation_steps)：返回一个 epoch 内"
                                    "优化器实际更新的次数（每 accumulation_steps 个 batch 更新一次，"
                                    "不足一组的尾部不更新）——梯度累积的算术。",
                        },
                    },
                    {
                        "lesson_id": "llm5-08",
                        "title": "SFT 训练：复用预训练循环",
                        "source_range": ["hl05s03#s26", "hl05s03#s27", "hl05s03#s28",
                                         "hl05s03#s29", "hl05s03#s30", "hl05s03#s31",
                                         "hl05s03#s32"],
                        "focus": "SFT 训练脚本与预训练脚本的同与不同（train_epoch/日志/保存逐段对照）；"
                                 "DataParallel 包装下 state_dict 的取法这个工程细节；启动参数与开始训练。"
                                 "宁浅勿编：资料没写的调参经验不要补。",
                        "exercise": {
                            "function_name": "save_steps",
                            "hint": "实现 save_steps(total_steps, save_interval)：返回会触发保存的 step 序号列表"
                                    "（从 save_interval 起每隔 save_interval 一次，不含 0）。",
                        },
                    },
                    {
                        "lesson_id": "llm5-09",
                        "title": "用模型生成文本：TextGenerator 走读",
                        "source_range": ["hl05s03#s33", "hl05s03#s34", "hl05s03#s35",
                                         "hl05s03#s36", "hl05s03#s37", "hl05s03#s38",
                                         "hl05s03#s39"],
                        "focus": "TextGenerator 类的初始化与两种采样入口（pretrain_sample/sft_sample 参数逐个讲）；"
                                 "chat_template 的作用；用资料的 prompt 样例当验收锚点，"
                                 "说清两条采样入口各自服务哪一轮训练产物。"
                                 "语料只给出了 SFT 那一轮的回答文本，没有给预训练的续写正文，"
                                 "因此不做两个模型的输出对比。"
                                 "采样参数只讲资料代码用到的，不展开资料外的解码策略综述。",
                        "exercise": {
                            "function_name": "greedy_walk",
                            "hint": "实现 greedy_walk(next_map, start, steps)：next_map 是 {词: 下一个词} 字典，"
                                    "从 start 走 steps 步返回生成序列（含 start；缺键提前停）——最简生成循环。",
                        },
                    },
                ],
            },
            {
                "chapter_id": "ch6",
                "title": "第六章 训练工程实战：Transformers 生态",
                "intro": "第五章手搓了一切，这一章换成业界正规军打法：用 Transformers + DeepSpeed + peft 完成预训练、SFT、高效微调与偏好对齐。",
                "lessons": [
                    {
                        "lesson_id": "llm6-01",
                        "title": "用 Transformers 框架做预训练",
                        "source_range": ["hl06s01#s1", "hl06s01#s2", "hl06s01#s3",
                                         "hl06s01#s4", "hl06s01#s5", "hl06s01#s6",
                                         "hl06s01#s7", "hl06s01#s8", "hl06s01#s9",
                                         "hl06s01#s10", "hl06s01#s11", "hl06s01#s12",
                                         "hl06s01#s13", "hl06s01#s14", "hl06s01#s15"],
                        "focus": "框架选型理由（按资料）；从零初始化 vs 继续预训练的取舍（资料说很少从零init，"
                                 "这句要讲透）；预训练数据处理与 Trainer 训练循环；DeepSpeed 分布式配置、"
                                 "命令行启动、log 而非 print 的工程习惯、从 checkpoint 恢复。"
                                 "配置字段只讲资料 json/参数出现的，不展开资料外的 DeepSpeed 全家桶。",
                        "exercise": {
                            "function_name": "pack_blocks",
                            "hint": "实现 pack_blocks(lengths, block_size)：文档 token 长度列表首尾拼接后"
                                    "能切出多少个完整 block（整除计数）——预训练数据 packing 的算术。",
                        },
                    },
                    {
                        "lesson_id": "llm6-02",
                        "title": "SFT 实战：数据处理与训练启动",
                        "source_range": ["hl06s02#s1", "hl06s02#s2", "hl06s02#s3",
                                         "hl06s02#s4", "hl06s02#s5", "hl06s02#s6"],
                        "focus": "SFT 微调数据的拼接与 tokenize 流程（资料代码逐段走读，labels 与 input 的"
                                 "构造关系当重头戏）；转成 tensor 与 Dataset 字典的落地细节；"
                                 "SwanLab 实验记录与随机种子设置的工程习惯。"
                                 "与第五章手搓版的对照点到为止，以本节资料代码为准。",
                        "exercise": {
                            "function_name": "sft_labels",
                            "hint": "实现 sft_labels(prompt_len, total_len)：返回长度 total_len 的列表，"
                                    "前 prompt_len 个是 -100（不算损失），其余是 1——SFT labels 掩码的骨架。",
                        },
                    },
                    {
                        "lesson_id": "llm6-03",
                        "title": "高效微调：LoRA 原理、实现与偏好对齐衔接",
                        "source_range": ["hl06s03#s1", "hl06s03#s2", "hl06s03#s3",
                                         "hl06s03#s4", "hl06s03#s5", "hl06s03#s6",
                                         "hl06s03#s7", "hl06s03#s8", "hl06s03#s9",
                                         "hl06s03#s10", "hl06s04#s1", "hl06s04#s2",
                                         "hl06s04#s3"],
                        "focus": "高效微调方案版图（按资料）；LoRA 的原理：低秩分解在改什么、为什么省"
                                 "（资料的原理节当重头戏）；LoRA 代码实现走读与 peft 库用法；"
                                 "LoRA 同样适用于 DPO/KTO 的衔接句；偏好对齐概览按 hl06s04 的衔接与"
                                 "学习建议讲（薄材料，宁浅勿编：DPO 机制细节回指第四章第 4 课，"
                                 "不在本课展开数学；资料没写的对齐算法一律不提）。",
                        "exercise": {
                            "function_name": "lora_params",
                            "hint": "实现 lora_params(d, r)：d×d 权重矩阵的 LoRA 旁路（d×r 和 r×d 两个矩阵）"
                                    "参数量，与全量微调 d*d 的比值元组 (lora, ratio)，ratio 保留四位小数。",
                        },
                    },
                ],
            },
            {
                "chapter_id": "ch7",
                "title": "第七章 评测、RAG 与 Agent：走向应用",
                "intro": "模型训完了，怎么知道它行不行？怎么让它用上外部知识、动手干活？这一章补齐评测、RAG 与 Agent 三块应用拼图。",
                "lessons": [
                    {
                        "lesson_id": "llm7-01",
                        "title": "LLM 的评测：数据集与榜单",
                        "source_range": ["hl07s01#s1", "hl07s01#s2", "hl07s01#s3",
                                         "hl07s01#s4"],
                        "focus": "主流评测数据集各考什么（按资料逐个讲）；主流榜单与特定领域榜单的分工。"
                                 "本节资料短，宁浅勿编：只列资料点名的数据集与榜单，"
                                 "不编造分数与排名，不补充资料外的评测方法论。",
                        "exercise": {
                            "function_name": "rank_models",
                            "hint": "实现 rank_models(scores)：scores 是 {模型: 分数} 字典，"
                                    "返回按分数降序的 (模型, 名次) 列表，同分同名次（1224 排名法）。",
                        },
                    },
                    {
                        "lesson_id": "llm7-02",
                        "title": "手搓一个 RAG 框架",
                        "source_range": ["hl07s02#s1", "hl07s02#s2", "hl07s02#s3",
                                         "hl07s02#s4", "hl07s02#s5", "hl07s02#s6",
                                         "hl07s02#s7", "hl07s02#s8", "hl07s02#s9",
                                         "hl07s02#s10"],
                        "focus": "RAG 解决什么问题（按资料）；四件套逐个实现：文本分块（重叠切分代码"
                                 "当重头戏）、Embedding 与向量校验、向量库的存取与查询、"
                                 "带检索内容的 chat 拼装；端到端 query 示例走通。"
                                 "与本平台自身的 RAG 课程呼应但以本节资料代码为准，不混讲。",
                        "exercise": {
                            "function_name": "split_chunks",
                            "hint": "实现 split_chunks(text, size, overlap)：按 size 切块、相邻块重叠 overlap "
                                    "字符，返回块列表（最后不足 size 的尾块保留）——RAG 分块的核心。",
                        },
                    },
                    {
                        "lesson_id": "llm7-03",
                        "title": "手搓一个 Tiny-Agent",
                        "source_range": ["hl07s03#s1", "hl07s03#s2", "hl07s03#s3",
                                         "hl07s03#s4", "hl07s03#s5", "hl07s03#s6",
                                         "hl07s03#s7", "hl07s03#s8"],
                        "focus": "LLM Agent 的类型版图（按资料）；Tiny-Agent 动手构造：工具函数定义"
                                 "（search_wikipedia 例）、Agent 类管理对话历史与工具调用的循环"
                                 "（资料的步骤清单当重头戏逐步讲）、运行示例。"
                                 "只讲资料实现的单工具循环，不展开资料外的多 Agent 框架综述"
                                 "（那是本平台其他课程的领地）。",
                        "exercise": {
                            "function_name": "parse_tool_call",
                            "hint": "实现 parse_tool_call(text)：解析 '工具名(参数)' 格式字符串，"
                                    "返回 (工具名, 参数) 元组；格式不合法（缺括号）返回 None——"
                                    "Agent 解析模型输出的最小内核。",
                        },
                    },
                ],
            },
        ],
        "projects": [],  # 由 LLM_PROJECTS 注入（L1/L2/L3 阶梯）
    },
}

# 分级项目阶梯（人工策展 + 机器验证；测评是命门）
_BPE_DATASET = '''VOCAB = {
    "h u g </w>": 10,
    "p u g </w>": 5,
    "p u n </w>": 12,
    "b u n </w>": 4,
    "h u g s </w>": 5,
}'''

_GPT_DATASET = '''EMB = [
    [0.1, 0.3],
    [0.5, 0.2],
    [0.4, 0.6],
    [0.2, 0.1],
]'''

LLM_PROJECTS: list[dict] = [
    # L1：沿用唐诗接龙机（在 CAPSTONES 里定义，注入时补分级字段）
    {
        "project_id": "llm-p2",
        "level": "L2",
        "level_note": "进阶（学完第 1-2 章）：能独立实现经典算法——这是校招笔试的常见水位",
        "title": "L2 项目：从头训练一个迷你 BPE 分词器",
        "brief_md": (
            "第 2 课学的 BPE，这次自己完整实现一遍。数据集就是教材里的经典词频表"
            "（`h u g </w>` 家族），你的实现如果正确，第一次合并一定是 `('u','g')`——"
            "和教材输出一模一样。\n\n"
            "**任务**：\n\n"
            "1. `get_stats(vocab)`：统计相邻符号对的加权频次，返回 `{(a,b): 次数}`\n"
            "2. `merge_vocab(pair, vocab)`：把词表中所有相邻的 `pair` 合并成新符号（一次遍历不重叠），"
            "返回新词表\n"
            "3. `learn_bpe(vocab, num_merges)`：迭代『统计→选最高频对（并列取字典序最小）→合并』，"
            "返回按序的合并列表\n\n"
            "**评分**：公开 40 / 私榜 60；≥60 结业，≥85 优秀。"
        ),
        "dataset_name": "教材经典 BPE 词频表",
        "dataset_code": _BPE_DATASET,
        "starter_code": (
            "def get_stats(vocab):\n"
            "    \"\"\"相邻符号对加权频次 -> {(a,b): count}\"\"\"\n"
            "    pass\n\n\n"
            "def merge_vocab(pair, vocab):\n"
            "    \"\"\"合并词表中所有相邻 pair，返回新词表\"\"\"\n"
            "    pass\n\n\n"
            "def learn_bpe(vocab, num_merges):\n"
            "    \"\"\"迭代学习 BPE 合并规则，返回合并列表 [(a,b), ...]\"\"\"\n"
            "    pass\n"
        ),
        "solution_code": (
            "def get_stats(vocab):\n"
            "    stats = {}\n"
            "    for word, cnt in vocab.items():\n"
            "        syms = word.split()\n"
            "        for i in range(len(syms) - 1):\n"
            "            pair = (syms[i], syms[i + 1])\n"
            "            stats[pair] = stats.get(pair, 0) + cnt\n"
            "    return stats\n\n\n"
            "def merge_vocab(pair, vocab):\n"
            "    a, b = pair\n"
            "    new = {}\n"
            "    for word, cnt in vocab.items():\n"
            "        syms = word.split()\n"
            "        out = []\n"
            "        i = 0\n"
            "        while i < len(syms):\n"
            "            if i < len(syms) - 1 and syms[i] == a and syms[i + 1] == b:\n"
            "                out.append(a + b)\n"
            "                i += 2\n"
            "            else:\n"
            "                out.append(syms[i])\n"
            "                i += 1\n"
            "        key = ' '.join(out)\n"
            "        new[key] = new.get(key, 0) + cnt\n"
            "    return new\n\n\n"
            "def learn_bpe(vocab, num_merges):\n"
            "    merges = []\n"
            "    v = dict(vocab)\n"
            "    for _ in range(num_merges):\n"
            "        stats = get_stats(v)\n"
            "        if not stats:\n"
            "            break\n"
            "        best = max(sorted(stats), key=lambda p: stats[p])\n"
            "        merges.append(best)\n"
            "        v = merge_vocab(best, v)\n"
            "    return merges\n"
        ),
        "test_cases": [
            {"name": "统计·un 对频次", "expression": "get_stats(VOCAB)[('u', 'n')]", "hidden": False, "weight": 10},
            {"name": "统计·ug 对频次", "expression": "get_stats(VOCAB)[('u', 'g')]", "hidden": False, "weight": 10},
            {"name": "合并·一步之后的词形", "expression": "sorted(merge_vocab(('u', 'g'), VOCAB))[1]", "hidden": False, "weight": 10},
            {"name": "学习·第一次合并（应与教材一致）", "expression": "learn_bpe(VOCAB, 1)", "hidden": False, "weight": 10},
            {"name": "私榜·前三次合并顺序", "expression": "learn_bpe(VOCAB, 3)", "hidden": True, "weight": 15},
            {"name": "私榜·五次合并", "expression": "learn_bpe(VOCAB, 5)", "hidden": True, "weight": 15},
            {"name": "私榜·合并耗尽提前停", "expression": "len(learn_bpe({'a b </w>': 1}, 10))", "hidden": True, "weight": 15},
            {"name": "私榜·并列取字典序最小", "expression": "learn_bpe({'a b </w>': 2, 'c d </w>': 2}, 1)", "hidden": True, "weight": 15},
        ],
        "pass_score": 60,
        "excellent_score": 85,
    },
    {
        "project_id": "llm-p3",
        "level": "L3",
        "level_note": "求职级（学完第 2 章 + 有志于算法岗）：手写 GPT 前向传播是大厂面试的白板真题",
        "title": "L3 项目：手搓迷你 GPT 前向传播",
        "brief_md": (
            "不借任何框架，把第 2 章的全部组件串成一次完整的 GPT 前向传播：给一串 token，"
            "算出下一个 token。这是面试白板题的完整版。\n\n"
            "**任务**（词表 4 个 token，嵌入表 `EMB` 已内置，维度 d=2）：\n\n"
            "1. `softmax(xs)`：数值稳定版（先减最大值），每维 round 4 位\n"
            "2. `causal_attn(X)`：因果自注意力——Q=K=V=X，缩放点积（除以 √d），"
            "位置 i 只看 0..i，输出每维 round 4 位\n"
            "3. `gpt_next(emb, seq)`：完整前向——查表得 X → `causal_attn` → 残差相加（末位置）→ "
            "与每个词嵌入点积得 logits → 返回 argmax 的 token id（并列取小 id）\n\n"
            "**评分**：公开 40 / 私榜 60；≥60 结业，≥85 优秀。\n\n"
            "**开放部分（真机，求职作品集）**：见下方验收清单。"
        ),
        "dataset_name": "迷你嵌入表（vocab=4, d=2）",
        "dataset_code": _GPT_DATASET,
        "starter_code": (
            "import math\n\n\n"
            "def softmax(xs):\n"
            "    \"\"\"数值稳定 softmax，每维 round 4 位\"\"\"\n"
            "    pass\n\n\n"
            "def causal_attn(X):\n"
            "    \"\"\"因果自注意力（Q=K=V=X，除以 sqrt(d)，只看 0..i），每维 round 4 位\"\"\"\n"
            "    pass\n\n\n"
            "def gpt_next(emb, seq):\n"
            "    \"\"\"完整前向：embed -> causal_attn -> 末位残差 -> logits -> argmax id\"\"\"\n"
            "    pass\n"
        ),
        "solution_code": (
            "import math\n\n\n"
            "def softmax(xs):\n"
            "    m = max(xs)\n"
            "    exps = [math.exp(x - m) for x in xs]\n"
            "    s = sum(exps)\n"
            "    return [round(e / s, 4) for e in exps]\n\n\n"
            "def causal_attn(X):\n"
            "    d = len(X[0])\n"
            "    out = []\n"
            "    for i in range(len(X)):\n"
            "        scores = [sum(a * b for a, b in zip(X[i], X[j])) / math.sqrt(d) for j in range(i + 1)]\n"
            "        m = max(scores)\n"
            "        exps = [math.exp(s - m) for s in scores]\n"
            "        tot = sum(exps)\n"
            "        w = [e / tot for e in exps]\n"
            "        vec = [sum(w[j] * X[j][k] for j in range(i + 1)) for k in range(d)]\n"
            "        out.append([round(v, 4) for v in vec])\n"
            "    return out\n\n\n"
            "def gpt_next(emb, seq):\n"
            "    X = [list(emb[t]) for t in seq]\n"
            "    H = causal_attn(X)\n"
            "    h = [a + b for a, b in zip(H[-1], X[-1])]\n"
            "    logits = [sum(h[k] * emb[t][k] for k in range(len(h))) for t in range(len(emb))]\n"
            "    best = 0\n"
            "    for t in range(1, len(emb)):\n"
            "        if logits[t] > logits[best]:\n"
            "            best = t\n"
            "    return best\n"
        ),
        "test_cases": [
            {"name": "softmax·基础", "expression": "softmax([1.0, 2.0, 3.0])", "hidden": False, "weight": 10},
            {"name": "softmax·全相等", "expression": "softmax([5.0, 5.0])", "hidden": False, "weight": 10},
            {"name": "注意力·首位置只看自己", "expression": "causal_attn([[1.0, 0.0], [0.0, 1.0]])[0]", "hidden": False, "weight": 10},
            {"name": "注意力·第二位置", "expression": "causal_attn([[1.0, 0.0], [0.0, 1.0]])[1]", "hidden": False, "weight": 10},
            {"name": "私榜·三位置注意力", "expression": "causal_attn([[0.1, 0.3], [0.5, 0.2], [0.4, 0.6]])[2]", "hidden": True, "weight": 15},
            {"name": "私榜·前向·短序列", "expression": "gpt_next(EMB, [0, 1])", "hidden": True, "weight": 15},
            {"name": "私榜·前向·换起点", "expression": "gpt_next(EMB, [3, 0, 2])", "hidden": True, "weight": 15},
            {"name": "私榜·前向·单 token", "expression": "gpt_next(EMB, [2])", "hidden": True, "weight": 15},
        ],
        "pass_score": 60,
        "excellent_score": 85,
        "open_ended_md": (
            "**真机部分（浏览器判不了，但求职作品集靠它）**：按教材第 5 章，"
            "在 Colab 或实验室 GPU 上预训练一个迷你中文 LLM（参照 Happy-LLM 第 5.3 节流程）。\n\n"
            "验收清单：\n"
            "- 训练损失曲线从初始值明显收敛（提交曲线截图）\n"
            "- 模型能生成可辨认的中文短句（提交 3 条生成样例）\n"
            "- 写 500 字训练笔记：你调了什么参数、遇到什么坑\n"
            "- 加分项：把模型和笔记放上 GitHub——这就是你简历里的项目经历"
        ),
    },
]

# ---------------------------------------------------------------- 人写脚手架：课程大纲
# 每课时：标题 / 检索查询 / 证据主块（人工锚定，检索只做补充）/ 教学焦点。
# 颗粒 10-15 分钟一课时。must_include 是脚手架哲学的延伸：大纲既然人工策展，
# 每课的证据主块也人工锚定——防 TF-IDF 把标题碎块排到前排饿死生成器。
COURSE_OUTLINES: dict[str, dict] = {
    "llm_basics": {
        "tagline": "从下一个词的概率到会听话的助手：亲手摸清大模型的每一层",
        "textbooks": ["Happy-LLM（Datawhale）", "Hello-Agents（Datawhale）", "从零构建大模型", "图解大模型：生成式AI原理与实战"],
        "lessons": [
            {
                "lesson_id": "llm-01",
                "title": "语言模型在做什么：下一个词的概率游戏",
                "query": "语言模型 N-gram 概率 下一个词 统计 稀疏",
                "must_include": ["ha03s01#s2", "ha03s01#s5", "hl01s02#s1", "hl01s04#s1"],
                "focus": "语言模型的本质=给词序列算概率、预测下一个词。从 N-gram 的数数思路讲起"
                         "（这是能手算的语言模型）；数据稀疏的困境严格按资料表述讲（未见过的组合概率"
                         "估计为 0、平滑只能缓解），神经网络方法只提『后续课程展开』一句，"
                         "不要描述其内部机制。开篇破掉『大模型=检索答案的数据库』这一误区。",
                "exercise": {
                    "function_name": "predict_next",
                    "hint": "实现 predict_next(words, prev)：统计词列表 words 中紧跟在 prev 后面出现"
                            "次数最多的词并返回（并列时返回字典序最小的；prev 未出现返回空串）。"
                            "这就是一个最小的 bigram 语言模型。",
                },
            },
            {
                "lesson_id": "llm-02",
                "title": "分词：把文字变成模型认识的数字",
                "query": "分词 tokenizer BPE 子词 词表",
                "must_include": ["ha03s02#s5", "ha03s02#s6", "ha03s02#s7", "hl05s02#s1"],
                "focus": "模型只认数字：文本→token 的转换是一切的第一步。讲清为什么不能简单按字/按词切，"
                         "BPE 的合并思想（高频对逐步合并成子词）与词表的作用。",
                "exercise": {
                    "function_name": "merge_pair",
                    "hint": "实现 merge_pair(tokens, pair)：在 token 列表中把所有相邻的 pair=(a,b) "
                            "合并成一个新 token a+b（一次遍历、不重叠合并），返回新列表——这是 BPE 的一步。",
                },
            },
            {
                "lesson_id": "llm-03",
                "title": "嵌入：意思的几何学",
                "query": "词向量 嵌入 语义 相似度 word2vec 文本表示",
                "must_include": ["ha03s01#s6", "hl01s04#s1"],
                "focus": "向量距离=语义远近这一核心直觉。文本表示的演进严格按资料脉络讲：One-Hot 稀疏且"
                         "无语义 → 向量空间模型用 TF-IDF 等权重反映重要程度、但基于独立性假设并不捕捉语义"
                         "（这是它的局限，不是目的）→ 词嵌入才让语义相近的词向量彼此接近。"
                         "严禁把『让相似词更接近』说成 VSM 的机制或动机。"
                         "King-Man+Woman≈Queen 例子作收尾；不写『下一课预告』，不提注意力机制。",
                "exercise": {
                    "function_name": "most_similar",
                    "hint": "实现 most_similar(word_vecs, query_vec)：word_vecs 是 {词: 向量列表} 字典，"
                            "返回与 query_vec 余弦相似度最高的词（并列取字典序最小）。用 math.sqrt 手写余弦。",
                },
            },
            {
                "lesson_id": "llm-04",
                "title": "注意力：让每个词看见彼此",
                "query": "注意力机制 QKV 缩放点积 softmax",
                "must_include": ["hl02s01#s1", "ha03s01#s11"],
                "focus": "注意力=可学习的加权求和：Q 问、K 答、V 供货的类比；缩放点积 + softmax 的每一步"
                         "都要讲到能手算。破掉『注意力是显式规则匹配』的误区。",
                "interactive_embed": {
                    "name": "Transformer Explainer（佐治亚理工 Poloclub）",
                    "url": "https://poloclub.github.io/transformer-explainer/",
                    "license_note": "MIT 许可，官方在线版",
                    "guide": "在教具里输入一句话，观察注意力矩阵：哪个词在看哪个词？调大温度看分布变化。",
                },
                "exercise": {
                    "function_name": "attention",
                    "hint": "实现 attention(q, keys, values)：q 是向量，keys/values 是向量列表。"
                            "点积算分→除以 math.sqrt(len(q))→softmax 得权重→对 values 加权求和，"
                            "结果每维保留 4 位小数（round）。全部用纯 Python 列表。",
                },
            },
            {
                "lesson_id": "llm-05",
                "title": "Transformer 全景：块的堆叠",
                "query": "Transformer Encoder Decoder 位置编码 残差 Decoder-Only GPT",
                "must_include": ["hl02s02#s1", "hl02s03#s1", "hl03s03#s1", "ha03s01#s14"],
                "focus": "把第 4 课的注意力放进整体架构：位置编码为什么必须有、Encoder/Decoder 分工、"
                         "GPT 为什么选 Decoder-Only。结构图式讲解，不逐层推公式。",
                "exercise": {
                    "function_name": "positional_encoding",
                    "hint": "实现 positional_encoding(pos, d_model)：按正弦位置编码公式返回长度为 d_model "
                            "的列表（偶数维 sin、奇数维 cos，频率 10000**(2i/d_model)），每维 round 到 4 位小数。",
                },
            },
            {
                "lesson_id": "llm-06",
                "title": "预训练：在海量文本里学会世界",
                "query": "预训练 自回归 损失 缩放法则 幻觉",
                "must_include": ["hl04s02#s1", "hl06s01#s1", "ha03s03#s2", "ha03s03#s3"],
                "focus": "预训练=在下一个词预测上最小化损失；缩放法则讲清『大』的来历；"
                         "顺势讲清幻觉的根源（概率补全而非事实检索）——这是本平台溯源设计的理论出发点。",
                "exercise": {
                    "function_name": "cross_entropy",
                    "hint": "实现 cross_entropy(probs, target_index)：probs 是模型给各候选词的概率列表，"
                            "返回 -math.log(probs[target_index])，round 4 位小数。再想想：模型猜得越准，损失越小。",
                },
            },
            {
                "lesson_id": "llm-07",
                "title": "对齐：从会说话到听话",
                "query": "有监督微调 SFT 指令 偏好对齐 RLHF 强化学习",
                "must_include": ["hl06s02#s1", "hl06s04#s1", "hl04s02#s1"],
                "focus": "预训练模型只会补全不会听话：SFT 教格式、偏好对齐教取舍的两步曲；"
                         "InstructGPT 的故事线（视频引子）。讲清对话模板这个工程细节为什么重要。",
                "video_intro": {
                    "bvid": "BV1hd4y187CR",
                    "title": "InstructGPT 论文逐段精读",
                    "account": "跟李沐学AI",
                    "uid": "1567748478",
                    "duration_hint": "67min（建议先看前 10 分钟动机部分）",
                },
                "exercise": {
                    "function_name": "build_chat_prompt",
                    "hint": "实现 build_chat_prompt(messages)：把 [{'role':'system'/'user'/'assistant','content':…}] "
                            "格式化为对话模板字符串：每条 '<|role|>\\ncontent\\n'，最后追加 '<|assistant|>\\n'。"
                            "这就是 SFT 喂给模型的真实样子。",
                },
            },
            {
                "lesson_id": "llm-08",
                "title": "采样与推理：为什么每次答案不一样",
                "query": "温度 采样 Top-k Top-p 生成 参数",
                "must_include": ["ha03s02#s2", "ha03s02#s3", "hl04s01#s1"],
                "focus": "生成不是查表：温度如何压平/锐化分布、Top-k 与 Top-p 的取舍；"
                         "把『为什么同一问题两次答案不同』讲成推理参数的直接后果。",
                "exercise": {
                    "function_name": "top_p_filter",
                    "hint": "实现 top_p_filter(probs, p)：probs 是 {词: 概率} 字典。按概率从大到小累加，"
                            "保留累计首次 ≥p 的最小集合，重新归一化后返回字典（概率 round 4 位小数；"
                            "并列概率按词字典序排序保证确定性）。",
                },
            },
        ],
    },
    "rag": {
        "tagline": "让模型带着证据说话：从检索到可验证问答的完整闭环",
        "lessons": [
            {
                "lesson_id": "rag-01",
                "title": "为什么需要检索增强：LLM 的记忆边界",
                "query": "为何智能体需要记忆与RAG 无状态 对话遗忘 内置知识局限",
                "must_include": ["ha08s01#s1", "ha08s01#s2", "ha08s03#s2"],
                "focus": "以资料 8.1.2 为主轴讲清问题本身：LLM 的两个根本性局限（无状态导致的"
                         "对话遗忘、内置知识的局限），再以 8.3.1 引出 RAG 是什么。"
                         "第一课建立直觉、类比先行；只陈述资料里明确写到的局限，不自行扩充清单。",
            },
            {
                "lesson_id": "rag-02",
                "title": "RAG 工作流：从文档到向量库",
                "query": "MarkItDown 文档转换 Markdown 智能分块 Token 向量化 索引",
                "must_include": ["ha08s03#s5", "ha08s03#s6", "ha08s03#s7", "ha08s03#s11", "ha08s03#s12"],
                "focus": "按资料 8.3.4 的数据处理流程拆解：统一文档转换（MarkItDown）→ 保留结构的"
                         "智能分块（Markdown 段落 + Token 控制）→ 向量化与索引。每步讲清"
                         "『做什么/为什么』，坑与设计动机以资料明确写到的为准。",
            },
            {
                "lesson_id": "rag-03",
                "title": "检索质量：查询扩展与假设文档嵌入",
                "query": "多查询扩展 MQE 假设文档嵌入 HyDE 检索策略 召回",
                "must_include": ["ha08s03#s13", "ha08s03#s14", "ha08s03#s16", "ha08s02#s18"],
                "focus": "检索不好，生成再强也没用。以资料 8.3.5 为主轴：用词差异导致漏检的问题，"
                         "多查询扩展（MQE）与假设文档嵌入（HyDE）两种互补策略的原理与适用场景，"
                         "以及多路结果的合并排序。",
            },
            {
                "lesson_id": "rag-04",
                "title": "端到端实战：构建 PDF 文档问答助手",
                "query": "PDF 文档问答助手 案例 RAGTool MemoryTool 智能问答",
                "must_include": ["ha08s04#s2", "ha08s04#s3", "ha08s04#s6", "ha08s04#s8"],
                "focus": "以资料 8.4 案例把前三课串成完整应用：文档加载与处理 → 高级检索问答"
                         "（ask 方法）→ 记忆与学习功能。结尾点出『答案来自检索到的文档片段，"
                         "所以可核对来源』这一 RAG 的可验证性价值（以资料为限，不外推）。",
            },
        ],
    },
}

# ---------------------------------------------------------------- 结业微项目（人工策展 + 机器验证）
# 测评是产品的命门：微项目由人工编写保证质量，入库前仍过机器验证（solution 全过、starter 必挂）。
CAPSTONE_DATASET_TANGSHI = '''CORPUS = [
    "床前明月光", "疑是地上霜", "举头望明月", "低头思故乡",
    "春眠不觉晓", "处处闻啼鸟", "夜来风雨声", "花落知多少",
    "白日依山尽", "黄河入海流", "欲穷千里目", "更上一层楼",
    "红豆生南国", "春来发几枝", "愿君多采撷", "此物最相思",
    "空山不见人", "但闻人语响", "返景入深林", "复照青苔上",
]'''

CAPSTONES: dict[str, dict] = {
    "llm_basics": {
        "title": "结业微项目：唐诗接龙机——你的第一个语言模型",
        "brief_md": (
            "用整门课学到的『下一个词的概率游戏』，从零实现一个**字符级 bigram 语言模型**，"
            "让它学会接唐诗。这就是 GPT 的极简祖先：统计、预测、生成，一个都不少。\n\n"
            "**任务**（数据集 `CORPUS` 已内置，20 句公版五言诗）：\n\n"
            "1. `build_model(corpus)`：统计每句诗内相邻字对，返回 `{字: {后继字: 次数}}`\n"
            "2. `predict_next(model, ch)`：返回 `ch` 最高频的后继字；并列取 Unicode 序最小者；"
            "`ch` 无后继或未见过时返回空串 `''`\n"
            "3. `generate(model, start, length)`：从 `start` 开始贪心接龙——每步取 `predict_next` 的结果"
            "追加到末尾，直到总长度达到 `length` 或无后继可接，返回生成的字符串\n\n"
            "**评分（Kaggle 形制）**：公开用例 40 分（实时可见），私榜用例 60 分（交卷揭晓）；"
            "≥60 结业，≥85 优秀。全部确定性判分，不含随机。"
        ),
        "dataset_name": "唐诗二十句（公版）",
        "dataset_code": CAPSTONE_DATASET_TANGSHI,
        "starter_code": (
            "def build_model(corpus):\n"
            "    \"\"\"统计每句内相邻字对 -> {字: {后继字: 次数}}\"\"\"\n"
            "    pass\n\n\n"
            "def predict_next(model, ch):\n"
            "    \"\"\"最高频后继字；并列取 Unicode 序最小；无后继返回 ''\"\"\"\n"
            "    pass\n\n\n"
            "def generate(model, start, length):\n"
            "    \"\"\"贪心接龙到 length 长或无后继\"\"\"\n"
            "    pass\n"
        ),
        "solution_code": (
            "def build_model(corpus):\n"
            "    model = {}\n"
            "    for line in corpus:\n"
            "        for a, b in zip(line, line[1:]):\n"
            "            model.setdefault(a, {})\n"
            "            model[a][b] = model[a].get(b, 0) + 1\n"
            "    return model\n\n\n"
            "def predict_next(model, ch):\n"
            "    followers = model.get(ch)\n"
            "    if not followers:\n"
            "        return ''\n"
            "    return max(sorted(followers), key=lambda k: followers[k])\n\n\n"
            "def generate(model, start, length):\n"
            "    out = start\n"
            "    while len(out) < length:\n"
            "        nxt = predict_next(model, out[-1])\n"
            "        if not nxt:\n"
            "            break\n"
            "        out += nxt\n"
            "    return out\n"
        ),
        "test_cases": [
            {"name": "统计·明的后继", "expression": "build_model(CORPUS)['明']", "hidden": False, "weight": 10},
            {"name": "统计·春来成对", "expression": "build_model(CORPUS)['春']['来']", "hidden": False, "weight": 10},
            {"name": "预测·月之后", "expression": "predict_next(build_model(CORPUS), '月')", "hidden": False, "weight": 10},
            {"name": "预测·未见过的字", "expression": "predict_next(build_model(CORPUS), '龙')", "hidden": False, "weight": 10},
            {"name": "私榜·床字开头接五言", "expression": "generate(build_model(CORPUS), '床', 5)", "hidden": True, "weight": 10},
            {"name": "私榜·春字并列决胜", "expression": "generate(build_model(CORPUS), '春', 4)", "hidden": True, "weight": 10},
            {"name": "私榜·无后继提前停", "expression": "generate(build_model(CORPUS), '空', 10)", "hidden": True, "weight": 10},
            {"name": "私榜·长度截断", "expression": "generate(build_model(CORPUS), '白', 3)", "hidden": True, "weight": 10},
            {"name": "私榜·跨诗句接龙", "expression": "generate(build_model(CORPUS), '相', 6)", "hidden": True, "weight": 10},
            {"name": "私榜·并列取序最小", "expression": "predict_next(build_model(CORPUS), '不')", "hidden": True, "weight": 10},
        ],
        "pass_score": 60,
        "excellent_score": 85,
    },
}

# 生成拆两次调用：strong 模型吞吐 ~15 tok/s，单次大 JSON 会顶超时（探针实测）
GENERATE_SECTIONS_SYSTEM = """你是一名课程作者，为中文 AI 学习平台「学径」编写一个 10-15 分钟图文课时的正文。

铁律（违反任何一条即废稿）：
1. 只使用【资料】里给出的内容写作，禁止引入资料之外的事实、数字、API 名称。
2. 正文每个自然段末尾必须带引用标记，格式形如 [ha08s02#s3]，只能用资料里出现的 source_id；一个段落可有多个标记。
3. 语言面向会 Python 但不懂本主题的大学生：类比先行、短句、不堆术语；术语首次出现给一句白话解释。
4. 规避以下常见误区（不要在正文里犯，可在合适处主动纠正）：{misconceptions}
5. 具体参数数值（Token 数、条数、比例等）只能用资料里出现的数字，资料只给参数名就别编数值；
   示意性举例用「比如/假设」标明；不得把资料没写的机制细节说成系统行为。

只输出一个 JSON 对象：
{{
  "objectives": ["学完能……", 2-3 条，动词开头],
  "estimated_minutes": 12,
  "sections": [{{"heading": "小节标题", "body_md": "markdown 正文，每段末尾带 [source_id] 标记"}}, 3 个，每小节 2-3 段]
}}"""

GENERATE_ACTIVITIES_SYSTEM = """你是课程作者，为下面这篇已定稿的课时正文配套学习活动。

铁律：
1. 只基于【正文】与【资料】出题/取材，source_id 只能用资料里出现的。
2. 选择题干扰项要似是而非（考概念辨析，不考死记）；explanation 说明为什么对、为什么错。
3. 动手任务不假设任何云环境：本地/Colab 均可完成的最小任务 + 明确验收标准。

只输出一个 JSON 对象：
{{
  "check_understanding": [{{"question": "…", "options": ["…","…","…"], "answer_index": 0, "explanation": "…", "source_ids": ["…"]}}, 2 题],
  "key_terms": [{{"term": "…", "definition": "一句白话", "source_id": "…"}}, 3 条],
  "hands_on": {{"title": "…", "instructions_md": "…", "acceptance_criteria": ["…","…"], "colab_hint": "…"}}
}}"""

JUDGE_SYSTEM = """你是独立的内容审核员。逐一判断【待审正文】每个小节的事实性陈述是否被【资料全集】支持
（对照全集判断，不要求陈述恰好出现在某个特定小节所引的块里）。

只审核【事实性/机制性陈述】：技术如何工作、系统怎么做、参数数值、结论性论断。
以下情况【不算】缺乏依据，不要打回：
- 明显的类比与比喻（「就像…」「相当于…」）；
- 以「比如/例如/假设」引出的示意性举例（含虚构的示例问题、示例查询、示例数字），
  只要它演示的机制本身在资料里有依据；
- 衔接语、学习建议、对读者的引导语；
- 不构成具体技术断言的常识性铺垫语（如「关系可能隐含在句子里」「命名方式可能多样」）——
  这类宽泛表述不是机制细节。

打回标准：把资料没写的【具体】技术断言当成事实——算法步骤、机制原理、性能/优劣结论、
历史事实、具体产品或数字。判断标准：这句话若出现在教科书里需要引文吗？需要才打回。

只输出 JSON：
{"verdicts": [{"heading": "小节标题", "supported": true, "problem": ""}, ...]}
supported=false 时必须在 problem 里指出具体哪句话缺乏依据。"""

FINAL_QUIZ_SYSTEM = """你是课程出题人。基于【资料】为整门课出 {n} 道结业选择题，覆盖不同课时主题，
考概念辨析与应用判断（不考死记原文）。只输出 JSON：
{{"questions": [{{"question": "…", "options": ["…","…","…"], "answer_index": 0,
"explanation": "…", "source_ids": ["…"]}}]}}
source_ids 只能用资料里出现的 source_id。"""

# ---------------------------------------------------------------- 学期课 v2：重编排扩写
REWRITE_PART_SYSTEM = """你是大学教材作者，把【资料】重新编排成零基础本科生（大一即可入门）能学透的
45 分钟课时讲义的{part_label}。这不是摘要！是教材级重编排：

铁律：
1. 【全覆盖】本篇负责的资料内容一个知识点都不许丢：概念、公式、代码、例子全部讲到。
   资料厚就写长，篇幅不设上限——内容多是加课时解决的，轮不到你删。
2. 【零基础改写】每个概念先给生活类比或直觉，再上正式定义；公式必须配一步步手算示例
   （数字自己设，用「比如/假设」标明）；资料里的代码要逐段解释给没读过源码的人听
   （代码块可从资料摘录，加中文逐行/逐段讲解）。
3. 【只用资料】事实、公式、机制、数字只能来自【资料】；每个自然段末尾带引用标记，
   格式形如 [hl01s02#s1]（方括号里直接放 id，不要写 source_id: 前缀；只能用资料里出现的 id）。
   类比、手算示例、讲解语言是你的自由发挥空间。
4. 规避误区：{misconceptions}
5. 【穿插检查题】每 2-3 个小节后配一道选择题（考理解不考记忆），
   after_section 填它应出现在第几小节之后（本篇内 0 起编号）。
6. 【宁浅勿编】某个话题资料只给了一句概述时，你也只写概述并注明「后续课程详解」；
   禁止自行补全资料没写的机制细节、算法步骤、对比结论——扩写的是讲解方式，不是知识本身。
7. 【数字与术语铁律】你记忆里关于这个主题的常识（具体数值、token id、参数量、训练步数、
   组件名称、嵌入种类等）一律视为不可信：凡具体数字与专有名词，必须能在【资料】里逐字找到，
   否则不写。资料给的数字照抄，禁止换算、近似或「远超/仅为」式的量级评价（除非资料原话如此）。

只输出一个 JSON 对象：
{{
{objectives_field}  "sections": [{{"heading": "小节标题", "body_md": "markdown 正文，段末带形如 [hl01s02#s1] 的引用标记"}}, 3-4 个，每小节 4-7 段],
  "checks": [{{"question": "…", "options": ["…","…","…","…"], "answer_index": 0, "explanation": "…", "source_ids": ["…"], "after_section": 1}}, 1-2 题]{key_terms_field}
}}"""

THEORY_EXAM_SYSTEM = """你是结业理论卷出题人（求职面试口径）。基于【面试题库资料】出 {n} 道单选题：
1. 只考资料里明确讲到的知识点；explanation 引资料原意说明为什么对、为什么错。
2. 干扰项要似是而非（真实面试的迷惑水平），不出送分题。
3. 每题 source_ids 填其依据的资料块 id（形如 iv003）。
只输出 JSON：
{{"questions": [{{"question": "…", "options": ["…","…","…","…"], "answer_index": 0,
"explanation": "…", "source_ids": ["iv003"]}}]}}"""

GENERATE_EXERCISE_SYSTEM = """你是编程判题题作者，为一个课时配一道 LeetCode 式 Python 练习（浏览器内运行）。

铁律：
1. 只可用 Python 标准库（顶多 import math），禁止 numpy/torch/网络/文件/随机数。
2. 题目考察本课时的核心机制，函数名与任务方向按【题目规格】给定；难度=会 Python 的新手 15 分钟内可完成。
3. starter_code 给函数签名 + docstring + `pass`（或留 TODO 的骨架），不能直接通过用例。
4. solution_code 是完整正确实现（这是判分标准的来源，务必正确、确定性、无随机）。
5. test_cases 给 4-6 个：从简单到边界，expression 是对函数的一次调用（可含字面量数据），
   覆盖典型/边界/易错情形；不要写 expected（期望值由系统执行 solution 自动回填）。
6. prompt_md 说清任务、输入输出约定，并给 1 个手算示例。

只输出 JSON：
{{
  "title": "…",
  "prompt_md": "…",
  "function_name": "按规格",
  "starter_code": "def …",
  "solution_code": "def …",
  "test_cases": [{{"name": "基础", "expression": "func(…)", "hidden": false}}, …最后 1-2 个 hidden=true],
  "hints": ["…", 1-2 条]
}}"""


# ---------------------------------------------------------------- 判题执行（引擎侧机器验证）


def _exec_and_eval(code: str, expressions: list[str], preamble: str = "") -> list[tuple[bool, str]]:
    """执行代码后逐表达式求值。返回 [(成功求值, repr 或错误)]。自产代码，引擎侧可信执行。"""
    import math

    ns: dict = {"math": math}
    try:
        exec(preamble + "\n" + code, ns)  # noqa: S102
    except Exception as e:  # noqa: BLE001
        return [(False, f"代码执行失败 {type(e).__name__}: {e}")] * len(expressions)
    out = []
    for expr in expressions:
        try:
            out.append((True, repr(eval(expr, ns))))  # noqa: S307
        except Exception as e:  # noqa: BLE001
            out.append((False, f"{type(e).__name__}: {e}"))
    return out


def _backfill_and_verify_exercise(ex: dict, preamble: str = "") -> list[str]:
    """期望值回填 + 双向门禁：solution 全过（回填 expected_repr），starter 至少挂一个。
    返回问题列表（空=通过）。"""
    problems: list[str] = []
    exprs = [c["expression"] for c in ex.get("test_cases", [])]
    if len(exprs) < 3:
        return ["用例少于 3 个"]
    sol = _exec_and_eval(ex.get("solution_code", ""), exprs, preamble)
    for case, (ok, got) in zip(ex["test_cases"], sol):
        if not ok:
            problems.append(f"参考答案在用例「{case.get('name')}」上失败：{got}")
        else:
            case["expected_repr"] = got
    if problems:
        return problems
    starter = _exec_and_eval(ex.get("starter_code", ""), exprs, preamble)
    if all(ok and got == case["expected_repr"] for case, (ok, got) in zip(ex["test_cases"], starter)):
        problems.append("starter_code 直接通过全部用例（题目形同虚设），请让骨架留空实现")
    for banned in ("import numpy", "import torch", "open(", "import os", "import random"):
        if banned in ex.get("solution_code", "") + ex.get("starter_code", ""):
            problems.append(f"出现禁用内容：{banned}")
    return problems


def _chunks_block(chunks) -> str:
    parts = []
    for c in chunks:
        parts.append(f"### source_id: {c.source_id}｜{c.title}\n{c.content[:1500]}")
    return "\n\n".join(parts)


_CITATION_PREFIX_RE = re.compile(r"\[\s*source_id\s*[:：]\s*([a-z]{2}\d{2}s\d{2}#s\d+)\s*\]")


def _validate_citations(lesson_json: dict, allowed: set[str]) -> list[str]:
    """引用门禁：返回问题列表（空=通过），并把 sections 的 source_ids 归一化。"""
    problems: list[str] = []
    for sec in lesson_json.get("sections", []):
        body = sec.get("body_md", "")
        if isinstance(body, list):  # 模型偶发输出段落数组
            body = "\n\n".join(str(x) for x in body)
        # 容错归一化：[source_id: X] → [X]（模型偶发把占位符名当标签写出来）
        sec["body_md"] = _CITATION_PREFIX_RE.sub(r"[\1]", str(body))
        marks = CITATION_RE.findall(sec.get("body_md", ""))
        bad = [m for m in marks if m not in allowed]
        if bad:
            problems.append(f"小节「{sec.get('heading')}」引用了不在资料集内的 source_id：{bad}")
        if not marks:
            problems.append(f"小节「{sec.get('heading')}」没有任何引用标记")
        sec["source_ids"] = list(dict.fromkeys(marks))
    for q in lesson_json.get("check_understanding", []) or []:
        q["source_ids"] = [s for s in (q.get("source_ids") or []) if s in allowed]
    for t in lesson_json.get("key_terms", []) or []:
        if t.get("source_id") not in allowed:
            t["source_id"] = ""
    return problems


def _judge_lesson(gateway: LLMGateway, lesson_json: dict, chunks_by_id: dict) -> tuple[int, list[str]]:
    """judge 逐小节复核；返回 (supported 数, notes)。judge 不可用时返回 (-1, note)。

    判定对照【本课资料全集】而非各小节所引块：引用挂错块由引用门禁与运行时审核管，
    生产期 judge 只回答一个问题——这句话是不是编的（语料里根本没有）。
    """
    corpus = "\n\n".join(f"[{sid}] {c.content[:1400]}" for sid, c in chunks_by_id.items())
    blocks = [f"## 小节：{sec['heading']}\n{sec['body_md']}" for sec in lesson_json["sections"]]
    user = f"【资料全集】\n{corpus}\n\n【待审正文】\n" + "\n\n---\n\n".join(blocks)
    result = gateway.structured_chat(
        "ContentAuditAgent", JUDGE_SYSTEM, user, max_tokens=1600,
    )
    if not result or "verdicts" not in result:
        return -1, ["judge 复核不可用（网络/解析失败），本课时未获独立复核"]
    notes = [f"「{v.get('heading')}」：{v.get('problem')}" for v in result["verdicts"] if not v.get("supported")]
    supported = sum(1 for v in result["verdicts"] if v.get("supported"))
    return supported, notes


MIN_CHUNK_CHARS = 300  # 标题/碎片块不配当证据：喂给生成器只会逼它编


def _load_index_chunks() -> dict:
    from backend.schemas.resources import KnowledgeChunk

    chunks = {}
    # 只取活块。这里按 source_id 建字典，归档块与活块同号——不过滤的话
    # 谁后读到谁赢，等于随机拿一份可能已经过期的正文去排课。
    from backend.rag.ingest import read_index_rows

    for d in read_index_rows(ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"):
        chunks[d["source_id"]] = KnowledgeChunk(**d)
    return chunks


def build_lesson(gateway: LLMGateway, concept: str, spec: dict, misconceptions: list[str]) -> Lesson:
    # 证据主块人工锚定 + 检索补充（过滤碎块），上限 9 块
    index = _load_index_chunks()
    chunks = []
    for sid in spec.get("must_include", []):
        if sid not in index:
            raise SystemExit(f"{spec['lesson_id']}: must_include 里的 {sid} 不在知识库索引")
        chunks.append(index[sid])
    retrieved = get_retriever().search(spec["query"], concept_tags=[concept], top_k=16).retrieved_chunks
    seen = {c.source_id for c in chunks}
    for c in retrieved:
        if len(chunks) >= 9:
            break
        if c.source_id in seen or len(c.content) < MIN_CHUNK_CHARS:
            continue
        chunks.append(c)
        seen.add(c.source_id)
    if len(chunks) < 3:
        raise SystemExit(f"{spec['lesson_id']}: 可用资料不足（{len(chunks)}），检查 query/must_include")
    allowed = {c.source_id for c in chunks}
    chunks_by_id = {c.source_id: c for c in chunks}

    system = GENERATE_SECTIONS_SYSTEM.format(misconceptions="；".join(misconceptions) or "无")
    base_user = (
        f"课时标题：{spec['title']}\n教学焦点：{spec['focus']}\n\n【资料】\n{_chunks_block(chunks)}"
    )

    # 外层=judge 打回重写（生产线上的「辩论-修订」）；内层=引用门禁重写
    data: dict | None = None
    supported, notes = -1, ["未复核"]
    judge_feedback = ""
    for judge_round in range(2):
        user = base_user + judge_feedback
        last_problems: list[str] = []
        for attempt in range(2):
            data = gateway.structured_chat("ResourceGenerationAgent", system, user, max_tokens=2600, temperature=0.0)
            if data is None:
                raise SystemExit(f"{spec['lesson_id']}: 正文生成失败（LLM 路由不可用或解析失败）")
            last_problems = _validate_citations(data, allowed)
            if not last_problems:
                break
            user += "\n\n上一稿未过引用门禁，问题：" + "；".join(last_problems) + "\n请修正后重新输出完整 JSON。"
        if last_problems:
            raise SystemExit(f"{spec['lesson_id']}: 两稿均未过引用门禁：{last_problems}")

        supported, notes = _judge_lesson(gateway, data, chunks_by_id)
        if supported < 0 or supported == len(data["sections"]):
            break
        judge_feedback = (
            "\n\n上一稿被独立审核打回，问题：" + "；".join(notes)
            + "\n重写时确保每个事实性陈述都能在所引 source_id 的资料原文里找到依据；"
            "资料没写的内容宁可不写。"
        )
        print(f"[{spec['lesson_id']}] judge 打回第 {judge_round + 1} 稿：{notes}")
    if 0 <= supported < len(data["sections"]):
        raise SystemExit(f"{spec['lesson_id']}: 重写后仍未过 judge 复核：{notes}")

    body_digest = "\n\n".join(
        f"## {s['heading']}\n{s['body_md']}" for s in data["sections"]
    )
    activities = gateway.structured_chat(
        "ResourceGenerationAgent",
        GENERATE_ACTIVITIES_SYSTEM,
        f"【正文】\n{body_digest}\n\n【资料】\n{_chunks_block(chunks[:5])}",
        max_tokens=1600,
    )
    if activities is None:
        raise SystemExit(f"{spec['lesson_id']}: 活动生成失败")
    data.update(activities)
    _validate_citations(data, allowed)  # 归一化活动里的 source_ids（正文已过门禁）

    # 判题练习（LeetCode 形制）：LLM 出题+参考答案 → 机器回填期望值 + 双向门禁
    exercise = None
    if spec.get("exercise"):
        ex_spec = spec["exercise"]
        ex_user = (
            f"【题目规格】函数名：{ex_spec['function_name']}；任务方向：{ex_spec['hint']}\n\n"
            f"【课时正文】\n{body_digest[:3000]}"
        )
        ex_problems: list[str] = ["未生成"]
        for _ in range(2):
            ex_data = gateway.structured_chat(
                "ResourceGenerationAgent", GENERATE_EXERCISE_SYSTEM, ex_user, max_tokens=2000,
            )
            if ex_data is None:
                raise SystemExit(f"{spec['lesson_id']}: 判题练习生成失败")
            ex_data["function_name"] = ex_spec["function_name"]
            ex_problems = _backfill_and_verify_exercise(ex_data)
            if not ex_problems:
                break
            ex_user += "\n\n上一稿未过机器验证：" + "；".join(ex_problems) + "\n请修正后重新输出完整 JSON。"
        if ex_problems:
            raise SystemExit(f"{spec['lesson_id']}: 判题练习两稿均未过机器验证：{ex_problems}")
        ex_data["exercise_id"] = f"{spec['lesson_id']}-ex"
        exercise = GradedExercise(**ex_data)

    video = None
    if spec.get("video_intro"):
        v = spec["video_intro"]
        if not any(v["uid"] == acc["uid"] for acc in VIDEO_ACCOUNT_WHITELIST):
            raise SystemExit(f"{spec['lesson_id']}: 视频账号 uid {v['uid']} 不在白名单")
        video = VideoIntro(**v)
    embed = InteractiveEmbed(**spec["interactive_embed"]) if spec.get("interactive_embed") else None
    sections = [Section(**s) for s in data["sections"]]
    cited_secs = sum(1 for s in sections if s.source_ids)
    audit = LessonAudit(
        sections_total=len(sections),
        sections_supported=supported if supported >= 0 else 0,
        citation_coverage=round(cited_secs / len(sections), 3),
        judge_model=gateway.route_for("ContentAuditAgent").model,
        notes=notes,
    )
    if supported >= 0 and supported < len(sections):
        raise SystemExit(f"{spec['lesson_id']}: judge 复核未全过：{notes}")

    return Lesson(
        lesson_id=spec["lesson_id"],
        title=spec["title"],
        estimated_minutes=max(8, min(int(data.get("estimated_minutes", 12)), 15)),
        objectives=data["objectives"],
        video_intro=video,
        interactive_embed=embed,
        sections=sections,
        check_understanding=[CheckQuestion(**_debias_options(q, spec["lesson_id"])) for q in data["check_understanding"]],
        key_terms=[
            KeyTerm(**t)
            for t in data.get("key_terms", []) or []
            if (t.get("term") or "").strip() and (t.get("definition") or "").strip()
        ],
        hands_on=None if exercise else (HandsOn(**data["hands_on"]) if data.get("hands_on") else None),
        graded_exercise=exercise,
        audit=audit,
    )


def build_final_quiz(gateway: LLMGateway, lessons: list[Lesson], concept: str, n: int = 5) -> list[CheckQuestion]:
    retriever = get_retriever()
    all_ids: set[str] = set()
    blocks = []
    for lesson in lessons:
        ids = {sid for s in lesson.sections for sid in s.source_ids}
        all_ids |= ids
        chunks = [c for c in retriever.search(lesson.title, concept_tags=[concept], top_k=6).retrieved_chunks]
        blocks.append(_chunks_block([c for c in chunks if c.source_id in ids][:4]))
    data = gateway.structured_chat(
        "ResourceGenerationAgent", FINAL_QUIZ_SYSTEM.format(n=n), "【资料】\n" + "\n\n".join(blocks), max_tokens=2400,
    )
    if data is None:
        raise SystemExit("final_quiz 生成失败")
    questions = []
    for q in data.get("questions", [])[:n]:
        q["source_ids"] = [s for s in (q.get("source_ids") or []) if s in all_ids]
        questions.append(CheckQuestion(**_debias_options(q, f"{concept}-final")))
    if len(questions) < 3:
        raise SystemExit("final_quiz 少于 3 题")
    return questions


def build_course(concept: str) -> Course:
    graph = json.loads(CONCEPT_GRAPH.read_text(encoding="utf-8"))
    if concept not in graph or concept == "_meta":
        raise SystemExit(f"概念图中不存在：{concept}")
    if concept not in COURSE_OUTLINES:
        raise SystemExit(f"尚未为 {concept} 策展课程大纲（COURSE_OUTLINES）")
    meta, outline = graph[concept], COURSE_OUTLINES[concept]
    gateway = _build_gateway()
    if not gateway.is_enabled("ResourceGenerationAgent"):
        raise SystemExit('LLM 路由未启用：请先 $env:AGENT_GENERATION_MODE="api"（key 在 .env）')

    lessons = [build_lesson(gateway, concept, spec, meta.get("misconceptions", [])) for spec in outline["lessons"]]
    final_quiz = build_final_quiz(gateway, lessons, concept)

    capstone = None
    if concept in CAPSTONES:
        cap = json.loads(json.dumps(CAPSTONES[concept]))  # 深拷贝，回填不污染常量
        cap_problems = _backfill_and_verify_exercise(cap, preamble=cap["dataset_code"])
        if cap_problems:
            raise SystemExit(f"{concept}: 结业微项目未过机器验证：{cap_problems}")
        capstone = Capstone(**cap)

    course = Course(
        course_id=concept,
        title=meta["title"],
        tagline=outline.get("tagline", ""),
        difficulty=meta.get("difficulty", "L1"),
        prerequisites=meta.get("prerequisites", []),
        minutes_total=sum(lesson.estimated_minutes for lesson in lessons),
        generated_by=GeneratedBy(
            mode="api",
            generator_model=gateway.route_for("ResourceGenerationAgent").model,
            judge_model=gateway.route_for("ContentAuditAgent").model,
            date=date.today().isoformat(),
        ),
        lessons=lessons,
        final_quiz=final_quiz,
        capstone=capstone,
        textbooks=outline.get("textbooks", []),
    )
    print(f"[gateway] {gateway.telemetry_snapshot()}")
    _record_cost(concept, gateway, len(lessons))
    return course


# ---------------------------------------------------------------- 学期课 v2 生产

def _ordered_material(source_range: list[str], lesson_id: str) -> list:
    index = _load_index_chunks()
    chunks = []
    for sid in source_range:
        if sid not in index:
            raise SystemExit(f"{lesson_id}: source_range 里的 {sid} 不在知识库索引")
        if len(index[sid].content) >= 80:  # 跳过纯标题块
            chunks.append(index[sid])
    if len(chunks) < 2:
        raise SystemExit(f"{lesson_id}: 有效源文块不足")
    return chunks


def _gen_part(
    gateway: LLMGateway,
    lesson_id: str,
    title: str,
    focus: str,
    part_label: str,
    part_chunks: list,
    misconceptions: list[str],
    written_headings: list[str],
    include_objectives: bool,
    include_key_terms: bool,
    all_chunks: list | None = None,
) -> dict:
    """生成一篇（引用门禁 + judge 打回重写）。生成职责按篇分，
    门禁与 judge 对照【全课语料】——跨篇引用是合法的（切分边界不是知识边界）。"""
    lesson_chunks = all_chunks or part_chunks
    allowed = {c.source_id for c in lesson_chunks}
    chunks_by_id = {c.source_id: c for c in lesson_chunks}
    system = REWRITE_PART_SYSTEM.format(
        part_label=part_label,
        misconceptions="；".join(misconceptions) or "无",
        objectives_field='  "objectives": ["学完能……", 3-4 条，动词开头],\n' if include_objectives else "",
        key_terms_field=(
            ',\n  "key_terms": [{"term": "…", "definition": "一句白话", "source_id": "…"}, 3-5 条]'
            if include_key_terms else ""
        ),
    )
    prior = ("\n\n【前文已写小节】" + "；".join(written_headings)) if written_headings else ""
    base_user = f"课时标题：{title}\n教学焦点：{focus}{prior}\n\n【资料】\n{_chunks_block(part_chunks)}"

    data: dict | None = None
    judge_feedback = ""
    supported, notes = -1, ["未复核"]
    for round_i in range(3):  # judge 打回重写至多两轮（观测：残留问题逐轮收敛）
        # 观看者插话在每个生成回合开头吸收：改的是给生成器的指令，
        # 产物仍要过引用门禁 + 判官——人的意见能改方向，不能免检。
        human_notes = studio.take_feedback(lesson_id)
        if human_notes:
            base_user += (
                "\n\n【共建者插话】" + "；".join(human_notes)
                + "\n请在不违背资料的前提下参照调整；资料没有依据的意见不得采纳，也不许因此编造。"
            )
            studio.publish("feedback_absorbed", "generator",
                           lesson_id=lesson_id, part=part_label, notes=human_notes)
        user = base_user + judge_feedback
        studio.publish("part_generating", "generator",
                       lesson_id=lesson_id, part=part_label, round=round_i + 1)
        problems: list[str] = []
        for _ in range(3):
            data = gateway.structured_chat(
                "ResourceGenerationAgent", system, user, max_tokens=3600, temperature=0.0,
            )
            if data is None:
                raise SystemExit(f"{lesson_id}: {part_label} 生成失败")
            problems = _validate_citations(data, allowed)
            if not problems:
                break
            studio.publish("citation_gate_failed", "verifier",
                           lesson_id=lesson_id, part=part_label, problems=problems[:5])
            user += (
                "\n\n上一稿未过引用门禁：" + "；".join(problems)
                + f"\n本篇可用的 source_id 只有：{sorted(allowed)}，逐字照抄，别改前缀。"
                + "\n请修正后重新输出完整 JSON。"
            )
        if problems:
            raise SystemExit(f"{lesson_id}: {part_label} 多稿均未过引用门禁：{problems}")
        supported, notes = _judge_lesson(gateway, data, chunks_by_id)
        if supported < 0 or supported == len(data["sections"]):
            studio.publish("part_passed", "judge", lesson_id=lesson_id, part=part_label,
                           sections=len(data["sections"]),
                           supported=supported if supported >= 0 else None)
            break
        judge_feedback = (
            "\n\n上一稿被独立审核打回：" + "；".join(notes)
            + "\n重写时把被点名的句子直接删掉或改成资料原意；资料没写的宁可不写。"
        )
        print(f"[{lesson_id}·{part_label}] judge 打回：{notes}")
        studio.publish("judge_rejected", "judge", lesson_id=lesson_id, part=part_label,
                       round=round_i + 1, notes=[n[:300] for n in notes[:4]])
    if 0 <= supported < len(data["sections"]):
        raise SystemExit(f"{lesson_id}: {part_label} 重写后仍未过 judge：{notes}")
    data["_judge"] = (supported, notes)
    return data


def build_lesson_v2(gateway: LLMGateway, spec: dict, misconceptions: list[str],
                    strict_exercise: bool = True) -> Lesson:
    """45min 课时：源文顺序全覆盖，分篇扩写（概念篇/深入篇），检查题穿插。"""
    studio.publish("lesson_start", "planner",
                   lesson_id=spec["lesson_id"], title=spec["title"])
    chunks = _ordered_material(spec["source_range"], spec["lesson_id"])
    studio.publish("retrieval_ready", "retrieval",
                   lesson_id=spec["lesson_id"], chunks=len(chunks),
                   chars=sum(len(c.content) for c in chunks),
                   sources=[c.source_id for c in chunks][:12])
    total_chars = sum(len(c.content) for c in chunks)
    n_parts = spec.get("parts", 2)
    # 自适应分篇：料薄并成一篇；料厚按字数均衡切——防止某篇只分到引言碎块饿死生成器
    if total_chars < 4500 or len(chunks) < 4:
        n_parts = 1
    labels = ["上篇（直觉与概念）", "下篇（深入与实战）", "终篇（综合与展望）"]
    if n_parts == 1:
        part_defs = [("全篇", chunks)]
    else:
        target = total_chars / n_parts
        part_defs, cur, acc = [], [], 0
        for c in chunks:
            cur.append(c)
            acc += len(c.content)
            if acc >= target and len(part_defs) < n_parts - 1:
                part_defs.append((labels[len(part_defs)], cur))
                cur, acc = [], 0
        if cur:
            part_defs.append((labels[min(len(part_defs), 2)], cur))

    sections: list[Section] = []
    checks: list[CheckQuestion] = []
    objectives: list[str] = []
    key_terms: list[KeyTerm] = []
    total_supported = 0
    all_notes: list[str] = []
    for pi, (label, seg) in enumerate(part_defs):
        data = _gen_part(
            gateway, spec["lesson_id"], spec["title"], spec["focus"], label, seg,
            misconceptions, [s.heading for s in sections],
            include_objectives=(pi == 0),
            include_key_terms=(pi == len(part_defs) - 1),
            all_chunks=chunks,
        )
        # 源块按字数分篇时，下篇常与上篇覆盖同一批子主题（源文本身就把训练循环走两遍：
        # 先概念后代码），于是同一 heading 在一课里出现两次（llm5-07/llm5-08 踩过）。
        # 两节正文不同、都是有效内容——不能删，改名消歧：后出现的挂上本篇标签的短签。
        seen_headings = {s.heading.strip() for s in sections}
        tag = "深入" if "深入" in label else ("综合" if "综合" in label else "续")
        offset = len(sections)
        for s in data["sections"]:
            h = (s.get("heading") or "").strip()
            if h and h in seen_headings:
                s["heading"] = f"{h}（{tag}）"
                print(f"  ⚠ {spec['lesson_id']} {label}：小节「{h[:20]}」与前篇同名，改为「…（{tag}）」")
            seen_headings.add(s.get("heading", "").strip())
            sections.append(Section(**s))
        for q in data.get("checks", []) or []:
            pos = q.get("after_section", -1)
            q["after_section"] = offset + pos if 0 <= pos < len(data["sections"]) else -1
            if 0 <= q.get("answer_index", 0) < len(q.get("options", [])):
                checks.append(CheckQuestion(**_debias_options(q, spec["lesson_id"])))
        if pi == 0:
            objectives = data.get("objectives", []) or [f"掌握{spec['title']}的核心内容", "能独立完成本课判题练习"]
        # 生成器偶发吐空词条（term/definition 缺失或空串），过滤而非崩管线
        key_terms += [
            KeyTerm(**t)
            for t in data.get("key_terms", []) or []
            if (t.get("term") or "").strip() and (t.get("definition") or "").strip()
        ]
        sup, notes = data["_judge"]
        total_supported += sup if sup >= 0 else 0
        all_notes += notes if sup < 0 else []

    if len(objectives) < 2:
        objectives = [f"掌握{spec['title']}的核心内容", "能独立完成本课判题练习"]

    # 判题练习（与 v1 同一机器门禁）。人写大纲=硬门禁；自动大纲档练习规格是 LLM 拟的，
    # 可能不可实现——失败降级为无练习并记 audit note，不炸整课。
    exercise = None
    if spec.get("exercise"):
        ex_spec = spec["exercise"]
        body_digest = "\n\n".join(f"## {s.heading}\n{s.body_md}" for s in sections)
        ex_user = (
            f"【题目规格】函数名：{ex_spec['function_name']}；任务方向：{ex_spec['hint']}\n\n"
            f"【课时正文】\n{body_digest[:3000]}"
        )
        ex_problems = ["未生成"]
        ex_data = None
        studio.publish("exercise_verifying", "verifier",
                       lesson_id=spec["lesson_id"], function=ex_spec["function_name"])
        for _ in range(2):
            ex_data = gateway.structured_chat(
                "ResourceGenerationAgent", GENERATE_EXERCISE_SYSTEM, ex_user, max_tokens=2000,
            )
            if ex_data is None:
                continue
            ex_data["function_name"] = ex_spec["function_name"]
            ex_problems = _backfill_and_verify_exercise(ex_data)
            if not ex_problems:
                break
            studio.publish("exercise_gate_failed", "verifier",
                           lesson_id=spec["lesson_id"], problems=ex_problems[:4])
            ex_user += "\n\n上一稿未过机器验证：" + "；".join(ex_problems) + "\n请修正后重新输出完整 JSON。"
        if ex_data is None or ex_problems:
            msg = f"{spec['lesson_id']}: 判题练习生成失败或未过机器验证：{ex_problems}"
            if strict_exercise:
                raise SystemExit(msg)
            print(f"⚠ {msg}（自动大纲档：降级为无练习）")
            all_notes.append("判题练习降级：LLM 拟定的练习规格生成失败或未过机器验证")
            studio.publish("exercise_degraded", "verifier", lesson_id=spec["lesson_id"])
        else:
            ex_data["exercise_id"] = f"{spec['lesson_id']}-ex"
            exercise = GradedExercise(**ex_data)
            studio.publish("exercise_passed", "verifier",
                           lesson_id=spec["lesson_id"], tests=len(ex_data.get("test_cases", [])))

    video = None
    if spec.get("video_intro"):
        v = spec["video_intro"]
        if not any(v["uid"] == acc["uid"] for acc in VIDEO_ACCOUNT_WHITELIST):
            raise SystemExit(f"{spec['lesson_id']}: 视频账号 uid 不在白名单")
        video = VideoIntro(**v)
    embed = InteractiveEmbed(**spec["interactive_embed"]) if spec.get("interactive_embed") else None

    cited = sum(1 for s in sections if s.source_ids)
    return Lesson(
        lesson_id=spec["lesson_id"],
        title=spec["title"],
        estimated_minutes=45,
        objectives=objectives,
        video_intro=video,
        interactive_embed=embed,
        sections=sections,
        check_understanding=checks or [CheckQuestion(
            question=f"本课主题是什么？", options=["见正文", "无"], answer_index=0, explanation="占位",
        )],
        key_terms=key_terms,
        graded_exercise=exercise,
        audit=LessonAudit(
            sections_total=len(sections),
            sections_supported=total_supported,
            citation_coverage=round(cited / len(sections), 3),
            judge_model=gateway.route_for("ContentAuditAgent").model,
            notes=all_notes,
        ),
    )


# 解析中指代选项的写法（洗牌后需同步重写字母）：选项A / 选 B / A 选项 / 答案是 C / 正确答案为 D
_OPTION_LETTER_RE = re.compile(
    # 前四种是"明说是选项"的安全模式；后两种是裸字母裁决（"D错误""C正确""B对"），
    # judge 实测发现生成器爱这么写，而洗牌只改前四种会留下指错的裸字母（llm7-03 踩过）。
    r"选项\s*[A-D]|[A-D]\s*选项|正确答案[是为]\s*[A-D]|答案[是为]\s*[A-D]"
    r"|选\s*[A-D](?![A-Za-z])|[A-D]\s*(?=错误|正确|不对|不选|对，|对。|对；)"
)

# 生成器爱把字母标号写进选项正文（"A. xxx"），而渲染按位置另加字母，洗牌后两者打架。
# 标号一律剥掉：位置就是唯一标号（llm7-03/llm5-08/theory_exam 等 17 题踩过）。
_OPTION_PREFIX_RE = re.compile(r"^\s*[A-Da-d]\s*[\.\．、\)）]\s*")


def _strip_option_prefix(opt: str) -> str:
    return _OPTION_PREFIX_RE.sub("", opt) if isinstance(opt, str) else opt


def _debias_options(q: dict, seed_key: str) -> dict:
    """选项去偏：LLM 出题时正确答案严重偏向 A（实测 20 题里 14 题在 A）。

    按题目内容哈希做确定性打乱——同一题每次重建结果一致（可复现），
    但正确答案在四个位置上均匀分布。
    """
    opts = [_strip_option_prefix(o) for o in (q.get("options") or [])]
    q["options"] = opts
    idx = q.get("answer_index", 0)
    if len(opts) < 2 or not (0 <= idx < len(opts)):
        return q
    correct = opts[idx]
    order = list(range(len(opts)))
    rng = random.Random(f"{seed_key}|{q.get('question', '')}")
    rng.shuffle(order)
    q["options"] = [opts[i] for i in order]
    q["answer_index"] = q["options"].index(correct)

    # 解析里常写"选项A/选 B"，洗牌后这些字母会指错——按同一置换重写字母。
    # order[new] = old，所以 old→new 是它的逆置换。
    old_to_new = {old: new for new, old in enumerate(order)}
    if any(old != new for old, new in old_to_new.items()):

        def _remap(m: re.Match[str]) -> str:
            phrase = m.group(0)
            letter = next(ch for ch in phrase if "A" <= ch <= "D")
            old = ord(letter) - ord("A")
            if old not in old_to_new:
                return phrase
            return phrase.replace(letter, chr(ord("A") + old_to_new[old]))

        for field in ("explanation", "question"):
            text = q.get(field)
            if isinstance(text, str) and text:
                q[field] = _OPTION_LETTER_RE.sub(_remap, text)
    return q


def build_theory_exam(gateway: LLMGateway, concept: str, n: int, allow_empty: bool = False) -> list[CheckQuestion]:
    """结业理论卷：面试题库受控出题 + judge 抽验口径。"""
    bank_path = ROOT / "data" / "quiz" / "interview_bank.jsonl"
    bank = [json.loads(line) for line in bank_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    bank = [b for b in bank if b["concept"] == concept]
    if len(bank) < 4:
        if allow_empty:
            print(f"⚠ 题库中 {concept} 语料不足，理论卷置空（自动大纲档容错）")
            return []
        raise SystemExit(f"题库中 {concept} 语料不足")
    questions: list[CheckQuestion] = []
    batch_size = 4
    bi = 0
    while len(questions) < n and bi < len(bank):
        batch = bank[bi:bi + batch_size]
        bi += batch_size
        ids = {b["bank_id"] for b in batch}
        material = "\n\n".join(f"### {b['bank_id']}｜{b['topic']}\n{b['content']}" for b in batch)
        data = gateway.structured_chat(
            "ResourceGenerationAgent",
            THEORY_EXAM_SYSTEM.format(n=min(5, n - len(questions))),
            f"【面试题库资料】\n{material}",
            max_tokens=2200,
        )
        if data is None:
            continue
        for q in data.get("questions", []):
            q["source_ids"] = [s for s in (q.get("source_ids") or []) if s in ids] or list(ids)[:1]
            if 0 <= q.get("answer_index", 0) < len(q.get("options", [])):
                questions.append(CheckQuestion(**_debias_options(q, f"{concept}-exam")))
    if len(questions) < max(12, n // 2):
        raise SystemExit(f"理论卷出题不足：{len(questions)}/{n}")
    return questions[:n]


def _load_prohibitions() -> dict[str, str]:
    """逐课时禁令：由 focus_prohibitions.json 提供，生产时追加到 focus 末尾。

    数据来源是"读真实语料 → 差集分析 → 写死禁令"的预判产物（见 docs/curation_discipline.md），
    与 focus 分开存放：focus 讲怎么教，禁令讲哪些常识不许带进来。
    """
    path = ROOT / "data" / "focus_prohibitions.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _resolve_outline(concept: str) -> dict | None:
    """大纲解析：人写 SEMESTER_OUTLINES 优先，其次 auto_outline.py 产物（工厂自动课程态）。"""
    if concept in SEMESTER_OUTLINES:
        outline = SEMESTER_OUTLINES[concept]
    else:
        auto = ROOT / "data" / "outlines" / f"{concept}.json"
        if not auto.is_file():
            return None
        outline = json.loads(auto.read_text(encoding="utf-8"))

    bans = _load_prohibitions()
    if bans:
        outline = json.loads(json.dumps(outline))  # 深拷贝，不污染模块级常量
        for ch in outline.get("chapters", []):
            for lesson in ch.get("lessons", []):
                ban = bans.get(lesson.get("lesson_id", ""))
                if ban and ban not in lesson.get("focus", ""):
                    lesson["focus"] = f"{lesson.get('focus', '').rstrip()}\n\n{ban}"
    return outline



def _record_cost(concept: str, gateway: LLMGateway, n_lessons: int,
                 exam_tokens: int = 0, exam_calls: int = 0) -> None:
    """把本次构建的 token 账落盘，成本从此可复算（答辩 P6/P9 的"元/门课"出处）。

    价格常量在 backend/services/cost_meter.py，标注"以账单为准"——
    token 数是硬数据，单价是估算，两者分开呈现。

    结业卷不进课时缓存、每轮都重出，混在总账里会把"每课时成本"抬高一大截，
    所以单独记 exam_tokens/exam_calls，报表按差值算课时边际成本。
    """
    from backend.services.cost_meter import cost_from_telemetry

    snap = gateway.telemetry_snapshot()
    model = gateway.route_for("ResourceGenerationAgent").model
    report = cost_from_telemetry(snap, model=model)
    path = ROOT / "data" / "eval" / "course_cost.json"
    ledger = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    entry = report.model_dump() if hasattr(report, "model_dump") else dict(report)
    entry.update({
        "date": date.today().isoformat(),
        "generator_model": model,
        "judge_model": gateway.route_for("ContentAuditAgent").model,
        "lessons_built": n_lessons,          # 本次真正生成的课时数（命中缓存的不算）
        "exam_tokens": exam_tokens,          # 结业卷（理论卷/final_quiz）单独占的账
        "exam_calls": exam_calls,
        "telemetry": snap,
    })
    ledger.setdefault(concept, []).append(entry)
    path.write_text(json.dumps(ledger, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[cost] {concept} 本次生成 {n_lessons} 课时 · {snap.get('total_tokens', 0)} tokens → {path.name}")


def build_semester_course(concept: str) -> Course:
    graph = json.loads(CONCEPT_GRAPH.read_text(encoding="utf-8"))
    outline = _resolve_outline(concept)
    if outline is None:
        # rag 等 v1 概念没有学期大纲——None 往下走会崩成不知所云的 NoneType 报错（工坊实测踩过）
        known = "、".join(sorted(set(SEMESTER_OUTLINES) | {p.stem for p in (ROOT / "data" / "outlines").glob("*.json")}))
        raise SystemExit(
            f"概念「{concept}」没有学期大纲（既不在 SEMESTER_OUTLINES，也没有 data/outlines/{concept}.json）。\n"
            f"可直接生产的概念：{known}\n"
            f"要新开概念：python scripts/auto_outline.py --concept {concept} --sources <语料前缀>"
        )
    # concept 必须在概念图里：catalog 按概念 id 找课程文件，名字对不上会让课产出来却
    # 在目录里显示"生产队列中"（2026-07-24 踩过，见 docs/curation_discipline.md §6）。
    if concept not in graph or concept == "_meta":
        known = "、".join(k for k in graph if not k.startswith("_"))
        raise SystemExit(
            f"概念图中不存在 concept id「{concept}」，课程会被 catalog 判为不可用。\n"
            f"可用 id：{known}\n（要开新概念，先往 data/knowledge_base/concept_graph.json 加一条）"
        )
    meta = graph[concept]
    gateway = _build_gateway()
    if not gateway.is_enabled("ResourceGenerationAgent"):
        raise SystemExit('LLM 路由未启用：请先 $env:AGENT_GENERATION_MODE="api"')

    cache_dir = ROOT / "data" / ".lesson_cache" / concept
    cache_dir.mkdir(parents=True, exist_ok=True)
    _built_count = 0  # 本次真正生成的课时数（命中缓存不计）——成本账用
    _failed: list[tuple[str, str]] = []  # 本次失败的课时，全部跑完再一并报告
    chapters: list[Chapter] = []
    for ch in outline["chapters"]:
        lessons = []
        for spec in ch["lessons"]:
            cache_file = cache_dir / f"{spec['lesson_id']}.json"
            focus_sig = hashlib.sha1(spec.get("focus", "").encode("utf-8")).hexdigest()[:10]
            sig_file = cache_dir / f"{spec['lesson_id']}.focus"
            if cache_file.is_file():
                # 缓存只按 lesson_id 命中；focus/禁令改了却复用旧稿是静默失效，必须吼出来。
                cached_sig = sig_file.read_text(encoding="utf-8").strip() if sig_file.is_file() else ""
                if cached_sig and cached_sig != focus_sig:
                    print(
                        f"    ⚠ {spec['lesson_id']} focus 已变更但命中旧缓存——本次沿用旧稿。"
                        f"要按新 focus 重生成：del {cache_file}"
                    )
                lessons.append(Lesson.model_validate_json(cache_file.read_text(encoding="utf-8")))
                print(f"    · {spec['lesson_id']} 命中缓存")
                studio.publish("lesson_cached", "planner",
                               lesson_id=spec["lesson_id"], title=spec["title"])
                continue
            # 单课失败不阻塞其余课时：收集起来最后一并报告。
            # 否则一门 36 节的课里有一节顽固，后面 12 节全部白等——而且每次重跑
            # 只能发现一个问题课时，反馈环长得离谱（2026-07-24 实测踩过 4 轮）。
            try:
                lesson = build_lesson_v2(gateway, spec, meta.get("misconceptions", []),
                                         strict_exercise=concept in SEMESTER_OUTLINES)
            except SystemExit as exc:
                _failed.append((spec["lesson_id"], str(exc)))
                print(f"    ✗ {spec['lesson_id']} 生产失败，跳过继续：{str(exc)[:160]}")
                studio.publish("lesson_failed", "judge",
                               lesson_id=spec["lesson_id"], reason=str(exc)[:300])
                continue
            cache_file.write_text(lesson.model_dump_json(indent=2), encoding="utf-8")
            sig_file.write_text(focus_sig, encoding="utf-8")
            lessons.append(lesson)
            _built_count += 1
            print(f"    ✔ {spec['lesson_id']} 生产完成（{len(lesson.sections)} 小节）")
            audit = lesson.audit
            studio.publish("lesson_passed", "planner",
                           lesson_id=spec["lesson_id"], title=spec["title"],
                           sections=len(lesson.sections),
                           checks=len(lesson.check_understanding),
                           citation_coverage=audit.citation_coverage if audit else None,
                           supported=f"{audit.sections_supported}/{audit.sections_total}" if audit else None)
        chapters.append(Chapter(chapter_id=ch["chapter_id"], title=ch["title"], intro=ch.get("intro", ""), lessons=lessons))
        print(f"  ✔ {ch['chapter_id']} {ch['title']}：{len(lessons)} 节")

    # 分级项目阶梯：L1=唐诗接龙机 + L2/L3（仅人写大纲概念有配套项目；自动大纲档 v1 无项目）
    # ponytail: 自动大纲课程暂无分级项目，等项目模板 agent 化后补
    projects: list[Capstone] = []
    if concept in CAPSTONES:
        l1 = json.loads(json.dumps(CAPSTONES[concept]))
        l1.update({"project_id": "llm-p1", "level": "L1",
                   "level_note": "入门（学完第一章）：跑通即达结业线——大一零基础的第一个 AI 作品"})
        for proj in [l1] + LLM_PROJECTS:
            cap = json.loads(json.dumps(proj))
            problems = _backfill_and_verify_exercise(cap, preamble=cap.get("dataset_code", ""))
            if problems:
                raise SystemExit(f"项目 {cap.get('project_id')} 未过机器验证：{problems}")
            projects.append(Capstone(**cap))

    if _failed:
        detail = "\n".join(f"  · {lid}：{msg[:200]}" for lid, msg in _failed)
        # 失败也要记账：token 已经花出去了，不落盘等于这轮开销从账上凭空消失
        _record_cost(concept, gateway, _built_count)
        raise SystemExit(
            f"{len(_failed)}/{len(_failed) + _built_count} 个新课时未过门禁"
            f"（已过闸的都已入缓存，重跑只补这几节）：\n{detail}"
        )

    exam_n = outline.get("theory_exam_n", 20)
    _pre_exam = gateway.telemetry_snapshot()  # 结业卷的账要能从总账里减出来
    studio.publish("exam_building", "generator", note="出结业测评（题库受控或语料出题）")
    theory_exam = build_theory_exam(
        gateway, concept, exam_n,
        allow_empty=concept not in SEMESTER_OUTLINES) if exam_n > 0 else []

    all_lessons = [lesson for c in chapters for lesson in c.lessons]

    # 结业测评兜底：面试题库只覆盖 llm_basics，自动大纲课（如迁移的第二领域）拿不到理论卷，
    # 回落到用本课语料出的 final_quiz——每门课都必须有总结性测评（tests/test_curriculum.py 守着）。
    final_quiz: list[CheckQuestion] = []
    if not theory_exam:
        final_quiz = build_final_quiz(gateway, all_lessons, concept)
    studio.publish("exam_done", "generator",
                   theory_exam=len(theory_exam), final_quiz=len(final_quiz))
    course = Course(
        course_id=concept,
        title=meta["title"],
        tagline=outline.get("tagline", ""),
        difficulty=meta.get("difficulty", "L1"),
        prerequisites=meta.get("prerequisites", []),
        minutes_total=sum(lesson.estimated_minutes for lesson in all_lessons),
        generated_by=GeneratedBy(
            mode="api",
            generator_model=gateway.route_for("ResourceGenerationAgent").model,
            judge_model=gateway.route_for("ContentAuditAgent").model,
            date=date.today().isoformat(),
        ),
        chapters=chapters,
        projects=projects,
        theory_exam=theory_exam,
        final_quiz=final_quiz,
        textbooks=outline.get("textbooks", []),
    )
    _post_exam = gateway.telemetry_snapshot()
    print(f"[gateway] {_post_exam}")
    _record_cost(
        concept, gateway, _built_count,
        exam_tokens=_post_exam.get("total_tokens", 0) - _pre_exam.get("total_tokens", 0),
        exam_calls=_post_exam.get("attempts", 0) - _pre_exam.get("attempts", 0),
    )
    return course


def build_catalog() -> Catalog:
    graph = json.loads(CONCEPT_GRAPH.read_text(encoding="utf-8"))
    keywords_by_concept: dict[str, list[str]] = {}
    for kw, concept in KEYWORD_CONCEPTS.items():
        keywords_by_concept.setdefault(concept, []).append(kw)
    concepts = []
    for cid, meta in graph.items():
        if cid == "_meta":
            continue
        course_file = OUT_DIR / f"{cid}.json"
        minutes, lesson_count, tagline = 0, 0, ""
        if course_file.is_file():
            data = json.loads(course_file.read_text(encoding="utf-8"))
            n_lessons = (
                sum(len(ch["lessons"]) for ch in data["chapters"]) if data.get("chapters") else len(data.get("lessons", []))
            )
            minutes, lesson_count, tagline = data["minutes_total"], n_lessons, data.get("tagline", "")
        concepts.append(
            CatalogConcept(
                concept_id=cid,
                title=meta["title"],
                difficulty=meta.get("difficulty", "L1"),
                prerequisites=meta.get("prerequisites", []),
                keywords=keywords_by_concept.get(cid, []),
                course_available=course_file.is_file(),
                tagline=tagline,
                minutes_total=minutes,
                lesson_count=lesson_count,
            )
        )
    order = {"L1": 0, "L2": 1, "L3": 2, "L4": 3}
    concepts.sort(key=lambda c: (order.get(c.difficulty, 9), len(c.prerequisites)))
    return Catalog(
        concepts=concepts,
        video_account_whitelist=VIDEO_ACCOUNT_WHITELIST,
        textbook_registry=[TextbookEntry(**t) for t in TEXTBOOK_REGISTRY],
        generated_date=date.today().isoformat(),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concept", default="")
    parser.add_argument("--catalog-only", action="store_true")
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.concept and not args.catalog_only:
        if _resolve_outline(args.concept) is not None:
            course = build_semester_course(args.concept)
        else:
            course = build_course(args.concept)
        out = OUT_DIR / f"{args.concept}.json"
        out.write_text(course.model_dump_json(indent=2), encoding="utf-8")
        lessons = course.all_lessons()
        total_notes = [n for lesson in lessons for n in lesson.audit.notes]
        print(
            f"✅ {out}  课时 {len(lessons)} · 共 {course.minutes_total} 分钟 · "
            f"项目 {len(course.projects) or (1 if course.capstone else 0)} · 理论卷 {len(course.theory_exam)}"
        )
        if total_notes:
            print("⚠ 审核备注：", *total_notes, sep="\n  ")

    catalog = build_catalog()
    (OUT_DIR / "catalog.json").write_text(catalog.model_dump_json(indent=2), encoding="utf-8")
    available = sum(1 for c in catalog.concepts if c.course_available)
    print(f"✅ catalog.json  概念 {len(catalog.concepts)} · 已有课程 {available}")


if __name__ == "__main__":
    main()
