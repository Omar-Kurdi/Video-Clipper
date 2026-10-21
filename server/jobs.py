"""Background jobs. GPU work (transcribe, analyze, render) runs one at a time;
downloads run on their own lane so an import doesn't wait behind a render."""
import os
import queue
import threading
import time
import traceback
from typing import Callable

from .store import new_id

Report = Callable[..., None]  # report(progress=0..1, stage=str, message=str)


class Jobs:
    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._lanes = {name: queue.Queue() for name in ("gpu", "io")}
        for name, q in self._lanes.items():
            threading.Thread(target=self._worker, args=(q,), daemon=True, name=f"jobs-{name}").start()

    def submit(self, kind: str, fn: Callable[[Report], dict | None], lane: str = "gpu",
               **meta) -> dict:
        job = {"id": new_id(), "kind": kind, "status": "queued", "progress": 0.0, "stage": "",
               "message": "", "result": None, "created": time.time(), **meta}
        with self._lock:
            self._jobs[job["id"]] = job
        self._lanes[lane].put((job["id"], fn))
        return dict(job)

    def get(self, jid: str) -> dict:
        with self._lock:
            return dict(self._jobs[jid])

    def list(self, **match) -> list[dict]:
        with self._lock:
            jobs = [dict(j) for j in self._jobs.values()
                    if all(j.get(k) == v for k, v in match.items())]
        return sorted(jobs, key=lambda j: j["created"], reverse=True)

    def active(self, **match) -> dict | None:
        for j in self.list(**match):
            if j["status"] in ("queued", "running"):
                return j
        return None

    def _set(self, jid: str, **fields) -> None:
        with self._lock:
            self._jobs[jid].update(fields)

    def _worker(self, q: queue.Queue) -> None:
        # background work runs at low priority so the desktop stays responsive;
        # child processes (ffmpeg) inherit it
        try:
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)
        except OSError:
            pass
        while True:
            jid, fn = q.get()
            self._set(jid, status="running", started=time.time())

            def report(progress: float | None = None, stage: str | None = None,
                       message: str | None = None, _jid=jid) -> None:
                upd = {}
                if progress is not None:
                    upd["progress"] = round(float(progress), 4)
                if stage is not None:
                    upd["stage"] = stage
                if message is not None:
                    upd["message"] = message
                self._set(_jid, **upd)

            try:
                result = fn(report)
                self._set(jid, status="done", progress=1.0, result=result, finished=time.time())
            except Exception as e:  # surfaced to the UI
                traceback.print_exc()
                self._set(jid, status="error", message=f"{type(e).__name__}: {e}", finished=time.time())
