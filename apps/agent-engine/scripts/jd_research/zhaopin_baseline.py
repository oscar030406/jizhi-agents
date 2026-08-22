"""智联全行业大盘对照：每年总岗位量 + 命中大模型词的岗位量（占比趋势用）。"""
import duckdb, glob, re, os, json
OUT = os.path.join(os.path.dirname(__file__), "stats")
os.makedirs(OUT, exist_ok=True)
con = duckdb.connect()
con.execute("SET threads TO 8")
rows = []
for f in sorted(glob.glob(r"D:/UserData/Desktop/招聘数据集/智联招聘数据集/*.csv")):
    year = int(re.search(r"(\d{4})", os.path.basename(f)).group(1))
    try:
        r = con.execute(f"""
            SELECT count(*) AS total,
                   sum(CASE WHEN regexp_matches(concat(coalesce(招聘岗位,''),coalesce(职位描述,'')),
                       '大模型|大语言模型|LLM|AIGC|生成式AI|RAG|智能体|Agent|提示词|ChatGPT|DeepSeek', 'i')
                       THEN 1 ELSE 0 END) AS llm_hits
            FROM read_csv_auto('{f}', sample_size=20000, ignore_errors=true)
        """).fetchone()
        rows.append({"year": year, "total": int(r[0]), "llm_hits": int(r[1] or 0)})
        print(year, r, flush=True)
    except Exception as e:
        print(year, "FAILED", str(e)[:120], flush=True)
json.dump(rows, open(os.path.join(OUT, "zhaopin_baseline.json"), "w"))
print("BASELINE DONE")
