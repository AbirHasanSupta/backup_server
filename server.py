import threading
from contextlib import asynccontextmanager

import anyio
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from upload import router
from config import load_config, HOST, PORT
import memories


@asynccontextmanager
async def lifespan(app: FastAPI):
    anyio.to_thread.current_default_thread_limiter().total_tokens = 100
    yield


app = FastAPI(title="Phone Backup Server", version="2.4.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

init_db()
threading.Thread(target=memories.startup_scan_loop, daemon=True).start()

if __name__ == "__main__":
    cfg = load_config()
    uvicorn.run(
        app,
        host=cfg["HOST"],
        port=int(cfg["PORT"]),
    )
