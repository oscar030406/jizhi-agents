# 岗位调研统计脚本（docs/02-spec/job_market_research.md 的复算口径）

数据集（研究用二手数据，不随提交包分发）：
- 人工智能招聘大数据 2014-2025（分年 xlsx）
- 智联招聘数据库 2016-2025（分年 csv）

流程：convert.py（xlsx→parquet）→ analyze.py（三层筛选+统计表）→
zhaopin_baseline.py（大盘对照）→ charts.py（图表 → docs/assets/jd/）。
脚本内路径按本机数据位置调整。筛选词表与词典（CORE_PAT/SKILL_LEXICON）公开可审。
