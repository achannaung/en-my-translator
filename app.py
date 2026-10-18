#!/usr/bin/env python3
"""English <-> Burmese Translator - local web UI + thin provider proxy.

The static frontend in ``static/`` does ALL the heavy lifting in the browser:
file parsing (PDF/DOCX/ePub), OCR fallback, document chunking, streaming
display, glossary handling and export. This tiny Flask server only:

  1. serves the static frontend,
  2. holds provider API keys in ``.env`` (never sent to the browser), and
  3. proxies *streaming* translation requests to OpenAI / OpenRouter / Gemini.

Running the calls server-side also sidesteps browser CORS restrictions.

Usage:
    pip install -r requirements.txt
    cp .env.example .env        # then add your key(s)
    python app.py               # -> http://127.0.0.1:5059
"""

from __future__ import annotations

import json
import os
import re
from typing import Iterator

import requests
from dotenv import load_dotenv
from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_from_directory,
    stream_with_context,
)

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")

load_dotenv(os.path.join(ROOT, ".env"))

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")

PORT = int(os.getenv("PORT", "5059"))
REQUEST_TIMEOUT = (10, 600)  # (connect, read) seconds
DEFAULT_TEMPERATURE = float(os.getenv("TEMPERATURE", "0.2"))

PROVIDERS = {
    "openai": {"env": "OPENAI_API_KEY", "label": "OpenAI"},
    "openrouter": {"env": "OPENROUTER_API_KEY", "label": "OpenRouter"},
    "gemini": {"env": "GEMINI_API_KEY", "label": "Google Gemini"},
}

LANG_NAMES = {
    "en": "English",
    "my": "Burmese (Myanmar language)",
    "auto": "the source language",
}

# Ordered regex preferences used to auto-pick a good translation model.
PREFERRED_MODELS = {
    "gemini": [
        r"^gemini-flash-latest$",
        r"^gemini-[\d.]+-flash$",
        r"^gemini-[\d.]+-flash-lite$",
        r"gemini.*flash",
        r"^gemini-pro-latest$",
        r"gemini.*pro",
    ],
    "openai": [
        r"^gpt-4o-mini$",
        r"^gpt-4\.1-mini$",
        r"^gpt-4o$",
        r"^gpt-4\.1$",
        r"^gpt-4",
        r"^o\d-mini$",
        r"^gpt-",
    ],
    "openrouter": [
        r"gpt-4o-mini",
        r"gemini.*flash",
        r"claude.*haiku",
        r"claude",
        r"llama.*instruct",
        r"qwen",
    ],
}

# Substrings that mark a model as non-text (skip when listing/auto-picking).
NON_TEXT_MARKERS = (
    "embedding",
    "embed",
    "tts",
    "whisper",
    "audio",
    "realtime",
    "dall-e",
    "dalle",
    "moderation",
    "image",
    "imagen",
    "veo",
    "lyria",
    "robotics",
    "computer-use",
    "nano-banana",
    "aqa",
    "deep-research",
    "transcribe",
    "gemma",  # small open models; kept out of the auto-pick
)


class ProviderError(Exception):
    """A clean, user-facing error from an upstream provider."""


# --------------------------------------------------------------------------- #
# Prompt building
# --------------------------------------------------------------------------- #
def build_system_prompt(source: str, target: str, glossary: list[dict]) -> str:
    src = LANG_NAMES.get(source, "the source language")
    tgt = LANG_NAMES.get(target, "Burmese (Myanmar language)")

    lines = [
        f"You are a professional {src} to {tgt} translator.",
        "",
        "Rules:",
        "- Output ONLY the translation. No notes, no preamble, no explanations.",
        "- Preserve paragraph structure exactly: keep the same number of "
        "paragraphs, separated by a single blank line.",
        "- Preserve lists, numbering, and punctuation style.",
        "- Keep proper nouns, numbers, code, and URLs accurate.",
        "- Use natural, fluent modern Burmese (Unicode). Never output Zawgyi.",
    ]

    clean = [
        g
        for g in glossary or []
        if isinstance(g, dict) and str(g.get("source", "")).strip()
    ]
    if clean:
        lines.append("")
        lines.append("Glossary - always use these exact term translations:")
        for g in clean:
            lines.append(f'  "{g["source"]}" -> "{g.get("target", "")}"')

    return "\n".join(lines)


def _extract_error(response: requests.Response) -> str:
    """Pull a readable message out of a non-200 provider response."""
    try:
        body = response.json()
    except ValueError:
        text = (response.content or b"").decode("utf-8", errors="replace").strip()
        return text[:400] or f"HTTP {response.status_code}"

    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:400]
        if isinstance(err, str):
            return err[:400]
        if body.get("message"):
            return str(body["message"])[:400]
    return json.dumps(body)[:400]


# --------------------------------------------------------------------------- #
# Provider streamers - each yields text deltas
# --------------------------------------------------------------------------- #
def _iter_sse_data(response: requests.Response) -> Iterator[str]:
    # Decode as UTF-8 ourselves. requests falls back to ISO-8859-1 for
    # text/* streams that omit a charset, which turns Myanmar Unicode into
    # mojibake ("áá¬...").
    for raw in response.iter_lines(decode_unicode=False):
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace").strip()
        if line.startswith("data:"):
            yield line[5:].strip()


def stream_openai_compatible(url, api_key, model, system, text, extra_headers=None):
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)

    payload = {
        "model": model,
        "stream": True,
        "temperature": DEFAULT_TEMPERATURE,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
    }

    resp = requests.post(
        url, headers=headers, json=payload, stream=True, timeout=REQUEST_TIMEOUT
    )
    with resp:
        if resp.status_code != 200:
            raise ProviderError(_extract_error(resp))
        for data in _iter_sse_data(resp):
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            piece = delta.get("content")
            if piece:
                yield piece


def stream_gemini(api_key, model, system, text):
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:streamGenerateContent"
    )
    params = {"alt": "sse", "key": api_key}
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {"temperature": DEFAULT_TEMPERATURE},
    }

    resp = requests.post(
        url, params=params, json=payload, stream=True, timeout=REQUEST_TIMEOUT
    )
    with resp:
        if resp.status_code != 200:
            raise ProviderError(_extract_error(resp))
        for data in _iter_sse_data(resp):
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            if isinstance(obj, dict) and obj.get("error"):
                raise ProviderError(str(obj["error"].get("message", obj["error"]))[:400])
            for cand in obj.get("candidates", []) or []:
                for part in cand.get("content", {}).get("parts", []) or []:
                    piece = part.get("text")
                    if piece:
                        yield piece


def stream_provider(provider, model, system, text, api_key=None):
    cfg = PROVIDERS.get(provider)
    if not cfg:
        raise ProviderError(f"Unknown provider: {provider}")

    # A key supplied in the request (typed into the web UI) wins over .env.
    key = (api_key or "").strip() or (os.getenv(cfg["env"]) or "").strip()
    if not key:
        raise ProviderError(
            f"No API key for {cfg['label']}. Enter one in the app, or add "
            f"{cfg['env']} to your .env file."
        )

    if provider == "openai":
        base = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        yield from stream_openai_compatible(
            f"{base}/chat/completions", key, model, system, text
        )
    elif provider == "openrouter":
        extra = {
            "HTTP-Referer": os.getenv(
                "OPENROUTER_SITE_URL", f"http://127.0.0.1:{PORT}"
            ),
            "X-Title": os.getenv("OPENROUTER_APP_NAME", "EN-MY Translator"),
        }
        yield from stream_openai_compatible(
            "https://openrouter.ai/api/v1/chat/completions",
            key,
            model,
            system,
            text,
            extra,
        )
    elif provider == "gemini":
        yield from stream_gemini(key, model, system, text)


# --------------------------------------------------------------------------- #
# Model discovery (for auto-selecting a model from the provider)
# --------------------------------------------------------------------------- #
def _is_text_model(model_id: str, provider: str) -> bool:
    low = model_id.lower()
    return not any(marker in low for marker in NON_TEXT_MARKERS)


def pick_best_model(provider: str, model_ids: list[str]) -> str | None:
    for pattern in PREFERRED_MODELS.get(provider, []):
        rx = re.compile(pattern, re.IGNORECASE)
        for mid in model_ids:
            if rx.search(mid):
                return mid
    return model_ids[0] if model_ids else None


def list_models(provider: str, key: str) -> list[str]:
    """Return the text-generation model ids available to this key."""
    if provider == "gemini":
        resp = requests.get(
            "https://generativelanguage.googleapis.com/v1beta/models",
            params={"key": key, "pageSize": 200},
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            raise ProviderError(_extract_error(resp))
        ids = []
        for m in resp.json().get("models", []):
            name = str(m.get("name", "")).replace("models/", "")
            methods = m.get("supportedGenerationMethods", []) or []
            if name and "generateContent" in methods and _is_text_model(name, provider):
                ids.append(name)
        return ids

    if provider == "openai":
        base = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        url, headers = f"{base}/models", {"Authorization": f"Bearer {key}"}
    else:  # openrouter
        url = "https://openrouter.ai/api/v1/models"
        headers = {
            "Authorization": f"Bearer {key}",
            "HTTP-Referer": os.getenv(
                "OPENROUTER_SITE_URL", f"http://127.0.0.1:{PORT}"
            ),
            "X-Title": os.getenv("OPENROUTER_APP_NAME", "EN-MY Translator"),
        }

    resp = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    if resp.status_code != 200:
        raise ProviderError(_extract_error(resp))
    return [
        str(m.get("id"))
        for m in resp.json().get("data", [])
        if m.get("id") and _is_text_model(str(m["id"]), provider)
    ]


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/api/providers")
def providers():
    return jsonify(
        {
            "providers": {
                name: bool((os.getenv(cfg["env"]) or "").strip())
                for name, cfg in PROVIDERS.items()
            },
            "labels": {name: cfg["label"] for name, cfg in PROVIDERS.items()},
            "defaults": {
                "provider": os.getenv("DEFAULT_PROVIDER", "gemini"),
                "openai_model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                "openrouter_model": os.getenv(
                    "OPENROUTER_MODEL", "openai/gpt-4o-mini"
                ),
                "gemini_model": os.getenv("GEMINI_MODEL", "gemini-flash-latest"),
            },
        }
    )


@app.post("/api/models")
def models():
    data = request.get_json(force=True, silent=True) or {}
    provider = str(data.get("provider") or "").strip()
    cfg = PROVIDERS.get(provider)
    if not cfg:
        return jsonify({"error": f"Unknown provider: {provider or '(none)'}"}), 400

    key = str(data.get("api_key") or "").strip() or (os.getenv(cfg["env"]) or "").strip()
    if not key:
        return jsonify({"error": f"No API key for {cfg['label']}."}), 400

    try:
        ids = list_models(provider, key)
    except ProviderError as exc:
        return jsonify({"error": str(exc)}), 502
    except requests.RequestException as exc:
        return jsonify({"error": f"Network error: {exc}"}), 502

    ids.sort()
    return jsonify({"models": ids, "suggested": pick_best_model(provider, ids)})


@app.post("/api/translate")
def translate():
    data = request.get_json(force=True, silent=True) or {}

    provider = str(data.get("provider") or "").strip()
    model = str(data.get("model") or "").strip()
    api_key = str(data.get("api_key") or "").strip()
    text = str(data.get("text") or "")
    source = str(data.get("source") or "auto").strip()
    target = str(data.get("target") or "my").strip()
    glossary = data.get("glossary") or []

    if provider not in PROVIDERS:
        return jsonify({"error": f"Unknown provider: {provider or '(none)'}"}), 400
    if not model:
        return jsonify({"error": "A model is required."}), 400
    if not text.strip():
        return jsonify({"error": "The text to translate is empty."}), 400
    if source != "auto" and source == target:
        return jsonify({"error": "Source and target languages are the same."}), 400

    system = build_system_prompt(source, target, glossary)

    def event_stream():
        try:
            for piece in stream_provider(provider, model, system, text, api_key):
                yield f"data: {json.dumps({'delta': piece}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except ProviderError as exc:
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"
        except requests.Timeout:
            yield f"data: {json.dumps({'error': 'The provider timed out.'}, ensure_ascii=False)}\n\n"
        except requests.RequestException as exc:
            yield f"data: {json.dumps({'error': f'Network error: {exc}'}, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001 - keep the stream alive
            yield f"data: {json.dumps({'error': f'Unexpected error: {exc}'}, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    print(f"EN-MY Translator running at http://{host}:{PORT}")
    configured = [
        cfg["label"]
        for name, cfg in PROVIDERS.items()
        if (os.getenv(cfg["env"]) or "").strip()
    ]
    print("Configured providers:", ", ".join(configured) or "none - add keys to .env")
    app.run(host=host, port=PORT, threaded=True, debug=False)
