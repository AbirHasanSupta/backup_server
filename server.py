import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from upload import router
from config import HOST, PORT

app = FastAPI(title="Phone Backup Server", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

init_db()

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
