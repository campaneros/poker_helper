"""Freeze today's behaviour as golden vectors: the oracle any future engine must reproduce.

Run: .venv/bin/python -m bench.export_golden
"""
import hashlib
import json
import math
import random
from dataclasses import asdict
from itertools import combinations
from pathlib import Path

import torch

from poker.advisor import _label
from poker.cards import FULL_DECK, fmt, parse
from poker.equity import _EVAL, simulate
from poker.icm import bubble_factor, icm_equity
from poker.model import MODEL_PATH, load, predict, random_state
from poker.policy import RAISE, SIZES, State, action_mask, features, teacher, teacher_probs
from poker.ranges import hand_pct

OUT = Path(__file__).resolve().parent.parent / "tests" / "golden" / "vectors.json"
VERSION = 5  # v5: + targeted eval (shared board, one-card twins) and label (exact .5 rounding) cases
N_STATES = 400
N_ICM = 30
N_RANGE = 200
N_EVAL = 3000
EQUITY_SIMS = 20000
EQUITY_SPOTS = [  # (hero, board, opponent range fractions, seed)
    (["Ah", "As"], [], [1.0], 1),
    (["Kh", "Qh"], [], [1.0, 1.0], 2),
    (["7h", "2c"], [], [0.3], 3),
    (["Ah", "Kh"], ["2h", "7h", "Jc"], [0.186], 4),
    (["9s", "9d"], ["9h", "Kc", "2d"], [0.4, 0.4], 5),
    (["Jc", "Td"], ["9c", "8d", "2s", "Qh"], [0.25], 6),
    (["As", "5s"], ["Ks", "7s", "2s", "9d", "3h"], [0.5], 7),
    (["Qd", "Qc"], ["Qh", "Qs", "5d", "5c", "2h"], [0.15, 0.6], 8),
]


def _none_if_inf(x):
    return None if math.isinf(x) else x


def build() -> dict:
    net = load()
    if net is None:
        raise SystemExit("model/policy.pt mancante: esegui train.py")
    rng = random.Random(12345)
    teacher_cases, mlp_cases, states = [], [], []
    for _ in range(N_STATES):
        s = random_state(rng)
        states.append(s)
        t = teacher(s)
        f = features(s)
        teacher_cases.append({
            "state": asdict(s), "features": f,
            "evs": [_none_if_inf(e) for e in t["evs"]],
            "probs": teacher_probs(t["evs"], action_mask(s), s.pot),
            "size_frac": t["size_frac"],
        })
        with torch.no_grad():
            logits, size = net(torch.tensor([f]))
        mlp_cases.append({"features": f, "logits": logits[0].tolist(), "size": float(size[0])})

    predict_cases = []
    for s in states:
        pred = predict(s)
        cls = max(range(3), key=pred["probs"].__getitem__)
        action, amount = _label(s, cls, pred["size_frac"])
        predict_cases.append({"probs": pred["probs"], "size_frac": pred["size_frac"],
                              "action": action, "amount": amount})

    eval_cases = []
    for _ in range(N_EVAL):
        a = rng.sample(FULL_DECK, 7)
        b = rng.sample(FULL_DECK, 7)
        sa, sb = _EVAL.evaluate(a[2:], a[:2]), _EVAL.evaluate(b[2:], b[:2])
        eval_cases.append({"a": [fmt(c) for c in a], "b": [fmt(c) for c in b],
                           "cmp": (sa < sb) - (sa > sb), "class_a": _EVAL.get_rank_class(sa)})

    def eval_case(a, b):
        sa, sb = _EVAL.evaluate(a[2:], a[:2]), _EVAL.evaluate(b[2:], b[:2])
        return {"a": [fmt(c) for c in a], "b": [fmt(c) for c in b],
                "cmp": (sa < sb) - (sa > sb), "class_a": _EVAL.get_rank_class(sa)}

    for _ in range(N_EVAL):  # showdowns: same board, different holes (the real use)
        cards = rng.sample(FULL_DECK, 9)
        board = cards[2:7]
        eval_cases.append(eval_case(cards[:2] + board, cards[7:9] + board))
    for _ in range(N_EVAL):  # twins: identical except one card -> decided by kickers
        a = rng.sample(FULL_DECK, 7)
        b = list(a)
        b[rng.randrange(7)] = rng.choice([c for c in FULL_DECK if c not in a])
        eval_cases.append(eval_case(a, b))

    label_cases = []  # amounts that land exactly on .5 (Python rounds half to even, JS Math.round does not)
    for pot in (3, 5, 7, 9, 11, 15, 21, 33):
        for frac in SIZES:
            for to_call in (0, 1, 3):
                st = State(equity=0.5, pot=pot, to_call=to_call, stack=400, bb=1, n_opp=1, street=1,
                           position=0.5, opp_range=0.5, opp_aggr=1.5)
                action, amount = _label(st, RAISE, frac)
                label_cases.append({"state": asdict(st), "frac": frac, "action": action, "amount": amount})
    for stack in (10, 11, 12.5, 20):  # all-in threshold edge (total >= 0.9 * stack)
        st = State(equity=0.5, pot=10, to_call=2, stack=stack, bb=1, n_opp=1, street=1,
                   position=0.5, opp_range=0.5, opp_aggr=1.5)
        for frac in SIZES:
            action, amount = _label(st, RAISE, frac)
            label_cases.append({"state": asdict(st), "frac": frac, "action": action, "amount": amount})

    icm_cases = []
    for _ in range(N_ICM):
        n = rng.randint(3, 9)
        stacks = [rng.randint(200, 6000) for _ in range(n)]
        payouts = sorted((rng.randint(10, 100) for _ in range(rng.randint(1, min(n, 5)))), reverse=True)
        icm_cases.append({
            "stacks": stacks, "payouts": payouts,
            "equity": icm_equity(stacks, payouts),
            "bf": bubble_factor(stacks, payouts, hero=0, risk=stacks[0] // 2),
            "risk": stacks[0] // 2,
        })

    pairs = rng.sample(list(combinations(FULL_DECK, 2)), N_RANGE)
    range_cases = [{"cards": [a, b], "pct": hand_pct(a, b)} for a, b in pairs]

    equity_cases = []
    for hero, board, fracs, seed in EQUITY_SPOTS:
        r = simulate([parse(c) for c in hero], [parse(c) for c in board], fracs,
                     n_sims=EQUITY_SIMS, budget=1e9, rng=random.Random(seed))
        equity_cases.append({"hero": hero, "board": board, "fracs": fracs, "seed": seed,
                             "n_sims": EQUITY_SIMS, "equity": r["equity"], "win": r["win"],
                             "categories": r["categories"]})

    return {
        "version": VERSION,
        "weights_sha256": hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest(),
        "teacher": teacher_cases, "mlp": mlp_cases, "predict": predict_cases, "eval": eval_cases, "label": label_cases, "icm": icm_cases,
        "range": range_cases, "equity": equity_cases,
    }


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build()))
    print(f"scritto {OUT} ({OUT.stat().st_size // 1024} KB)")
