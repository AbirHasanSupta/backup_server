import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from upload import router
from config import load_config, HOST, PORT
from ssl_utils import ensure_cert

app = FastAPI(title="Phone Backup Server", version="2.1.2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

init_db()

if __name__ == "__main__":
    cfg = load_config()
    cert_path, key_path = ensure_cert()
    uvicorn.run(
        app,
        host=cfg["HOST"],
        port=int(cfg["PORT"]),
        ssl_certfile=cert_path,
        ssl_keyfile=key_path,
    )
