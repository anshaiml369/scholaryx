from langchain.tools import tool 
import ipaddress
import socket
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup
from tavily import TavilyClient
import os 
from dotenv import load_dotenv
from rich import print
load_dotenv()

tavily = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))

@tool
def web_search(query : str) -> str:
    """Search the web for recent and reliable information on a topic . Returns Titles , URLs and snippets."""
    results = tavily.search(query=query,max_results=5)

    out = []

    for r in results['results']:
        out.append(
            f"Title: {r['title']}\nURL: {r['url']}\nSnippet: {r['content'][:300]}\n"
        )
    
    return "\n----\n".join(out)

# SSRF protection for scrape_url: the URL is chosen by the LLM, so on a public server it must not be
# able to reach loopback, private-network or cloud-metadata addresses.
MAX_REDIRECTS = 3
MAX_RESPONSE_BYTES = 2_000_000


def _check_public_url(url: str) -> None:
    """Raise ValueError unless url is http(s) and every address its host resolves to is public."""
    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("only http(s) URLs can be scraped")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(parts.hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ValueError(f"could not resolve host {parts.hostname}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        if not ip.is_global:
            raise ValueError(f"{parts.hostname} is not a public address")


def _safe_get(url: str) -> requests.Response:
    """GET with the public-address check applied to the URL and to every redirect, and a size cap."""
    for _ in range(MAX_REDIRECTS + 1):
        _check_public_url(url)
        resp = requests.get(url, timeout=8, headers={"User-Agent": "Mozilla/5.0"},
                            allow_redirects=False, stream=True)
        if resp.is_redirect:
            url = urljoin(url, resp.headers.get("location", ""))
            resp.close()
            continue
        body = b""
        for chunk in resp.iter_content(64 * 1024):
            body += chunk
            if len(body) >= MAX_RESPONSE_BYTES:
                break
        resp.close()
        resp._content = body[:MAX_RESPONSE_BYTES]
        return resp
    raise ValueError(f"more than {MAX_REDIRECTS} redirects")


@tool
def scrape_url(url: str) -> str:
    """Scrape and return clean text content from a given URL for deeper reading."""
    try:
        resp = _safe_get(url)
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer"]):
            tag.decompose()
        return soup.get_text(separator=" ", strip=True)[:3000]
    except Exception as e:
        return f"Could not scrape URL: {str(e)}"

