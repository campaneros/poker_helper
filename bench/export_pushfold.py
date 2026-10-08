"""Export the exact push/fold solution as a compact table for the app (core/pushfold.json).

Run: .venv/bin/python -m bench.export_pushfold
"""
import json
from pathlib import Path

from bench.pushfold import DATA

OUT = Path(__file__).resolve().parent.parent / "core" / "pushfold.json"
VERSION = 1
DECIMALS = 3


def build() -> dict:
    nash = json.loads((DATA / "pushfold_nash.json").read_text())
    return {
        "version": VERSION,
        "depths": nash["depths"],  # effective stacks in big blinds, ascending
        "classes": nash["classes"],  # 169 labels: "AA", "AKs", "AKo", ...
        "shove": [[round(p, DECIMALS) for p in row] for row in nash["shove"]],  # small blind: P(shove) per class
        "call": [[round(p, DECIMALS) for p in row] for row in nash["call"]],  # big blind facing a shove: P(call)
    }


if __name__ == "__main__":
    OUT.write_text(json.dumps(build(), separators=(",", ":")))
    print(f"scritto {OUT} ({OUT.stat().st_size // 1024} KB)")
