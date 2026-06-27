import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "backend"))

# 确保 Zeabur volume 上的持久化目录存在(DB父目录 + 上传目录)
for d in (os.path.dirname(os.environ.get("RELAY_DB", "/data/relay.db")),
          os.environ.get("RELAY_UPLOAD_DIR", "/data/uploads")):
    if d:
        os.makedirs(d, exist_ok=True)

from app import app as relay                      # noqa: E402
from fastapi import FastAPI                        # noqa: E402
from fastapi.staticfiles import StaticFiles        # noqa: E402

# 单服务: /relay/* -> relay 后端(API), /* -> web PWA(静态)。同源,无需 CORS / 改 API_BASE。
app = FastAPI()
app.mount("/relay", relay)
app.mount("/", StaticFiles(directory=os.path.join(HERE, "web"), html=True), name="web")
