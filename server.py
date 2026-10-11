"""
HTTP API + static frontend for the ResearchMind multi-agent pipeline.

Replaces the Streamlit UI (app.py). It does NOT change any agent, prompt, tool or
orchestration: each run calls the existing pipeline.run_research_pipeline(topic)
unchanged. Live stage progress is derived from the "step N - ..." lines that
pipeline.py already prints, captured per run thread. Token usage and cost come
from LangChain's OpenAI callback (measured, not estimated).

Run:  uvicorn server:app --port 8000
"""
import io
import os
import re
import sys
import threading
import time
import traceback
import uuid
from contextlib import nullcontext

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
REQUIRED_KEYS = ["OPENAI_API_KEY", "TAVILY_API_KEY"]
MAX_CONCURRENT_RUNS = int(os.getenv("MAX_CONCURRENT_RUNS", "1"))
MAX_LOG_CHARS = 200_000
MAX_RUNS_KEPT = 50

# Stage keys and the exact markers printed by pipeline.py (matched case-insensitively).
STAGES = [
    ("search", "step 1 - search agent"),
    ("reader", "step 2 - reader agent"),
    ("writer", "step 3 - writer"),
    ("critic", "step 4 - critic"),
]


class _ThreadStdout(io.TextIOBase):
    """Routes print() output from pipeline threads to that run's log, and still echoes to the console."""

    def __init__(self, base):
        self.base = base
        self.sinks = {}

    def write(self, s):
        sink = self.sinks.get(threading.get_ident())
        if sink is not None:
            sink(s)
        return self.base.write(s)

    def flush(self):
        self.base.flush()

    def isatty(self):
        return False


_stdout = _ThreadStdout(sys.stdout)
sys.stdout = _stdout

RUNS = {}
RUNS_LOCK = threading.Lock()
_SECRET_PATTERNS = [re.compile(r"sk-[A-Za-z0-9_\-*]{6,}"), re.compile(r"tvly-[A-Za-z0-9_\-*]{6,}")]


def _redact(text: str) -> str:
    for pat in _SECRET_PATTERNS:
        text = pat.sub("[redacted]", text)
    return text


def _missing_keys():
    return [k for k in REQUIRED_KEYS if not os.getenv(k)]


class RunRequest(BaseModel):
    topic: str = Field(..., min_length=3, max_length=300)

    @field_validator("topic")
    @classmethod
    def strip_topic(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 3:
            raise ValueError("Topic must contain at least 3 non-space characters")
        return v


def _snapshot(run, include_log=True):
    usage = None
    cb = run.get("_cb")
    if cb is not None:
        usage = {
            "prompt_tokens": cb.prompt_tokens,
            "completion_tokens": cb.completion_tokens,
            "total_tokens": cb.total_tokens,
            "cost_usd": cb.total_cost,
            "successful_requests": cb.successful_requests,
        }
    end = run["finished_at"] or time.time()
    snap = {k: v for k, v in run.items() if not k.startswith("_") and k != "log"}
    snap["usage"] = usage
    snap["elapsed_s"] = end - run["started_at"] if run["started_at"] else None
    if include_log:
        snap["log"] = _redact(run["log"][-20_000:])
        snap["log_truncated"] = len(run["log"]) > 20_000
    return snap


def _execute(run_id):
    run = RUNS[run_id]
    stage_index = {"value": -1}

    def advance(to_index):
        now = time.time()
        for i, stage in enumerate(run["stages"]):
            if i < to_index and stage["status"] in ("pending", "running"):
                stage["status"] = "done"
                stage["ended_at"] = stage["ended_at"] or now
            elif i == to_index:
                stage["status"] = "running"
                stage["started_at"] = now
        stage_index["value"] = to_index

    def sink(text):
        if len(run["log"]) < MAX_LOG_CHARS:
            run["log"] += text
        lowered = text.lower()
        nxt = stage_index["value"] + 1
        if nxt < len(STAGES) and STAGES[nxt][1] in lowered:
            advance(nxt)

    _stdout.sinks[threading.get_ident()] = sink
    run["status"] = "running"
    run["started_at"] = time.time()
    try:
        try:
            from langchain_community.callbacks.manager import get_openai_callback
            cb_ctx = get_openai_callback()
        except Exception:  # pragma: no cover - optional measurement
            cb_ctx = nullcontext(None)

        import pipeline  # existing module, imported lazily so missing keys don't crash the server

        with cb_ctx as cb:
            run["_cb"] = cb
            state = pipeline.run_research_pipeline(run["topic"])
        advance(len(STAGES))
        run["outputs"] = {
            "search_results": state.get("search_results"),
            "scraped_content": state.get("scraped_content"),
            "report": state.get("report"),
            "feedback": state.get("feedback"),
        }
        run["status"] = "completed"
    except Exception as exc:
        for stage in run["stages"]:
            if stage["status"] == "running":
                stage["status"] = "error"
                stage["ended_at"] = time.time()
        run["status"] = "failed"
        run["error"] = {"type": type(exc).__name__, "message": _redact(str(exc))[:2000]}
        run["log"] += "\n" + _redact(traceback.format_exc())[-4000:]
    finally:
        run["finished_at"] = time.time()
        _stdout.sinks.pop(threading.get_ident(), None)


app = FastAPI(title="ResearchMind API", description="Multi-agent research pipeline (search → reader → writer → critic)")


@app.get("/api/health")
def health():
    missing = _missing_keys()
    return {
        "status": "ok",
        "keys": {k: bool(os.getenv(k)) for k in REQUIRED_KEYS},
        "ready": not missing,
        "missing_keys": missing,
        "max_concurrent_runs": MAX_CONCURRENT_RUNS,
        "active_runs": sum(1 for r in RUNS.values() if r["status"] in ("queued", "running")),
    }


@app.post("/api/runs", status_code=202)
def create_run(req: RunRequest):
    missing = _missing_keys()
    if missing:
        raise HTTPException(503, {
            "message": f"Missing environment variable(s): {', '.join(missing)}. Add them to .env (see .env.example) and restart the server.",
            "missing_keys": missing,
        })
    with RUNS_LOCK:
        active = sum(1 for r in RUNS.values() if r["status"] in ("queued", "running"))
        if active >= MAX_CONCURRENT_RUNS:
            raise HTTPException(429, {"message": "A research run is already in progress. Wait for it to finish, then try again."})
        run_id = uuid.uuid4().hex[:12]
        RUNS[run_id] = {
            "id": run_id,
            "topic": req.topic,
            "status": "queued",
            "created_at": time.time(),
            "started_at": None,
            "finished_at": None,
            "stages": [{"key": k, "status": "pending", "started_at": None, "ended_at": None} for k, _ in STAGES],
            "outputs": None,
            "error": None,
            "log": "",
            "_cb": None,
        }
        if len(RUNS) > MAX_RUNS_KEPT:
            for old in sorted(RUNS.values(), key=lambda r: r["created_at"])[: len(RUNS) - MAX_RUNS_KEPT]:
                if old["status"] not in ("queued", "running"):
                    RUNS.pop(old["id"], None)
    threading.Thread(target=_execute, args=(run_id,), daemon=True, name=f"run-{run_id}").start()
    return _snapshot(RUNS[run_id])


@app.get("/api/runs")
def list_runs():
    runs = sorted(RUNS.values(), key=lambda r: r["created_at"], reverse=True)
    return [
        {"id": r["id"], "topic": r["topic"], "status": r["status"], "created_at": r["created_at"],
         "elapsed_s": _snapshot(r, include_log=False)["elapsed_s"]}
        for r in runs
    ]


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    run = RUNS.get(run_id)
    if run is None:
        raise HTTPException(404, "Run not found (runs are kept in memory and are lost when the server restarts).")
    return _snapshot(run)


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
