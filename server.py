import os, sys
from contextlib import asynccontextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "backend"))

# 确保 Zeabur volume 上的持久化目录存在(DB父目录 + 上传目录)
for d in (os.path.dirname(os.environ.get("RELAY_DB", "/data/relay.db")),
          os.environ.get("RELAY_UPLOAD_DIR", "/data/uploads")):
    if d:
        os.makedirs(d, exist_ok=True)

from app import app as relay, init_db              # noqa: E402
from fastapi import FastAPI                        # noqa: E402
from fastapi.staticfiles import StaticFiles        # noqa: E402


@asynccontextmanager
async def lifespan(_):
    # 子应用被 mount 后其自身 lifespan 不会触发, 必须在外层建表, 否则 /app/* 查询 500
    init_db()
    yield


# 单服务: /relay/* -> relay 后端(API), /* -> web PWA(静态)。同源,无需 CORS / 改 API_BASE。
app = FastAPI(lifespan=lifespan)
app.mount("/relay", relay)
app.mount("/", StaticFiles(directory=os.path.join(HERE, "web"), html=True), name="web")
