"""Heads-up push/fold game, solved exactly with CFR+ — the ground truth for the Deep CFR experiment.

The game: effective stack `s` (big blinds, blinds included), the small blind either folds (-0.5) or shoves; the big
blind facing a shove either folds (-1) or calls and the hands run out. Each player's decision depends only on their
169-class hand, so the whole game is two vectors of probabilities. Payoffs use the exact card-removal counts and
the class-vs-class equities from bench/data/equity_matrix.json.

Run: .venv/bin/python -m bench.pushfold        (writes bench/data/pushfold_nash.json)
"""
import json
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent / "data"
SB_BLIND, BB_BLIND = 0.5, 1.0
DEPTHS = [x / 2 for x in range(4, 51)]  # 2.0 .. 25.0 big blinds
ITERATIONS = 20000


class PushFold:
    def __init__(self, path: Path = DATA / "equity_matrix.json"):
        d = json.loads(path.read_text())
        self.classes: list[str] = d["classes"]
        self.counts = np.array(d["counts"], dtype=float)
        eq = np.array(d["equity"])
        self.eq = eq
        w = np.array(d["pairs"], dtype=float)
        self.w = w / w.sum()                    # joint probability of (SB class a, BB class b)
        self.row = self.w.sum(axis=1)           # P(SB holds class a)
        self.edge = 2 * eq - 1                  # SB's chip result per stack when both are all-in
        self.w_edge = self.w * self.edge
        self.n = len(self.classes)

    # ----- counterfactual values (SB's payoff units, big blinds) -----
    def sb_values(self, s: float, call: np.ndarray) -> np.ndarray:
        """[fold, shove] value of every SB class when BB calls class b with probability call[b]."""
        shove = self.w @ (1 - call) * BB_BLIND + s * (self.w_edge @ call)
        fold = -SB_BLIND * self.row
        return np.stack([fold, shove], axis=1)

    def bb_values(self, s: float, shove: np.ndarray) -> np.ndarray:
        """[fold, call] value for every BB class (BB's own payoff) when SB shoves class a with probability shove[a]."""
        fold = -BB_BLIND * (self.w.T @ shove)
        call = -s * (self.w_edge.T @ shove)
        return np.stack([fold, call], axis=1)

    # ----- evaluation -----
    def value(self, s: float, shove: np.ndarray, call: np.ndarray) -> float:
        """Expected payoff of the small blind."""
        u = self.sb_values(s, call)
        return float(np.sum(shove * u[:, 1] + (1 - shove) * u[:, 0]))

    def exploitability(self, s: float, shove: np.ndarray, call: np.ndarray) -> float:
        """Sum of both players' best-response gains; 0 exactly at a Nash equilibrium (big blinds per hand)."""
        sb_best = np.sum(np.max(self.sb_values(s, call), axis=1))
        sb_folds = 0.5 * np.sum(self.w.T @ (1 - shove))  # BB collects the SB blind whenever the SB folds
        bb_best = np.sum(np.max(self.bb_values(s, shove), axis=1)) + sb_folds
        return float(sb_best + bb_best)

    # ----- CFR+ -----
    def solve(self, s: float, iterations: int = ITERATIONS) -> dict:
        regret_sb = np.zeros((self.n, 2))
        regret_bb = np.zeros((self.n, 2))
        sum_shove = np.zeros(self.n)
        sum_call = np.zeros(self.n)
        total = 0.0
        for t in range(1, iterations + 1):
            shove = _positive_policy(regret_sb)
            call = _positive_policy(regret_bb)
            u_sb = self.sb_values(s, call)
            u_bb = self.bb_values(s, shove)
            regret_sb = np.maximum(regret_sb + u_sb - np.sum(np.stack([1 - shove, shove], 1) * u_sb, 1, keepdims=True), 0)
            regret_bb = np.maximum(regret_bb + u_bb - np.sum(np.stack([1 - call, call], 1) * u_bb, 1, keepdims=True), 0)
            sum_shove += t * shove          # linear averaging: later iterations count more
            sum_call += t * call
            total += t
        shove, call = sum_shove / total, sum_call / total
        return {"shove": shove, "call": call, "value": self.value(s, shove, call),
                "exploitability": self.exploitability(s, shove, call)}

    def range_share(self, probability: np.ndarray) -> float:
        """Fraction of all starting hands (by combos) played with this strategy."""
        return float(np.sum(self.counts * probability) / np.sum(self.counts))


def _positive_policy(regret: np.ndarray) -> np.ndarray:
    """Probability of the second action (shove / call) under regret matching."""
    pos = np.maximum(regret, 0)
    total = pos.sum(axis=1)
    return np.where(total > 0, pos[:, 1] / np.where(total > 0, total, 1), 0.5)


def main() -> None:
    game = PushFold()
    out = {"iterations": ITERATIONS, "depths": DEPTHS, "classes": game.classes,
           "shove": [], "call": [], "value": [], "exploitability": []}
    for s in DEPTHS:
        r = game.solve(s)
        out["shove"].append([round(float(v), 4) for v in r["shove"]])
        out["call"].append([round(float(v), 4) for v in r["call"]])
        out["value"].append(round(r["value"], 5))
        out["exploitability"].append(round(r["exploitability"], 6))
        print(f"{s:5.1f} bb  SB shoves {game.range_share(r['shove']):6.1%}  BB calls {game.range_share(r['call']):6.1%}"
              f"  value {r['value']:+.4f}  exploitability {r['exploitability']:.5f}", flush=True)
    (DATA / "pushfold_nash.json").write_text(json.dumps(out))


if __name__ == "__main__":
    main()
