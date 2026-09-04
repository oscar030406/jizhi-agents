from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.api.intake_routes import router as intake_router
from backend.api.knowledge_graph_routes import router as knowledge_graph_router
from backend.api.practice_scout_routes import router as practice_scout_router
from backend.api.routes import router
from backend.integration.personalize_api import router as personalize_router


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT / "frontend"


app = FastAPI(
    title="Agent Training System",
    description="Multi-agent personalized learning system for Agent application training.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
# personalize 路由原本只在 legacy-platform 的 vendored 副本里挂载——README 教人起
# apps/agent-engine，起完 /internal/v1/personalize/* 全 404，classroom 四个桥静默降级成
# 裸生成（评分表最低档），页面上看不出任何异常。挂在引擎自己身上，两边起哪个都活。
app.include_router(personalize_router)
# 领域接入流水线：上传语料 → 一次可观察的 run。发起走 x-internal-token，查询只读。
app.include_router(intake_router)
# 域级实操项目侦察：GitHub 实搜 + 模型起草 + 管理员确认。挂载点两个 main 都要有。
app.include_router(practice_scout_router)
# 知识宇宙：该库的概念/教材/章节/证据块结构图，只读。挂载点同样两个 main 都要有。
app.include_router(knowledge_graph_router)

if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")

