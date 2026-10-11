/* Scholaryx workbench — frontend logic. Talks to server.py (/api/*). */
(function () {
  "use strict";
  const { $, $$, el, api, fmt, markdown, initTabs, setBusy, setStatus, callout, toast, copyText, download, storage, escapeHtml } = window.RUI;

  const STAGE_LABELS = { search: "Search", reader: "Reader", writer: "Writer", critic: "Critic" };
  const HISTORY_KEY = "researchmind.history.v1";
  const POLL_MS = 1000;

  const state = { current: null, pollTimer: null, tickTimer: null, pollFailures: 0, tabs: null, lastLogLen: 0 };

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */
  async function boot() {
    state.tabs = initTabs($('[role="tablist"]'));
    try {
      const h = await api("/api/health", { timeout: 8000 });
      const keys = Object.entries(h.keys).map(([k, ok]) => `${k.replace("_API_KEY", "")} ${ok ? "✓" : "✗"}`).join(" · ");
      $("#key-status").textContent = keys;
      if (h.ready) setStatus($("#api-status"), "ok", "Server ready");
      else {
        setStatus($("#api-status"), "warn", `Missing ${h.missing_keys.join(", ")}`);
        $("#form-alert").replaceChildren(callout("warn", "API keys not configured", [
          `The server has no ${h.missing_keys.join(" or ")}. Runs will be rejected until you add ${h.missing_keys.length > 1 ? "them" : "it"} to .env (see .env.example) and restart the server.`,
        ]));
      }
    } catch (err) {
      setStatus($("#api-status"), "err", "Server unreachable");
      $("#form-alert").replaceChildren(callout("err", "Cannot reach the backend", [err.message, "Start it with: uvicorn server:app --port 8000"]));
    }
    await renderHistory();
    // Resume a run that is still in progress on the server (e.g. after a page reload).
    try {
      const runs = await api("/api/runs", { timeout: 8000 });
      const active = runs.find((r) => r.status === "running" || r.status === "queued");
      if (active) follow(active.id);
    } catch { /* ignore: health check already reported connectivity */ }
  }

  /* ------------------------------------------------------------------ */
  /* Running                                                            */
  /* ------------------------------------------------------------------ */
  function validateTopic() {
    const v = $("#topic").value.trim().replace(/\s+/g, " ");
    let msg = "";
    if (v.length < 3) msg = "Enter a research topic (at least 3 characters).";
    else if (v.length > 300) msg = "Keep the topic under 300 characters.";
    $("#topic-error").textContent = msg;
    $("#topic").setAttribute("aria-invalid", msg ? "true" : "false");
    return msg ? null : v;
  }

  async function startRun(topicOverride) {
    const topic = topicOverride || validateTopic();
    if (!topic) { $("#topic").focus(); return; }
    const btn = $("#run-btn");
    setBusy(btn, true, "Starting…");
    $("#run-alert").replaceChildren();
    try {
      const run = await api("/api/runs", { method: "POST", body: { topic }, timeout: 15000 });
      resetOutputs();
      follow(run.id, run);
    } catch (err) {
      setBusy(btn, false);
      const title = err.status === 503 ? "Server is not configured" : err.status === 429 ? "A run is already in progress" : err.status === 422 ? "Invalid topic" : "Could not start the run";
      $("#run-alert").replaceChildren(callout(err.status === 429 ? "warn" : "err", title, [err.message]));
    }
  }

  function follow(runId, initial) {
    stopPolling();
    state.pollFailures = 0;
    state.lastLogLen = 0;
    setBusy($("#run-btn"), true, "Running…");
    $("#run-progress").hidden = false;
    if (initial) renderRun(initial);
    const poll = async () => {
      try {
        const run = await api(`/api/runs/${runId}`, { timeout: 10000 });
        state.pollFailures = 0;
        renderRun(run);
        if (run.status === "completed" || run.status === "failed") return finish(run);
      } catch (err) {
        if (err.status === 404) {
          finishWithError("The run is no longer on the server (it was probably restarted). Start a new run.");
          return;
        }
        state.pollFailures++;
        if (state.pollFailures === 3) toast("Lost contact with the server — retrying…", "err");
        if (state.pollFailures > 60) { finishWithError(`Stopped polling: ${err.message}`); return; }
      }
      state.pollTimer = setTimeout(poll, state.pollFailures ? Math.min(5000, POLL_MS * 2 ** state.pollFailures) : POLL_MS);
    };
    poll();
    state.tickTimer = setInterval(tickElapsed, 250);
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    clearInterval(state.tickTimer);
  }

  function finish(run) {
    stopPolling();
    setBusy($("#run-btn"), false);
    $("#run-progress").hidden = true;
    if (run.status === "completed") {
      renderOutputs(run);
      saveHistory(run);
      toast("Research run completed", "ok");
    } else {
      const retry = el("button", { class: "btn btn-sm", type: "button", text: "Retry with same topic", onclick: () => startRun(run.topic) });
      const err = run.error || { type: "Error", message: "Unknown failure" };
      $("#run-alert").replaceChildren(callout("err", `Run failed during the ${failedStageName(run)} stage`, [
        el("p", {}, [el("code", { text: err.type }), " ", err.message]),
        el("p", {}, ["The full traceback is in the Console tab. ", retry]),
      ]));
    }
    renderHistory(run.id);
  }

  function finishWithError(message) {
    stopPolling();
    setBusy($("#run-btn"), false);
    $("#run-progress").hidden = true;
    $("#run-alert").replaceChildren(callout("err", "Run tracking stopped", [message]));
  }

  function failedStageName(run) {
    const s = run.stages.find((x) => x.status === "error");
    return s ? STAGE_LABELS[s.key].toLowerCase() : "start-up";
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */
  function renderRun(run) {
    state.current = run;
    state.current._receivedAt = performance.now();
    $("#run-topic").textContent = run.topic;
    $("#run-topic").title = run.topic;
    const badge = $("#run-badge");
    badge.textContent = run.status;
    badge.className = `badge ${{ running: "badge-accent", queued: "badge-info", completed: "badge-ok", failed: "badge-err" }[run.status] || ""}`;

    for (const s of run.stages) {
      const node = $(`.stage[data-stage="${s.key}"]`);
      const shown = run.status === "failed" && s.status === "pending" ? "skipped" : s.status;
      node.dataset.state = shown;
      $(".stage-state", node).textContent = { pending: "waiting", running: "running", done: "done", error: "failed", skipped: "not run" }[shown];
      const end = s.ended_at || (s.status === "running" ? Date.now() / 1000 : null);
      $(".stage-time", node).textContent = s.started_at && end ? fmt.secs(end - s.started_at) : "—";
    }

    $("#d-status").textContent = run.status;
    $("#d-id").textContent = run.id;
    $("#d-started").textContent = run.started_at ? fmt.time(run.started_at * 1000) : "queued";
    tickElapsed();
    renderTimeline(run);
    renderUsage(run);

    if (typeof run.log === "string") {
      const log = $("#log");
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      if (run.log.length !== state.lastLogLen) {
        log.textContent = (run.log_truncated ? "… (earlier output truncated)\n" : "") + (run.log || "(no output yet)");
        state.lastLogLen = run.log.length;
        if (atBottom) log.scrollTop = log.scrollHeight;
      }
    }
  }

  function tickElapsed() {
    const r = state.current;
    if (!r || r.elapsed_s === null || r.elapsed_s === undefined) return;
    const live = r.status === "running" ? (performance.now() - r._receivedAt) / 1000 : 0;
    $("#d-elapsed").textContent = fmt.secs(r.elapsed_s + live);
  }

  function renderTimeline(run) {
    const rows = run.stages.filter((s) => s.started_at).map((s) => ({ key: s.key, d: (s.ended_at || Date.now() / 1000) - s.started_at, done: !!s.ended_at, status: s.status }));
    const box = $("#d-timeline");
    if (!rows.length) { box.replaceChildren(el("span", { class: "hint", text: "Measured when stages start." })); return; }
    const max = Math.max(...rows.map((r) => r.d), 1);
    box.replaceChildren(...rows.map((r) => el("div", { class: "tl-row" }, [
      el("span", { text: STAGE_LABELS[r.key] }),
      el("span", { class: "bar-track" }, [el("span", { class: "bar-fill", style: { display: "block", width: `${(r.d / max) * 100}%`, background: r.status === "error" ? "var(--err)" : r.done ? "var(--ok)" : "var(--accent)", transition: "none" } })]),
      el("span", { class: "bar-value", text: fmt.secs(r.d) }),
    ])));
  }

  function renderUsage(run) {
    const u = run.usage;
    const body = $("#usage-body");
    if (!u || !u.total_tokens) {
      body.replaceChildren(el("p", { class: "hint", text: run.status === "running" ? "No token usage recorded yet." : run.status === "completed" || run.status === "failed" ? "The LangChain OpenAI callback did not record usage for this run, so no token or cost figures are shown." : "Reported by LangChain's OpenAI callback for this run." }));
      return;
    }
    const tile = (label, value) => el("div", { class: "stat" }, [el("div", { class: "stat-label", text: label }), el("div", { class: "stat-value", text: value })]);
    body.replaceChildren(
      el("div", { class: "usage-grid" }, [
        tile("Prompt", fmt.num(u.prompt_tokens)), tile("Completion", fmt.num(u.completion_tokens)),
        tile("Total tokens", fmt.num(u.total_tokens)), tile("Cost (USD)", u.cost_usd ? `$${u.cost_usd.toFixed(4)}` : "—"),
      ]),
      el("p", { class: "hint", text: `${u.successful_requests} successful LLM request${u.successful_requests === 1 ? "" : "s"}. Cost uses LangChain's built-in price table for gpt-4o-mini and excludes Tavily charges.` })
    );
  }

  function resetOutputs() {
    $("#report-body").replaceChildren(el("div", { class: "empty-state" }, [el("strong", { text: "Report in progress" }), el("span", { text: "The pipeline returns all outputs when the critic finishes. Follow progress in the Console tab." })]));
    $("#eval-body").replaceChildren(el("div", { class: "empty-state" }, [el("strong", { text: "Waiting for the critic" })]));
    $("#inter-body").replaceChildren(el("div", { class: "empty-state" }, [el("strong", { text: "Waiting for the run to finish" })]));
    $("#sources-body").replaceChildren(el("div", { class: "empty-state" }, [el("strong", { text: "Waiting for the run to finish" })]));
    $("#sources-count").textContent = "";
    $("#run-alert").replaceChildren();
  }

  function renderOutputs(run) {
    const o = run.outputs || {};
    // Report
    const report = o.report || "";
    $("#report-body").replaceChildren(
      el("div", { class: "report-toolbar" }, [
        el("button", { class: "btn btn-sm", type: "button", text: "Copy Markdown", onclick: () => copyText(report) }),
        el("button", { class: "btn btn-sm", type: "button", text: "Download .md", onclick: () => download(`research_report_${slug(run.topic)}.md`, report, "text/markdown") }),
      ]),
      el("article", { class: "prose", html: markdown(report) })
    );

    // Intermediate outputs
    $("#inter-body").replaceChildren(
      outputBlock("Search agent — final message", "Input: topic. Tool: web_search (Tavily).", o.search_results),
      outputBlock("Reader agent — final message", "Input: first 800 characters of the search output. Tool: scrape_url.", o.scraped_content)
    );

    // Evaluation + sources
    const sources = analyseSources(o);
    renderEvaluation(o, sources);
    renderSources(sources);
  }

  function outputBlock(title, sub, text) {
    return el("section", { class: "output-block" }, [
      el("div", { class: "output-head" }, [el("h3", { text: title }), el("span", { class: "hint", text: `${sub} ${text ? fmt.num(text.length) + " chars" : ""}` })]),
      text ? el("div", { class: "panel" }, [el("div", { class: "panel-body prose", html: markdown(text) })]) : el("p", { class: "hint", text: "No output." }),
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* Evaluation                                                         */
  /* ------------------------------------------------------------------ */
  function parseCritic(text) {
    const clean = String(text || "").replace(/\*\*/g, "").replace(/__/g, "");
    const scoreM = clean.match(/score\s*[:=]\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
    const lines = clean.split(/\r?\n/);
    const find = (re) => lines.findIndex((l) => re.test(l));
    const iS = find(/^\s*#*\s*strengths\s*:?/i);
    const iA = find(/^\s*#*\s*areas\s+(to|for)\s+improve/i);
    const iV = find(/^\s*#*\s*one[\s-]*line\s+verdict/i);
    const items = (from, to) => {
      if (from < 0) return [];
      return lines.slice(from + 1, to > from ? to : undefined).map((l) => l.trim()).filter((l) => /^[-*•]|\d+[.)]/.test(l)).map((l) => l.replace(/^([-*•]|\d+[.)])\s*/, ""));
    };
    const nextAfter = (i) => [iS, iA, iV].filter((x) => x > i).sort((a, b) => a - b)[0] ?? -1;
    let verdict = "";
    if (iV >= 0) {
      const inline = lines[iV].split(/verdict\s*:?/i)[1];
      verdict = (inline && inline.trim()) || lines.slice(iV + 1).map((l) => l.trim()).filter(Boolean)[0] || "";
    }
    return {
      score: scoreM ? parseFloat(scoreM[1]) : null,
      strengths: items(iS, nextAfter(iS)),
      improve: items(iA, nextAfter(iA)),
      verdict: verdict.replace(/^[-*•]\s*/, ""),
    };
  }

  function scoreDial(score) {
    const r = 64, c = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, score / 10));
    const color = score >= 8 ? "var(--ok)" : score >= 5 ? "var(--accent)" : "var(--err)";
    const wrap = el("div", { class: "score-dial", role: "img", "aria-label": `Critic score ${score} out of 10` });
    wrap.innerHTML = `<svg viewBox="0 0 160 160" aria-hidden="true"><circle cx="80" cy="80" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="12"/><circle cx="80" cy="80" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}"/></svg><div class="val"><div><b>${escapeHtml(score)}</b><span>out of 10</span></div></div>`;
    return wrap;
  }

  function sectionText(report, name, nextNames) {
    const lines = report.split(/\r?\n/);
    const isHead = (l, n) => new RegExp(`^\\s*(#{1,4}\\s*)?(\\*\\*)?\\s*(\\d+[.)]\\s*)?${n}\\b`, "i").test(l);
    const start = lines.findIndex((l) => isHead(l, name));
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (nextNames.some((n) => isHead(lines[i], n))) { end = i; break; }
    return lines.slice(start + 1, end).join("\n");
  }

  function renderEvaluation(o, sources) {
    const body = $("#eval-body");
    const critic = parseCritic(o.feedback);
    const blocks = [];

    if (critic.score !== null) {
      blocks.push(el("div", { class: "score-wrap" }, [
        scoreDial(critic.score),
        el("div", { class: "stack-sm" }, [
          el("p", { class: "eyebrow", text: "Critic chain · one-line verdict" }),
          el("p", { class: "verdict", text: critic.verdict || "No verdict line found in the critic output." }),
          el("p", { class: "hint", text: "An LLM-as-judge score produced by the same model (gpt-4o-mini) with the critic prompt in agents.py. It has no reference answer and is not a calibrated quality metric." }),
        ]),
      ]));
      blocks.push(el("div", { class: "eval-lists" }, [
        el("div", {}, [el("p", { class: "eyebrow", text: `Strengths (${critic.strengths.length})` }), el("ul", {}, critic.strengths.map((s) => el("li", { html: inlineSafe(s) })))]),
        el("div", {}, [el("p", { class: "eyebrow", text: `Areas to improve (${critic.improve.length})` }), el("ul", {}, critic.improve.map((s) => el("li", { html: inlineSafe(s) })))]),
      ]));
    } else {
      blocks.push(callout("warn", "Could not parse a score", ["The critic output did not follow the expected “Score: X/10” format. The raw output is shown below."]));
    }
    blocks.push(el("details", { class: "disclosure", style: { marginTop: "20px" } }, [
      el("summary", { text: "Raw critic output" }),
      el("div", { class: "disclosure-body prose", html: markdown(o.feedback || "") }),
    ]));

    // UI-side structural checks (deterministic, computed in the browser).
    const report = o.report || "";
    const sections = ["introduction", "key findings", "conclusion", "sources|references"];
    const has = (n) => sectionText(report, n, sections.filter((s) => s !== n)) !== null;
    const findingsText = sectionText(report, "key findings", ["conclusion", "sources|references"]) || "";
    const findingsCount = findingsText.split(/\r?\n/).filter((l) => /^\s*(#{2,4}\s+\S|\d+[.)]\s+\S|[-*]\s+\*\*)/.test(l)).length;
    const cited = sources.filter((s) => s.inReport);
    const grounded = cited.filter((s) => s.inSearch || s.inReader);
    const checks = [
      { ok: has("introduction"), text: "Introduction section present" },
      { ok: has("key findings"), text: "Key Findings section present" },
      { ok: findingsCount >= 3 ? true : findingsCount === 0 ? "warn" : false, text: `At least 3 key findings — ${findingsCount} detected (heuristic: headed, numbered or bold-bulleted items)` },
      { ok: has("conclusion"), text: "Conclusion section present" },
      { ok: has("sources|references"), text: "Sources section present" },
      { ok: cited.length ? (grounded.length === cited.length ? true : "warn") : false, text: cited.length ? `${grounded.length} of ${cited.length} URLs in the report also appear in the search or reader output` : "No URLs cited in the report" },
    ];
    blocks.push(el("div", { class: "sub-block" }, [
      el("h3", { text: "Structural checks" }),
      el("p", { class: "hint", style: { marginBottom: "12px" }, text: "Computed by this interface from the writer prompt's required structure — not part of the original pipeline." }),
      el("ul", { class: "checks" }, checks.map((c) => el("li", {}, [
        el("span", { class: `check-icon ${c.ok === true ? "pass" : c.ok === "warn" ? "warn" : "fail"}`, "aria-hidden": "true", text: c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✕" }),
        el("span", {}, [el("span", { class: "sr-only", text: c.ok === true ? "Pass: " : c.ok === "warn" ? "Warning: " : "Fail: " }), c.text]),
      ]))),
    ]));
    body.replaceChildren(...blocks);
  }

  function inlineSafe(s) {
    // Reuse the markdown renderer for a single line and strip the wrapping paragraph.
    return markdown(s).replace(/^<p>|<\/p>$/g, "");
  }

  /* ------------------------------------------------------------------ */
  /* Sources                                                            */
  /* ------------------------------------------------------------------ */
  function extractUrls(text) {
    const out = new Set();
    for (const m of String(text || "").matchAll(/https?:\/\/[^\s<>()\[\]"'`]+/g)) out.add(m[0].replace(/[.,;:!?*_]+$/, ""));
    return out;
  }
  const norm = (u) => u.replace(/\/+$/, "").replace(/^http:/, "https:").toLowerCase();

  function analyseSources(o) {
    const s = extractUrls(o.search_results), r = extractUrls(o.scraped_content), p = extractUrls(o.report);
    const all = new Map();
    const add = (set, key) => set.forEach((u) => { const k = norm(u); if (!all.has(k)) all.set(k, { url: u }); all.get(k)[key] = true; });
    add(s, "inSearch"); add(r, "inReader"); add(p, "inReport");
    return [...all.values()].map((x) => { try { x.domain = new URL(x.url).hostname.replace(/^www\./, ""); } catch { x.domain = x.url; } return x; });
  }

  function renderSources(list) {
    $("#sources-count").textContent = list.length ? String(list.length) : "";
    const body = $("#sources-body");
    if (!list.length) {
      body.replaceChildren(el("div", { class: "empty-state" }, [el("strong", { text: "No URLs found" }), el("span", { text: "None of the agent outputs or the report contained a URL." })]));
      return;
    }
    const ungrounded = list.filter((x) => x.inReport && !x.inSearch && !x.inReader).length;
    body.replaceChildren(
      el("p", { class: "hint", style: { marginBottom: "12px" }, text: "URLs extracted from the search agent's output, the reader agent's output and the final report. The pipeline does not verify citations; a report URL missing from the gathered material may be an unsupported or hallucinated source." }),
      ungrounded ? callout("warn", `${ungrounded} report URL${ungrounded === 1 ? "" : "s"} not found in the gathered material`, ["Check these before relying on the report."]) : null,
      el("ul", { class: "source-list", style: { marginTop: ungrounded ? "12px" : "0" } }, list.map((x) => el("li", {}, [
        el("span", { class: "domain", text: x.domain }),
        el("a", { href: x.url, target: "_blank", rel: "noopener noreferrer", text: x.url }),
        el("span", { class: "tags" }, [
          x.inSearch ? el("span", { class: "badge", text: "search" }) : null,
          x.inReader ? el("span", { class: "badge", text: "reader" }) : null,
          x.inReport ? el("span", { class: `badge ${x.inSearch || x.inReader ? "badge-ok" : "badge-warn"}`, text: x.inSearch || x.inReader ? "cited · found" : "cited · not found" }) : null,
        ]),
      ])))
    );
  }

  /* ------------------------------------------------------------------ */
  /* History                                                            */
  /* ------------------------------------------------------------------ */
  function saveHistory(run) {
    const items = storage.get(HISTORY_KEY, []).filter((x) => x.id !== run.id);
    const { log, ...rest } = run;
    items.unshift({ ...rest, log: undefined });
    if (!storage.set(HISTORY_KEY, items.slice(0, 10))) toast("Could not save this run in browser storage", "err");
  }

  async function renderHistory(activeId) {
    const saved = storage.get(HISTORY_KEY, []);
    let server = [];
    try { server = await api("/api/runs", { timeout: 5000 }); } catch { /* offline */ }
    const byId = new Map();
    for (const r of server) byId.set(r.id, { ...r, where: "server" });
    for (const r of saved) byId.set(r.id, { ...r, where: "saved" });
    const items = [...byId.values()].sort((a, b) => b.created_at - a.created_at);
    const list = $("#history");
    if (!items.length) { list.replaceChildren(el("li", { class: "hint", text: "No runs yet." })); return; }
    list.replaceChildren(...items.map((r) => el("li", {}, [
      el("button", {
        type: "button", "aria-current": r.id === (activeId || state.current?.id) ? "true" : "false",
        onclick: () => openHistory(r),
      }, [
        el("span", { class: "h-topic", text: r.topic, title: r.topic }),
        el("span", { class: "h-meta", text: `${r.status} · ${fmt.time(r.created_at * 1000)}${r.elapsed_s ? ` · ${fmt.secs(r.elapsed_s)}` : ""}` }),
      ]),
    ])));
  }

  async function openHistory(r) {
    if (r.where === "saved" && r.outputs) {
      stopPolling();
      setBusy($("#run-btn"), false);
      $("#run-progress").hidden = true;
      $("#run-alert").replaceChildren(callout("info", "Viewing a saved run", ["Loaded from this browser's storage. The console log is not stored."]));
      renderRun({ ...r, log: "(console output is not saved with history)" });
      renderOutputs(r);
      renderHistory(r.id);
      return;
    }
    try {
      const run = await api(`/api/runs/${r.id}`);
      if (run.status === "running" || run.status === "queued") follow(run.id, run);
      else { renderRun(run); if (run.status === "completed") renderOutputs(run); else finish(run); }
      renderHistory(run.id);
    } catch (err) { toast(err.message, "err"); }
  }

  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "report"; }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                             */
  /* ------------------------------------------------------------------ */
  $("#run-form").addEventListener("submit", (e) => { e.preventDefault(); startRun(); });
  $("#topic").addEventListener("input", () => {
    $("#topic-count").textContent = `${$("#topic").value.length} / 300`;
    if ($("#topic").getAttribute("aria-invalid") === "true") validateTopic();
  });
  $("#topic").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); startRun(); } });
  $$("[data-example]").forEach((b) => b.addEventListener("click", () => {
    $("#topic").value = b.dataset.example;
    $("#topic").dispatchEvent(new Event("input"));
    $("#topic").focus();
  }));
  $("#history-clear").addEventListener("click", () => { storage.set(HISTORY_KEY, []); renderHistory(); toast("Saved history cleared", "ok", 2000); });

  boot();
})();
