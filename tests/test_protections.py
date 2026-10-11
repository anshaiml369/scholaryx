"""Tests for the public-deployment protections: scraper SSRF guard and server usage limits.

No paid API is called: keys are dummy values and the pipeline is replaced by a fake module.
Run from the project root:  python -m unittest discover tests -v
"""
import os
import sys
import time
import types
import unittest
from unittest import mock

# Dummy keys must be set before tools.py / server.py run load_dotenv(), which never overrides set variables.
os.environ["OPENAI_API_KEY"] = "test-dummy-openai"
os.environ["TAVILY_API_KEY"] = "test-dummy-tavily"
os.environ["RUNS_PER_DAY"] = "4"
os.environ["RUNS_PER_IP_PER_HOUR"] = "2"
os.environ["MAX_CONCURRENT_RUNS"] = "10"
os.environ["PUBLIC_DEMO"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

import tools  # noqa: E402

# Fake pipeline: server.py imports `pipeline` lazily inside the run thread.
fake_pipeline = types.ModuleType("pipeline")
fake_pipeline.run_research_pipeline = lambda topic: {
    "search_results": "s", "scraped_content": "c", "report": f"report on {topic}", "feedback": "Score: 7/10"}
sys.modules["pipeline"] = fake_pipeline

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def scrape(url):
    return tools.scrape_url.func(url)


class ScraperSSRFTests(unittest.TestCase):
    BLOCKED = [
        "http://127.0.0.1/", "http://localhost:8000/", "http://127.1/", "http://2130706433/", "http://0x7f000001/",
        "http://0.0.0.0/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/", "http://172.16.0.1/",
        "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/",
        "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "http:///nohost",
    ]

    def test_blocked_addresses_are_never_requested(self):
        with mock.patch.object(tools.requests, "get", side_effect=AssertionError("network request made")) as get:
            for url in self.BLOCKED:
                with self.subTest(url=url):
                    out = scrape(url)
                    self.assertTrue(out.startswith("Could not scrape URL:"), out)
            get.assert_not_called()

    def _response(self, status, headers=None, body=b""):
        r = requests.Response()
        r.status_code, r.url, r._content, r.encoding = status, "http://x", None, "utf-8"
        r.headers.update(headers or {})
        r.raw = mock.Mock()
        r.iter_content = lambda size: iter([body])
        return r

    def test_redirect_to_private_address_is_blocked(self):
        public = [(2, 1, 6, "", ("93.184.216.34", 80))]
        with mock.patch.object(tools.socket, "getaddrinfo", side_effect=lambda h, *a, **k:
                               public if h == "public.example" else [(2, 1, 6, "", ("127.0.0.1", 80))]), \
             mock.patch.object(tools.requests, "get", return_value=self._response(302, {"location": "http://internal.example/"})) as get:
            out = scrape("http://public.example/start")
        self.assertIn("not a public address", out)
        self.assertEqual(get.call_count, 1)  # the private redirect target was never fetched

    def test_redirect_limit(self):
        public = [(2, 1, 6, "", ("93.184.216.34", 80))]
        with mock.patch.object(tools.socket, "getaddrinfo", return_value=public), \
             mock.patch.object(tools.requests, "get", return_value=self._response(301, {"location": "/again"})) as get:
            out = scrape("http://public.example/loop")
        self.assertIn("redirects", out)
        self.assertEqual(get.call_count, tools.MAX_REDIRECTS + 1)

    def test_response_size_is_capped(self):
        public = [(2, 1, 6, "", ("93.184.216.34", 80))]
        big = b"<p>" + b"a" * (tools.MAX_RESPONSE_BYTES * 2) + b"</p>"
        with mock.patch.object(tools.socket, "getaddrinfo", return_value=public), \
             mock.patch.object(tools.requests, "get", return_value=self._response(200, {"content-type": "text/html"}, big)):
            resp = tools._safe_get("http://public.example/big")
        self.assertLessEqual(len(resp.content), tools.MAX_RESPONSE_BYTES)

    def test_public_page_text_unchanged(self):
        """A real public page gives the same text as the original implementation (needs internet)."""
        url = "https://example.com/"
        try:
            original = requests.get(url, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
        except requests.RequestException as exc:
            self.skipTest(f"no internet: {exc}")
        soup = tools.BeautifulSoup(original.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer"]):
            tag.decompose()
        expected = soup.get_text(separator=" ", strip=True)[:3000]
        self.assertEqual(scrape(url), expected)
        self.assertIn("Example Domain", expected)


class UsageLimitTests(unittest.TestCase):
    def setUp(self):
        server.RUNS.clear()
        server._RUN_STARTS.clear()
        server._CLIENT_STARTS.clear()
        self.client = TestClient(server.app)

    def start(self, ip):
        return self.client.post("/api/runs", json={"topic": "graph neural networks"}, headers={"X-Forwarded-For": ip})

    def wait_done(self, run_id):
        for _ in range(100):
            if self.client.get(f"/api/runs/{run_id}").json()["status"] in ("completed", "failed"):
                return
            time.sleep(0.05)

    def test_per_client_hourly_limit(self):
        for _ in range(2):
            r = self.start("203.0.113.5")
            self.assertEqual(r.status_code, 202, r.text)
            self.wait_done(r.json()["id"])
        r = self.start("203.0.113.5")
        self.assertEqual(r.status_code, 429)
        self.assertIn("in the last hour", r.json()["detail"]["message"])
        self.assertEqual(self.start("198.51.100.7").status_code, 202)  # another visitor is unaffected

    def test_daily_limit_applies_to_everyone(self):
        for i in range(4):
            r = self.start(f"203.0.113.{i + 10}")
            self.assertEqual(r.status_code, 202, r.text)
            self.wait_done(r.json()["id"])
        r = self.start("198.51.100.99")
        self.assertEqual(r.status_code, 429)
        self.assertIn("per day", r.json()["detail"]["message"])

    def test_limits_expire(self):
        old = time.time() - 86401
        server._RUN_STARTS.extend([old] * 4)
        server._CLIENT_STARTS["203.0.113.5"] = server.deque([time.time() - 3601] * 2)
        self.assertEqual(self.start("203.0.113.5").status_code, 202)

    def test_health_reports_remaining_runs(self):
        r = self.start("203.0.113.5")
        self.wait_done(r.json()["id"])
        limits = self.client.get("/api/health", headers={"X-Forwarded-For": "203.0.113.5"}).json()["limits"]
        self.assertEqual(limits["runs_left_today"], 3)
        self.assertEqual(limits["your_runs_left_this_hour"], 1)

    def test_run_list_hidden_in_public_mode(self):
        r = self.start("203.0.113.5")
        self.wait_done(r.json()["id"])
        self.assertEqual(self.client.get("/api/runs").json(), [])
        run = self.client.get(f"/api/runs/{r.json()['id']}").json()  # the owner can still poll by id
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["outputs"]["report"], "report on graph neural networks")

    def test_invalid_topic_does_not_use_a_slot(self):
        self.assertEqual(self.client.post("/api/runs", json={"topic": "ab"}).status_code, 422)
        self.assertEqual(len(server._RUN_STARTS), 0)


if __name__ == "__main__":
    unittest.main()
