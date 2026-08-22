"""AI 招聘专集 xlsx → parquet（一次转换，后续分析秒级）。"""
import pandas as pd, glob, os, sys
SRC = r'D:/UserData/Desktop/招聘数据集/人工智能招聘大数据2014-2025(1).3/分年份保存数据'
OUT = os.path.join(os.path.dirname(__file__), 'parquet')
os.makedirs(OUT, exist_ok=True)
for f in sorted(glob.glob(SRC + '/*.xlsx')):
    year = ''.join(ch for ch in os.path.basename(f) if ch.isdigit())
    dst = os.path.join(OUT, f'ai_{year}.parquet')
    if os.path.exists(dst):
        print('skip', year); continue
    print('loading', year, flush=True)
    df = pd.read_excel(f)
    df = df.astype(str)  # 混杂类型统一成 str，数值列由分析侧 to_numeric 再解析
    df.to_parquet(dst, index=False)
    print('done', year, len(df), 'rows', flush=True)
print('ALL DONE')
