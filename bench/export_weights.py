"""Export the trained MLP to plain JSON for the TypeScript core (single source of truth = model/policy.pt).

Run: .venv/bin/python -m bench.export_weights
"""
import hashlib
import json
from pathlib import Path

import torch

from poker.model import MODEL_PATH
from poker.policy import N_FEATURES

OUT = Path(__file__).resolve().parent.parent / "core" / "weights.json"
LAYERS = ("body.0", "body.2", "head")


def build() -> dict:
    state = torch.load(MODEL_PATH, map_location="cpu")
    layers = [{"w": state[f"{name}.weight"].double().tolist(),
               "b": state[f"{name}.bias"].double().tolist()} for name in LAYERS]
    assert len(layers[0]["w"][0]) == N_FEATURES, "feature count mismatch: retrain the model"
    return {"sha256": hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest(),
            "n_features": N_FEATURES, "layers": layers}


if __name__ == "__main__":
    OUT.write_text(json.dumps(build()))
    print(f"scritto {OUT} ({OUT.stat().st_size // 1024} KB)")
