/* EN <-> MY Translator - browser logic.
 *
 * Everything here runs client-side:
 *   - file parsing (PDF via pdf.js, DOCX via mammoth, ePub via JSZip+DOMParser)
 *   - OCR fallback for scanned PDFs via tesseract.js
 *   - long-document chunking
 *   - streaming translation against the local Flask proxy (/api/translate)
 *   - bilingual alignment and TXT / DOCX export
 */

const PDFJS_VERSION = "4.6.82";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;
const MAX_FILE_BYTES = 80 * 1024 * 1024;

const MODEL_CATALOG = {
  gemini: [
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemini-3.8-flash",
    "gemini-3.5-flash",
    "gemini-2.5-flash-lite",
  ],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
  openrouter: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen-2.5-72b-instruct",
  ],
};

const els = {};
const state = {
  cfg: null,
  configured: {}, // provider -> bool (has key in .env)
  keys: {}, // provider -> manual key typed in the UI
  savedProvider: null,
  running: false,
  abort: null,
  pairs: [], // [{ src, tgt }]
  chunkCount: 0,
};

let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) {
    _pdfjs = await import(`${PDFJS_BASE}/pdf.min.mjs`);
    _pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
  }
  return _pdfjs;
}

/* ------------------------------------------------------------------ setup */
function cacheEls() {
  [
    "provider", "model", "modelList", "source", "target", "swap", "chunkSize",
    "glossary", "ocrEnabled", "ocrLang", "dropzone", "fileInput", "fileList",
    "sourceText", "sourceCount", "clearSource", "translateBtn", "stopBtn",
    "progressBar", "progressText", "translationOut", "bilingualOut", "toast",
    "copyBtn", "txtBtn", "docxBtn", "resultCount", "providerStatus",
    "apiKey", "toggleKey", "rememberKey", "keyHint",
    "autoModel", "modelHint",
  ].forEach((id) => (els[id] = document.getElementById(id)));
}

async function init() {
  cacheEls();
  bindEvents();
  restoreSettings();
  updateSourceCount();
  try {
    await loadProviders();
  } catch (err) {
    setStatus("Could not reach the server", "warn");
  }
}

async function loadProviders() {
  const res = await fetch("/api/providers");
  const cfg = await res.json();
  state.cfg = cfg;
  state.configured = cfg.providers || {};

  // Always list every provider - a key can be typed in the UI even when it is
  // not present in .env. Providers with an .env key are marked "(env)".
  const names = Object.keys(cfg.labels || {});
  els.provider.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent =
      (cfg.labels?.[name] || name) + (state.configured[name] ? " (env)" : "");
    els.provider.appendChild(opt);
  }

  const preferred = names.includes(state.savedProvider)
    ? state.savedProvider
    : names.includes(cfg.defaults?.provider)
    ? cfg.defaults.provider
    : names[0];
  if (preferred) els.provider.value = preferred;

  refreshModels();
  loadKeyForProvider();
  setModelEditable();
  autoSelectModel();
}

function setModelEditable() {
  els.model.readOnly = els.autoModel.checked;
}

let autoModelTimer = null;
function scheduleAutoModel() {
  clearTimeout(autoModelTimer);
  autoModelTimer = setTimeout(autoSelectModel, 500);
}

async function autoSelectModel() {
  const provider = els.provider.value;
  if (!provider) return;

  if (!els.autoModel.checked) {
    updateModelHint();
    return;
  }

  // Never leave the field empty: show an offline default immediately.
  if (!els.model.value.trim()) els.model.value = defaultModel(provider);

  const apiKey = (state.keys[provider] || "").trim();
  if (!apiKey && !state.configured?.[provider]) {
    updateModelHint();
    return;
  }

  els.modelHint.textContent = "auto · checking…";
  try {
    const res = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key: apiKey }),
    });
    const data = await res.json();
    if (data.error) {
      updateModelHint("auto (could not list)");
      return;
    }
    const models = Array.isArray(data.models) ? data.models : [];
    if (models.length) {
      els.modelList.innerHTML = models
        .map((m) => `<option value="${m}"></option>`)
        .join("");
      if (data.suggested) els.model.value = data.suggested;
      updateModelHint(`auto · ${models.length} models`);
    } else {
      updateModelHint();
    }
  } catch (_) {
    updateModelHint();
  }
}

function updateModelHint(text) {
  if (!els.autoModel.checked) {
    els.modelHint.textContent = "manual";
  } else {
    els.modelHint.textContent = text || "auto";
  }
}

function loadKeyForProvider() {
  const provider = els.provider.value;
  els.apiKey.value = state.keys[provider] || "";
  updateKeyHint();
  updateStatus();
}

function updateKeyHint() {
  const provider = els.provider.value;
  const manual = (els.apiKey.value || "").trim();
  if (manual) els.keyHint.textContent = "using key from this page";
  else if (state.configured?.[provider]) els.keyHint.textContent = "using key from .env";
  else els.keyHint.textContent = "required";
}

function updateStatus() {
  const provider = els.provider.value;
  const label = state.cfg?.labels?.[provider] || provider;
  const hasKey = (state.keys[provider] || "").trim() || state.configured?.[provider];
  if (hasKey) setStatus(`Ready — ${label}`, "ok");
  else setStatus(`API key needed — ${label}`, "warn");
}

function defaultModel(provider) {
  return state.cfg?.defaults?.[`${provider}_model`] || MODEL_CATALOG[provider]?.[0] || "";
}

function refreshModels() {
  const provider = els.provider.value;
  const list = MODEL_CATALOG[provider] || [];
  els.modelList.innerHTML = list
    .map((m) => `<option value="${m}"></option>`)
    .join("");
  const current = els.model.value.trim();
  const known = Object.values(MODEL_CATALOG).flat();
  if (!current || (!list.includes(current) && !known.includes(current))) {
    els.model.value = defaultModel(provider);
  }
}

function setStatus(text, kind) {
  els.providerStatus.textContent = text;
  els.providerStatus.className = "provider-status" + (kind ? " " + kind : "");
}

/* ----------------------------------------------------------------- events */
function bindEvents() {
  els.provider.addEventListener("change", () => {
    els.model.value = "";
    refreshModels();
    loadKeyForProvider();
    setModelEditable();
    autoSelectModel();
    persist();
  });
  els.model.addEventListener("input", persist);
  els.chunkSize.addEventListener("input", persist);

  els.autoModel.addEventListener("change", () => {
    setModelEditable();
    if (els.autoModel.checked) autoSelectModel();
    else updateModelHint();
    persist();
  });

  // Manual API key
  els.apiKey.addEventListener("input", () => {
    const provider = els.provider.value;
    const value = els.apiKey.value.trim();
    if (value) state.keys[provider] = value;
    else delete state.keys[provider];
    saveRememberedKeys();
    updateKeyHint();
    updateStatus();
    scheduleAutoModel();
  });
  els.toggleKey.addEventListener("click", () => {
    els.apiKey.type = els.apiKey.type === "password" ? "text" : "password";
  });
  els.rememberKey.addEventListener("change", () => {
    saveRememberedKeys();
    toast(
      els.rememberKey.checked
        ? "API key will be remembered in this browser"
        : "Remembered API keys cleared"
    );
  });

  els.swap.addEventListener("click", () => {
    let src = els.source.value;
    let tgt = els.target.value;
    if (src === "auto") {
      src = tgt;
      tgt = tgt === "my" ? "en" : "my";
    } else {
      [src, tgt] = [tgt, src];
    }
    els.source.value = src;
    els.target.value = tgt;
    persist();
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.tab + "Pane").classList.add("active");
    });
  });

  // Dropzone
  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", () => {
    handleFiles(els.fileInput.files);
    els.fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("dragover");
    })
  );
  els.dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  els.sourceText.addEventListener("input", () => {
    updateSourceCount();
    persist();
  });
  els.clearSource.addEventListener("click", () => {
    els.sourceText.value = "";
    els.fileList.innerHTML = "";
    updateSourceCount();
  });

  els.translateBtn.addEventListener("click", runTranslation);
  els.stopBtn.addEventListener("click", () => state.abort?.abort());
  els.copyBtn.addEventListener("click", copyResult);
  els.txtBtn.addEventListener("click", exportTxt);
  els.docxBtn.addEventListener("click", exportDocx);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runTranslation();
  });
}

/* -------------------------------------------------------------- file input */
async function handleFiles(fileList) {
  for (const file of Array.from(fileList)) {
    if (file.size > MAX_FILE_BYTES) {
      addFileRow(file.name, "too large", "err");
      continue;
    }
    const row = addFileRow(file.name, '<span class="spinner"></span>', "");
    const statusEl = row.querySelector(".status");
    try {
      const text = await extractFile(file, (msg) => (statusEl.textContent = msg));
      const clean = (text || "").trim();
      if (!clean) throw new Error("no text found");
      appendToSource(clean);
      statusEl.textContent = `${clean.length.toLocaleString()} chars`;
      statusEl.className = "status ok";
    } catch (err) {
      statusEl.textContent = err.message || "failed";
      statusEl.className = "status err";
      toast(`${file.name}: ${err.message || "could not read file"}`, true);
    }
  }
}

function addFileRow(name, statusHtml, cls) {
  const row = document.createElement("div");
  row.className = "file-item";
  row.innerHTML = `
    <span class="name"></span>
    <span class="status ${cls}"></span>
    <button class="remove" type="button" title="Remove">✕</button>`;
  row.querySelector(".name").textContent = name;
  const statusEl = row.querySelector(".status");
  if (statusHtml.includes("<")) statusEl.innerHTML = statusHtml;
  else statusEl.textContent = statusHtml;
  row.querySelector(".remove").addEventListener("click", () => row.remove());
  els.fileList.appendChild(row);
  return row;
}

function appendToSource(text) {
  const existing = els.sourceText.value.trim();
  els.sourceText.value = existing ? existing + "\n\n" + text : text;
  updateSourceCount();
  persist();
}

async function extractFile(file, onStatus) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return extractPdf(file, onStatus);
  if (ext === "docx") return extractDocx(file);
  if (ext === "doc")
    throw new Error("Legacy .doc not supported - save as .docx");
  if (ext === "epub") return extractEpub(file);
  if (["txt", "md", "markdown", "text", ""].includes(ext)) return file.text();
  // Try plain text as a last resort.
  return file.text();
}

async function extractPdf(file, onStatus) {
  onStatus("parsing PDF…");
  const pdfjs = await getPdfjs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;

  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    if (pdf.numPages > 1) onStatus(`reading page ${i}/${pdf.numPages}`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let pageText = "";
    let prevY = null;
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      const y = item.transform ? item.transform[5] : null;
      if (prevY !== null && y !== null && Math.abs(y - prevY) > 2 && pageText) {
        pageText += "\n";
      }
      pageText += item.str;
      if (item.hasEOL) pageText += "\n";
      prevY = y;
    }
    text += pageText.trim() + "\n\n";
  }

  const meaningful = text.replace(/\s/g, "").length;
  if (meaningful >= 40 || !els.ocrEnabled.checked) return text;

  onStatus("scanned PDF - running OCR…");
  return ocrPdf(pdf, onStatus);
}

async function ocrPdf(pdf, onStatus) {
  const lang = els.ocrLang.value;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    onStatus(`OCR page ${i}/${pdf.numPages}…`);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const { data } = await Tesseract.recognize(canvas, lang);
    out += (data.text || "").trim() + "\n\n";
  }
  return out;
}

async function extractDocx(file) {
  if (typeof mammoth === "undefined") throw new Error("DOCX library not loaded");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractEpub(file) {
  if (typeof JSZip === "undefined") throw new Error("ePub library not loaded");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("invalid ePub");
  const container = parser.parseFromString(
    await containerFile.async("string"),
    "application/xml"
  );
  const rootfile = container.getElementsByTagName("rootfile")[0];
  const opfPath = rootfile?.getAttribute("full-path");
  if (!opfPath) throw new Error("invalid ePub (no OPF)");
  const opfDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
    : "";

  const opf = parser.parseFromString(
    await zip.file(opfPath).async("string"),
    "application/xml"
  );

  const manifest = {};
  for (const item of opf.getElementsByTagName("item")) {
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  }
  const spine = Array.from(opf.getElementsByTagName("itemref")).map((r) =>
    r.getAttribute("idref")
  );
  const ids = spine.length ? spine : Object.keys(manifest);

  const chapters = [];
  for (const id of ids) {
    const href = manifest[id];
    if (!href) continue;
    const path = decodeURIComponent(opfDir + href.split("#")[0]);
    const entry = zip.file(path);
    if (!entry) continue;
    const html = await entry.async("string");
    const doc = parser.parseFromString(html, "text/html");
    const text = (doc.body?.textContent || "").replace(/[ \t]+\n/g, "\n").trim();
    if (text) chapters.push(text);
  }
  return chapters.join("\n\n");
}

/* ---------------------------------------------------------------- chunking */
function splitParagraphs(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  let paras = normalized
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 1 && normalized.includes("\n")) {
    paras = normalized
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return paras.length ? paras : [normalized];
}

function chunkSegments(segments, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const seg of segments) {
    const add = seg.length + (current.length ? 2 : 0);
    if (current.length && size + add > maxChars) {
      chunks.push({ segments: current, text: current.join("\n\n") });
      current = [];
      size = 0;
    }
    current.push(seg);
    size += add;
  }
  if (current.length) chunks.push({ segments: current, text: current.join("\n\n") });
  return chunks;
}

/* ------------------------------------------------------------- translation */
function parseGlossary() {
  return els.glossary.value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*(?:=|->|→|\t)\s*(.+)$/);
      return m ? { source: m[1].trim(), target: m[2].trim() } : null;
    })
    .filter((g) => g && g.source && g.target);
}

async function runTranslation() {
  if (state.running) return;

  const text = els.sourceText.value.trim();
  if (!text) return toast("Add some text or upload a file first", true);

  const provider = els.provider.value;
  const model = els.model.value.trim();
  if (!provider) return toast("No provider selected", true);
  if (!model) return toast("Choose a model", true);
  const apiKey = (state.keys[provider] || "").trim();
  if (!apiKey && !state.configured?.[provider]) {
    const label = state.cfg?.labels?.[provider] || provider;
    return toast(`Enter an API key for ${label}, or add it to .env`, true);
  }
  if (els.source.value === els.target.value) {
    return toast("Source and target languages are the same", true);
  }

  const maxChars = Math.max(500, parseInt(els.chunkSize.value, 10) || 4000);
  const chunks = chunkSegments(splitParagraphs(text), maxChars);

  state.running = true;
  state.pairs = [];
  state.chunkCount = chunks.length;
  state.abort = new AbortController();
  els.translateBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.translationOut.textContent = "";
  els.bilingualOut.innerHTML = "";
  setProgress(0, `0 / ${chunks.length}`);
  els.resultCount.textContent = "";

  const payloadBase = {
    provider,
    model,
    api_key: apiKey,
    source: els.source.value,
    target: els.target.value,
    glossary: parseGlossary(),
  };

  let stopped = false;
  state.currentChunk = null;
  state.livePartial = "";
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      state.currentChunk = chunk;
      state.livePartial = "";
      await streamTranslate(
        { ...payloadBase, text: chunk.text },
        (delta) => {
          state.livePartial += delta;
          renderLive(state.livePartial);
        },
        state.abort.signal
      );

      state.pairs.push(...pairsFromChunk(chunk.segments, state.livePartial));
      state.currentChunk = null;
      renderTranslation();
      renderBilingual();
      setProgress(((i + 1) / chunks.length) * 100, `${i + 1} / ${chunks.length}`);
    }
    toast("Translation complete");
  } catch (err) {
    if (err.name === "AbortError") {
      stopped = true;
      // Keep whatever was produced for the in-flight chunk.
      const chunk = state.currentChunk;
      if (chunk && state.livePartial.trim()) {
        state.pairs.push(...pairsFromChunk(chunk.segments, state.livePartial));
        renderTranslation();
        renderBilingual();
      }
      toast("Stopped");
    } else {
      toast(err.message || "Translation failed", true);
    }
  } finally {
    state.running = false;
    state.abort = null;
    els.translateBtn.disabled = false;
    els.stopBtn.disabled = true;
    if (!stopped) setProgress(100, `${chunks.length} / ${chunks.length}`);
    updateResultCount();
  }
}

async function streamTranslate(payload, onDelta, signal) {
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch (_) {}
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let obj;
        try {
          obj = JSON.parse(data);
        } catch (_) {
          continue;
        }
        if (obj.error) streamError = obj.error;
        else if (typeof obj.delta === "string") onDelta(obj.delta);
      }
    }
  }

  if (streamError) throw new Error(streamError);
}

function pairsFromChunk(srcSegments, translation) {
  const clean = (translation || "").trim();
  if (!clean) return [];
  const parts = clean
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === srcSegments.length) {
    return srcSegments.map((src, i) => ({ src, tgt: parts[i] }));
  }
  return [{ src: srcSegments.join("\n\n"), tgt: clean }];
}

/* ---------------------------------------------------------------- rendering */
function renderLive(partialCurrentChunk) {
  const done = state.pairs.map((p) => p.tgt).join("\n\n");
  els.translationOut.textContent = done
    ? done + "\n\n" + partialCurrentChunk
    : partialCurrentChunk;
  els.translationOut.scrollTop = els.translationOut.scrollHeight;
}

function renderTranslation() {
  els.translationOut.textContent = state.pairs
    .map((p) => p.tgt)
    .join("\n\n")
    .trim();
  els.translationOut.scrollTop = els.translationOut.scrollHeight;
  updateResultCount();
}

function renderBilingual() {
  els.bilingualOut.innerHTML = "";
  for (const pair of state.pairs) {
    if (!pair.tgt) continue;
    const wrap = document.createElement("div");
    wrap.className = "pair";
    const src = document.createElement("div");
    src.className = "col src";
    src.innerHTML = '<span class="tag">Source</span>';
    src.append(document.createTextNode(pair.src));
    const tgt = document.createElement("div");
    tgt.className = "col tgt my-font";
    tgt.innerHTML = '<span class="tag">Translation</span>';
    tgt.append(document.createTextNode(pair.tgt));
    wrap.append(src, tgt);
    els.bilingualOut.appendChild(wrap);
  }
}

function setProgress(pct, text) {
  els.progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (text !== undefined) els.progressText.textContent = text;
}

function updateSourceCount() {
  els.sourceCount.textContent = `${els.sourceText.value.length.toLocaleString()} characters`;
}

function updateResultCount() {
  const len = state.pairs.reduce((n, p) => n + p.tgt.length, 0);
  els.resultCount.textContent = len ? `${len.toLocaleString()} characters` : "";
}

function currentTranslationText() {
  return state.pairs
    .map((p) => p.tgt)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/* ------------------------------------------------------------------ export */
async function copyResult() {
  const text = currentTranslationText();
  if (!text) return toast("Nothing to copy", true);
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch (_) {
    toast("Copy failed - select the text manually", true);
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function exportTxt() {
  const text = currentTranslationText();
  if (!text) return toast("Nothing to export", true);
  download(new Blob([text], { type: "text/plain;charset=utf-8" }), `translation-${stamp()}.txt`);
}

async function exportDocx() {
  const text = currentTranslationText();
  if (!text) return toast("Nothing to export", true);
  if (typeof JSZip === "undefined") return toast("DOCX library not loaded", true);

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels").file(".rels", RELS);
  const word = zip.folder("word");
  word.file("document.xml", buildDocumentXml(text));
  word.file("styles.xml", STYLES_XML);
  word.folder("_rels").file("document.xml.rels", DOC_RELS);

  const blob = await zip.generateAsync({
    type: "blob",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  download(blob, `translation-${stamp()}.docx`);
}

function xmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDocumentXml(text) {
  const paras = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line.trim()
        ? `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`
        : "<w:p/>"
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paras}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
    "</w:body></w:document>"
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  "</Types>";

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Padauk" w:hAnsi="Padauk" w:cs="Padauk"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
  "</w:rPr></w:rPrDefault></w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/></w:style>' +
  "</w:styles>";

/* -------------------------------------------------------------- persistence */
function persist() {
  try {
    localStorage.setItem(
      "enmy.settings",
      JSON.stringify({
        provider: els.provider.value,
        model: els.model.value,
        autoModel: els.autoModel.checked,
        source: els.source.value,
        target: els.target.value,
        chunkSize: els.chunkSize.value,
        glossary: els.glossary.value,
      })
    );
  } catch (_) {}
}

function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("enmy.settings") || "{}");
    if (saved.chunkSize) els.chunkSize.value = saved.chunkSize;
    if (saved.source) els.source.value = saved.source;
    if (saved.target) els.target.value = saved.target;
    if (saved.glossary) els.glossary.value = saved.glossary;
    if (saved.model) els.model.value = saved.model;
    if (typeof saved.autoModel === "boolean") els.autoModel.checked = saved.autoModel;
    state.savedProvider = saved.provider;
  } catch (_) {}

  try {
    const keys = JSON.parse(localStorage.getItem("enmy.keys") || "{}");
    if (keys && typeof keys === "object" && Object.keys(keys).length) {
      state.keys = keys;
      els.rememberKey.checked = true;
    }
  } catch (_) {}
}

function saveRememberedKeys() {
  try {
    if (els.rememberKey.checked) {
      localStorage.setItem("enmy.keys", JSON.stringify(state.keys));
    } else {
      localStorage.removeItem("enmy.keys");
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------- toast */
let toastTimer = null;
function toast(message, isError) {
  els.toast.textContent = message;
  els.toast.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.className = "toast"), 3200);
}

init();
