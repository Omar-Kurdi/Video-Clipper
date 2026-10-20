"""python -m server  ->  http://127.0.0.1:8000 (or the next free port)"""
import os
import socket

import uvicorn


def _free_port(host: str, start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex((host, port)) != 0:
                return port
    raise SystemExit(f"no free port between {start} and {start + 49}")


host = os.environ.get("HOST", "127.0.0.1")
wanted = int(os.environ.get("PORT", 8000))
port = wanted if "PORT" in os.environ else _free_port(host, wanted)
if port != wanted:
    print(f"port {wanted} is busy, using {port}")
print(f"Lecture Shorts: http://{host}:{port}")
uvicorn.run("server.app:app", host=host, port=port)
