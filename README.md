# ResearchMind — multi-agent research workbench

A portfolio project that began from a YouTube tutorial and was extended with a web research workbench (replacing the original Streamlit UI), live stage tracking, measured token usage, source cross-checking and documented limitations. In short: a sequential LangChain pipeline in which a **search agent**, a **reader agent**,
a **writer chain** and a **critic chain** turn a topic into a structured research report and a self-critique.
The browser interface is plain HTML, CSS and JavaScript served by a small FastAPI server.

## Pipeline (unchanged)

| # | Component | Implementation (`agents.py`, `tools.py`) | Input → output |
|---|---|---|---|
| 1 | Search agent | `create_agent(gpt-4o-mini, tools=[web_search])`; Tavily, 5 results | topic → search summary |
| 2 | Reader agent | `create_agent(gpt-4o-mini, tools=[scrape_url])`; requests + BeautifulSoup, 3,000 chars | first 800 chars of search output → page content |
| 3 | Writer chain | `ChatPromptTemplate \| llm \| StrOutputParser` | topic + research → report (Introduction, Key Findings, Conclusion, Sources) |
| 4 | Critic chain | same pattern, critic prompt | report → `Score: X/10`, strengths, improvements, verdict |

Orchestration lives in `pipeline.run_research_pipeline(topic)` and runs strictly in sequence.

## Architecture

```
static/              HTML/CSS/vanilla-JS workbench
  index.html
  css/core.css, js/core.js   shared design system (synced from ../../_design_system)
  css/app.css, js/app.js     project UI
server.py            NEW FastAPI server: run lifecycle, polling API, static files
pipeline.py          EXISTING orchestration (unchanged)
agents.py, tools.py  EXISTING agents, prompts, tools (unchanged)
```

`server.py` runs each request in a worker thread and calls `pipeline.run_research_pipeline(topic)` as-is.
Live stage status is derived from the `step N - …` lines that `pipeline.py` already prints (captured per thread).
Token usage and cost come from LangChain's `get_openai_callback()` and are shown only when it records usage.

The former Streamlit UI (`app.py`) was removed. It duplicated the pipeline steps inline; the new server calls the
canonical `pipeline.py` function instead.

## Run locally

```bash
cd GENAI_AGENTIC_AI/MUTLI_AGENT_RESEARCH
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then add your OPENAI_API_KEY and TAVILY_API_KEY
uvicorn server:app --port 8000
```

Open <http://localhost:8000>. Without keys the server still starts; the UI shows which key is missing and
runs are rejected with HTTP 503. The CLI (`python pipeline.py`) still works as before.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Which keys are configured (booleans only), concurrency |
| POST | `/api/runs` `{"topic": "…"}` | Start a run (202). 422 invalid topic, 429 run already active, 503 keys missing |
| GET | `/api/runs` | Runs held in server memory |
| GET | `/api/runs/{id}` | Status, per-stage timings, outputs (when complete), usage, console log (keys redacted) |

## Evaluation shown in the UI

- **Critic chain score** (existing): parsed from the `Score: X/10` format; the raw output is always available.
- **Structural checks** (added in the UI, clearly labelled): required sections present, ≥ 3 key findings
  (heuristic), and how many report URLs also appear in the search/reader outputs.

## Limitations

- The critic is the same model grading its own pipeline (LLM-as-judge without a reference); scores are not calibrated.
- The reader sees only the first 800 characters of search output and scrapes a single page.
- Citations are not verified by the pipeline; the UI cross-check only detects URLs absent from the gathered material.
- Outputs arrive when the whole pipeline finishes; only stage status and the console stream live.
- Server-side run history is in memory; completed runs are also saved in the browser (localStorage, last 10).

## Deployment notes

- Required environment variables: `OPENAI_API_KEY`, `TAVILY_API_KEY` (server-side only; never sent to the browser).
- Optional: `MAX_CONCURRENT_RUNS` (default 1) to cap paid API usage.
- Public deployment should add authentication or rate limiting, because every run spends API credit.
