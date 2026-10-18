# EN ⇄ MY Translator

A local web app for translating between **English** and **Burmese (Myanmar)**.
Paste text or upload a document (PDF, Word, ePub, TXT/Markdown), translate it
with your own OpenAI / OpenRouter / Google Gemini key, and export the result.

## How it works

- **Static frontend** (`static/`) does all the work in the browser: file
  parsing, OCR fallback for scanned PDFs, long-document chunking, streaming
  display, glossary handling and export. No build step.
- **Thin Flask proxy** (`app.py`) serves the frontend, keeps your API keys in
  `.env` (they never reach the browser), and proxies streaming translation
  requests to the provider. Proxying also avoids browser CORS restrictions.

## Features

| Feature | Notes |
| --- | --- |
| Providers | OpenAI, OpenRouter, Google Gemini. |
| API keys | Paste a key directly in the UI, **or** set it in `.env`. A UI key overrides `.env`. |
| Model | Auto-selected: the app lists the models your key can access and picks a good one. Untick *Auto-select* to choose manually. |
| Inputs | Pasted text, PDF, DOCX, ePub, TXT/Markdown. |
| OCR | Scanned/image PDFs fall back to Tesseract OCR (English + Burmese). |
| Long documents | Text is split into size-limited chunks, translated in sequence, reassembled. |
| Streaming | Translation appears as it is generated; Stop cancels mid-way. |
| Bilingual view | Source and translation aligned paragraph by paragraph. |
| Glossary | Define `source = target` term pairs to keep names/terms consistent. |
| Export | Download the translation as `.txt` or `.docx` (Padauk font set for Burmese). |
| Fonts | Noto Sans Myanmar + Padauk are loaded so Burmese renders correctly. |

## Setup

```bash
cd en-my-translator
python3 -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env                # then edit .env
python app.py                       # -> http://127.0.0.1:5059
```

Add a key either way:

- **In the UI** – pick a provider and paste the key into the **API key** field.
  Tick *Remember in this browser* to keep it in `localStorage`; otherwise it
  lives only in memory for the session. Providers that already have a key in
  `.env` are marked *(env)* and can be left blank.
- **In `.env`** – convenient for a single machine, never sent to the browser:

```env
GEMINI_API_KEY=your-key-here
# OPENAI_API_KEY=...
# OPENROUTER_API_KEY=...
```

Open <http://127.0.0.1:5059>. A key typed in the UI takes precedence over `.env`
for that request.

You do not need to choose a model — just pick a provider and enter a key. The
app queries that provider for the models your key can use and auto-selects one
(`/api/models`). Tick *Auto-select the best model* off to type a model yourself.

## Getting an API key

- **Google Gemini** – <https://aistudio.google.com/apikey> (generous free tier)
- **OpenRouter** – <https://openrouter.ai/keys> (many models, one key)
- **OpenAI** – <https://platform.openai.com/api-keys>

## Notes & tips

- **Cost/length:** a whole book means many chunk requests. The chunk size is
  adjustable in Settings (default 4000 characters).
- **Paragraph alignment:** the bilingual view relies on the model preserving
  the number of blank-line-separated paragraphs; if a chunk comes back merged,
  that chunk is shown as a single pair rather than mis-aligned lines.
- **OCR quality:** Tesseract is good for clean scans. Toggle it off for
  text-based PDFs (it is skipped automatically when a text layer exists).
- **Privacy:** nothing is stored on the server. Documents are parsed locally in
  your browser; only the text being translated is sent to your chosen provider.
- **Key storage:** a key typed in the UI is sent only to your local proxy. If
  you tick *Remember in this browser* it is saved in `localStorage` in plain
  text (this is a local, single-user app) — leave it unticked on shared machines.
- **Zawgyi vs Unicode:** the app outputs Unicode Burmese. If you paste Zawgyi
  text you may want to convert it first.

## Deploy on Render

Render runs a persistent process, so the app works as-is. `render.yaml` (a
Render Blueprint) and a `Procfile` are included; the production server is
**gunicorn** with `gthread` workers (streaming SSE does not buffer).

**Blueprint (easiest):**

1. Push this folder to a GitHub/GitLab repo.
2. Render → **New → Blueprint** → pick the repo → Apply.
3. Render reads `render.yaml` and creates the web service.

**Or set it up manually** (New → Web Service):

| Setting | Value |
| --- | --- |
| Runtime | Python |
| Build command | `pip install -r requirements.txt` |
| Start command | `gunicorn app:app --bind 0.0.0.0:$PORT --worker-class gthread --threads 8 --timeout 0` |

**Environment variables:** the API keys are **optional**. Recommended for a
public URL: leave them blank and enter a key in the page (it is sent only to
your proxy for that request, and never stored server-side). If you do set
`GEMINI_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` in the Render
dashboard, treat the URL as private.

> **Security:** a deployed URL is public. If you put your own key in the server
> environment, anyone with the link can spend your quota. Leave the keys unset
> and make each visitor bring their own key, or protect the service (Render
> private services / an access password).

Notes: Blueprint users configure the file. Lightweight hosts wipe the disk on
each deploy — this app stores nothing server-side, so that is fine. On the free
plan the service sleeps when idle and cold-starts on the next request.

## Project layout

```
en-my-translator/
├── app.py              # Flask proxy + static server
├── requirements.txt
├── render.yaml         # Render Blueprint
├── Procfile            # gunicorn start command
├── .env.example
└── static/
    ├── index.html
    ├── styles.css
    └── app.js
```
