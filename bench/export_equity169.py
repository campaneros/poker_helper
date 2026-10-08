"""Export the 169x169 class-vs-class all-in equities in a compact form for the app (core/equity169.json).
The on-device ICM push/fold solver needs them; card-removal counts are rebuilt exactly from the hand classes.

Run: .venv/bin/python -m bench.export_equity169
"""
import json
from pathlib import Path

from bench.pushfold import DATA

OUT = Path(__file__).resolve().parent.parent / "core" / "equity169.json"
VERSION = 1
SCALE = 10_000  # equities are stored as integers in ten-thousandths: error below 5e-5


def build() -> dict:
    d = json.loads((DATA / "equity_matrix.json").read_text())
    return {
        "version": VERSION,
        "scale": SCALE,
        "classes": d["classes"],
        "equity_e4": [[round(v * SCALE) for v in row] for row in d["equity"]],
    }


if __name__ == "__main__":
    OUT.write_text(json.dumps(build(), separators=(",", ":")))
    print(f"scritto {OUT} ({OUT.stat().st_size // 1024} KB)")
