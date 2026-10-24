"""Every model and dataset the code downloads must be credited in the README.

    python tests/test_credits.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATTERNS = [
    r'(?:MODEL|VOTER|BASE)\s*=\s*"([\w.-]+/[\w.-]+)"',     # Hugging Face model ids
    r"huggingface\.co/(?:api/)?datasets/([\w.-]+/[\w.-]+)",  # datasets
    r"/([\w.-]+\.onnx)\"",                             # downloaded ONNX files
    r'model: str = "([\w.-]+)"',                       # Whisper size
]


def referenced() -> set[str]:
    found = set()
    for f in (ROOT / "shorts").glob("*.py"):
        text = f.read_text(encoding="utf-8")
        for p in PATTERNS:
            found.update(re.findall(p, text))
    return found


def main() -> int:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    credits = readme[readme.find("## Credits"):]
    missing = sorted(x for x in referenced() if x not in credits)
    if missing:
        print("Not credited in README.md (## Credits):", *missing, sep="\n  ")
        return 1
    print(f"ok: {len(referenced())} models/datasets credited")
    return 0


if __name__ == "__main__":
    sys.exit(main())
