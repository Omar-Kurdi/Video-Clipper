"""A language model on this computer, through Ollama (https://ollama.com).

It translates the transcript, and stands in for Gemini when Gemini can't
answer (suggested moments, post text). It reads text only: transcription stays
with Whisper and the tashkeel reader, and proofreading (which listens to the
audio) stays with Gemini.

Which model depends on the computer (see MODELS and `python -m shorts.local_llm`):
the best one that fits the NVIDIA GPU's memory, else a small one on the CPU.
Tested Nov 2026 on three proofread lectures: Qwen3.8-27B's translations were
about as good as Gemini Flash's and far better than Qwen3-4B's, and its
suggested moments largely matched Gemini's. The smaller Qwen3.5 models are the
same family, scaled down for smaller GPUs; they weren't compared.

Memory: nothing is loaded until a job needs it, and it is unloaded as soon as
that job ends (Ollama itself, idle, holds no GPU memory). Settings (.env /
.env.local): LOCAL_MODEL (an Ollama model name, to choose one yourself) and
OLLAMA_URL. Without Ollama running, or without a fitting model pulled,
available() is None and the callers use what they used before.
"""
import json
import subprocess
import urllib.error
import urllib.request

from .proofread import _setting

# best first: (Ollama model name, file size GB, GPU memory it needs GB, what it is).
# "Needs" leaves about 3 GB for the text being read and whatever else uses the GPU.
MODELS = [
    ("hf.co/bartowski/Qwen3.8-27B-GGUF:Q6_K", 23.9, 27, "Qwen3.8-27B, 6-bit"),
    ("hf.co/bartowski/Qwen3.8-27B-GGUF:Q5_K_M", 20.9, 24, "Qwen3.8-27B, 5-bit"),
    ("hf.co/bartowski/Qwen3.8-27B-GGUF:Q4_K_M", 17.4, 20, "Qwen3.8-27B, 4-bit"),
    ("hf.co/bartowski/Qwen3.8-27B-GGUF:Q3_K_M", 13.4, 15, "Qwen3.8-27B, 3-bit (tested on a 16 GB RTX 5080)"),
    ("hf.co/bartowski/Qwen_Qwen3.5-9B-GGUF:Q5_K_M", 7.1, 10, "Qwen3.5-9B, 5-bit"),
    ("hf.co/bartowski/Qwen_Qwen3.5-9B-GGUF:Q4_K_M", 6.2, 8, "Qwen3.5-9B, 4-bit"),
    ("hf.co/bartowski/Qwen_Qwen3.5-4B-GGUF:Q5_K_M", 3.4, 5, "Qwen3.5-4B, 5-bit"),
]
CPU_MODEL = ("hf.co/bartowski/Qwen_Qwen3.5-4B-GGUF:Q4_K_M", 3.0, 0, "Qwen3.5-4B, 4-bit, on the CPU (slow)")
CPU_RAM_GB = 8  # system memory a CPU-only computer needs for it
KEEP_ALIVE = "30s"  # between the requests of one job; the job unloads it when done


def _url() -> str:
    return (_setting("OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")


def _post(path: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(_url() + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _get(path: str, timeout: float = 2) -> dict:
    with urllib.request.urlopen(_url() + path, timeout=timeout) as r:
        return json.loads(r.read())


def hardware() -> dict:
    """The NVIDIA GPU's name and memory (GB, None without one) and the system memory (GB)."""
    gpu, vram = None, None
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
        if out:
            name, mib = out[0].rsplit(",", 1)
            gpu, vram = name.strip(), round(int(mib) / 1024, 1)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    ram = None
    try:
        with open("/proc/meminfo") as f:
            ram = round(int(next(l for l in f if l.startswith("MemTotal")).split()[1]) / 1024 / 1024, 1)
    except (OSError, StopIteration, ValueError):
        pass
    return {"gpu": gpu, "vram_gb": vram, "ram_gb": ram}


def fits(hw: dict | None = None) -> list[tuple]:
    """The models this computer can run, best first."""
    hw = hw or hardware()
    if hw["vram_gb"]:
        ok = [m for m in MODELS if m[2] <= hw["vram_gb"]]
        if ok:
            return ok
    return [CPU_MODEL] if (hw["ram_gb"] or 0) >= CPU_RAM_GB else []


def recommended(hw: dict | None = None) -> tuple | None:
    ok = fits(hw)
    return ok[0] if ok else None


def _pulled() -> set[str] | None:
    try:
        return {m["name"] for m in _get("/api/tags").get("models", [])}
    except (OSError, ValueError):
        return None


_hw_cache: dict | None = None


def available() -> str | None:
    """The model to use: LOCAL_MODEL if set and pulled, else the best pulled
    model that fits this computer; None without Ollama or such a model."""
    global _hw_cache
    have = _pulled()
    if have is None:
        return None
    pulled = lambda n: n in have or f"{n}:latest" in have  # noqa: E731
    forced = _setting("LOCAL_MODEL")
    if forced:
        return forced if pulled(forced) else None
    if _hw_cache is None:
        _hw_cache = hardware()
    return next((m[0] for m in fits(_hw_cache) if pulled(m[0])), None)


def chat(messages: list[dict], max_new: int | None = None, schema: dict | None = None,
         temperature: float = 0.0, context: int = 8192, model: str | None = None) -> str:
    """One answer, thinking off (it isn't needed for these jobs and takes long).
    The model stays loaded only KEEP_ALIVE after it, for the job's next request."""
    body = {"model": model or available(), "messages": messages, "stream": False, "think": False,
            "keep_alive": KEEP_ALIVE,
            "options": {"temperature": temperature, "top_p": 0.8, "top_k": 20, "num_ctx": context,
                        **({"num_predict": max_new} if max_new else {})}}
    if not body["model"]:
        raise RuntimeError("no local model (start Ollama with a model pulled: python -m shorts.local_llm)")
    if schema:
        body["format"] = schema
    return _post("/api/chat", body, timeout=900)["message"]["content"].strip()


def unload() -> None:
    """Free the memory this app's model holds (Whisper and renders need the GPU),
    and wait until Ollama has let it go (it does so in the background). Only
    models that are actually loaded are asked to go: asking one that isn't
    would make Ollama load it first."""
    import time

    ours = {m[0] for m in MODELS + [CPU_MODEL]} | ({_setting("LOCAL_MODEL")} - {None})
    mine = lambda: [m["name"] for m in _get("/api/ps", 5).get("models", []) if m["name"] in ours]  # noqa: E731
    try:  # only this app's models: one you loaded in Ollama yourself stays
        for name in mine():
            _post("/api/generate", {"model": name, "keep_alive": 0}, timeout=30)
        for _ in range(40):
            if not mine():
                return
            time.sleep(0.25)
    except (OSError, ValueError, urllib.error.URLError):
        pass


def _json_schema(s):
    """Gemini's schema (types in capitals) as JSON Schema (lower case)."""
    if isinstance(s, dict):
        return {k: (v.lower() if k == "type" and isinstance(v, str) else _json_schema(v)) for k, v in s.items()}
    if isinstance(s, list):
        return [_json_schema(x) for x in s]
    return s


def ask_json(prompt: str, schema: dict, temperature: float = 0.4) -> tuple[object, str]:
    """Like proofread.ask_json, from the local model: (answer, model name). Unloaded after."""
    name = available()
    if not name:
        raise RuntimeError("no local model (start Ollama with a model pulled: python -m shorts.local_llm)")
    # room for the prompt and the answer: Arabic with harakat is about 1.75 characters a token
    # (measured: 29,740 characters were 16,974 tokens), so count 1.5 to be safe
    context = min(131072, max(8192, -(-(int(len(prompt) / 1.5) + 4096) // 8192) * 8192))
    try:
        text = chat([{"role": "user", "content": prompt}], schema=_json_schema(schema),
                    temperature=temperature, context=context, model=name)
        return json.loads(text), name
    finally:
        unload()


if __name__ == "__main__":  # python -m shorts.local_llm: what this computer should use, and what's there
    hw = hardware()
    print(f"GPU: {hw['gpu'] or 'no NVIDIA GPU'}" + (f", {hw['vram_gb']} GB" if hw["vram_gb"] else "")
          + f" · memory: {hw['ram_gb']} GB")
    best = recommended(hw)
    if not best:
        print("No local model fits this computer: translation uses Qwen3-4B in the app, and moments/post text need Gemini.")
    else:
        print(f"Best fit: {best[3]} ({best[1]} GB)")
        have = _pulled()
        if have is None:
            print("Ollama isn't running (or isn't installed: https://ollama.com). Then:")
        use = available() if have is not None else None
        if use:
            print(f"Using: {use}" + ("" if use == best[0] else f"  (pull the best fit for better results: ollama pull {best[0]})"))
        else:
            print(f"Get it with:\n  ollama pull {best[0]}")
