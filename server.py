import uvicorn
from fastapi import FastAPI
from database import init_db
from upload import router
from config import HOST, PORT

app = FastAPI()
app.include_router(router)

init_db()

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
