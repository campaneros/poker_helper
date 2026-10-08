"""Today's behaviour must not drift: regenerates the golden vectors and compares to the frozen file.

If you changed the model/policy/equity on purpose: .venv/bin/python -m bench.export_golden
"""
import json

import pytest

from bench.export_golden import OUT, build

TOL = 1e-12


@pytest.fixture(scope="module")
def frozen():
    return json.loads(OUT.read_text())


@pytest.fixture(scope="module")
def fresh():
    return json.loads(json.dumps(build()))  # same JSON round-trip as the file


def close(a, b, tol=TOL):
    if isinstance(a, list):
        return len(a) == len(b) and all(close(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k], tol) for k in a)
    if isinstance(a, float):
        return abs(a - b) <= tol
    return a == b


def test_weights_unchanged(frozen, fresh):
    assert fresh["weights_sha256"] == frozen["weights_sha256"], "pesi cambiati: rigenera i vettori"


@pytest.mark.parametrize("section", ["teacher", "mlp", "predict", "eval", "label", "icm", "range", "equity"])
def test_section_matches_frozen_vectors(frozen, fresh, section):
    assert close(fresh[section], frozen[section]), f"sezione '{section}' diversa dai vettori congelati"
