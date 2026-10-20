"""python -m server  ->  http://127.0.0.1:8000"""
import os

import uvicorn

uvicorn.run("server.app:app", host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8000)))
