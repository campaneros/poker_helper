"""Deep CFR on the heads-up push/fold game, measured against the exact CFR+ solution (bench/pushfold.py).

Instead of tables, every infoset (a player's hand class + the stack depth) is described by a small feature vector
and a neural network approximates the cumulative regrets; a second network approximates the average strategy.
Each iteration: play the current regret-matching policy, compute the counterfactual regrets of every infoset,
store them with weight t (linear CFR), and keep training the networks on everything stored so far.

Honest scope: the game is tiny, so a full traversal per iteration is exact and needs no sampling; what this
checks is the function-approximation part of Deep CFR (do the networks recover an equilibrium, and do they
generalise to stack depths they never saw?). Tabular CFR+ already solves this game exactly.

Run: .venv/bin/python -m bench.deep_cfr
"""
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from bench.pushfold import DATA, PushFold

RANKS = "23456789TJQKA"
DEPTH_SCALE = 25.0
REGRET_SCALE = 100.0  # counterfactual values are weighted by chance (~1/169): scale them up for regression
TRAIN_DEPTHS = [3.0, 5.0, 8.0, 10.0, 12.0, 15.0, 20.0]
UNSEEN_DEPTHS = [4.0, 7.0, 9.0, 11.0, 17.0]
MODEL_PATH = Path(__file__).resolve().parent.parent / "model" / "deep_cfr_pushfold.pt"
PLAYERS = ("sb", "bb")


def class_features(game: PushFold) -> np.ndarray:
    """(169, 5): high rank, low rank, suited, pair, equity against a random hand."""
    vs_random = (game.w * game.eq).sum(axis=1) / game.w.sum(axis=1)
    rows = []
    for label, eq in zip(game.classes, vs_random):
        hi, lo = RANKS.index(label[0]) / 12, RANKS.index(label[1]) / 12
        rows.append([hi, lo, float(label.endswith("s")), float(label[0] == label[1]), eq])
    return np.array(rows, dtype=np.float32)


def mlp(out: int, hidden: int = 64) -> nn.Module:
    return nn.Sequential(nn.Linear(6, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, out))


def second_action_probability(advantage: torch.Tensor) -> torch.Tensor:
    """Regret matching over [fold, shove|call]: probability of the second action."""
    positive = advantage.clamp(min=0)
    total = positive.sum(dim=-1)
    return torch.where(total > 0, positive[:, 1] / total.clamp(min=1e-12), torch.full_like(total, 0.5))


@dataclass
class Memory:
    """Everything seen so far for one network: inputs, targets, and the iteration weight of each sample."""
    x: list = field(default_factory=list)
    y: list = field(default_factory=list)
    w: list = field(default_factory=list)

    def add(self, x: torch.Tensor, y: torch.Tensor, weight: float) -> None:
        self.x.append(x)
        self.y.append(y)
        self.w.append(torch.full((len(x),), float(weight)))

    def tensors(self) -> tuple:
        return torch.cat(self.x), torch.cat(self.y), torch.cat(self.w)


class DeepCFR:
    def __init__(self, game: PushFold, depths: list[float] = TRAIN_DEPTHS, seed: int = 0, lr: float = 2e-3):
        torch.manual_seed(seed)
        self.game, self.depths = game, depths
        self.feat = torch.tensor(class_features(game))
        self.adv = {p: mlp(2) for p in PLAYERS}
        self.strat = {p: mlp(1) for p in PLAYERS}
        nets = {**{f"adv_{p}": self.adv[p] for p in PLAYERS}, **{f"strat_{p}": self.strat[p] for p in PLAYERS}}
        self.opt = {key: torch.optim.Adam(net.parameters(), lr=lr) for key, net in nets.items()}
        self.adv_mem = {p: Memory() for p in PLAYERS}
        self.strat_mem = {p: Memory() for p in PLAYERS}
        self.t = 0

    def inputs(self, s: float) -> torch.Tensor:
        return torch.cat([self.feat, torch.full((self.game.n, 1), s / DEPTH_SCALE)], dim=1)

    def current_policy(self, s: float) -> tuple[np.ndarray, np.ndarray]:
        """Regret-matching policy implied by the advantage networks (what the next iteration plays)."""
        x = self.inputs(s)
        with torch.no_grad():
            return tuple(second_action_probability(self.adv[p](x)).numpy().astype(float) for p in PLAYERS)

    def iterate(self, steps: int = 40, batch: int = 2048) -> None:
        self.t += 1
        for s in self.depths:
            shove, call = self.current_policy(s)
            x = self.inputs(s)
            for player, p2, values in (("sb", shove, self.game.sb_values(s, call)), ("bb", call, self.game.bb_values(s, shove))):
                policy = np.stack([1 - p2, p2], axis=1)
                regret = values - np.sum(policy * values, axis=1, keepdims=True)  # instantaneous counterfactual regrets
                self.adv_mem[player].add(x, torch.tensor(regret * REGRET_SCALE, dtype=torch.float32), self.t)
                self.strat_mem[player].add(x, torch.tensor(p2, dtype=torch.float32).unsqueeze(1), self.t)
        for player in PLAYERS:
            self._fit(f"adv_{player}", self.adv[player], self.adv_mem[player], steps, batch, regression=True)
            self._fit(f"strat_{player}", self.strat[player], self.strat_mem[player], steps, batch, regression=False)

    def _fit(self, key: str, net: nn.Module, mem: Memory, steps: int, batch: int, regression: bool) -> None:
        x, y, w = mem.tensors()
        for _ in range(steps):
            idx = torch.multinomial(w, min(batch, len(w)), replacement=True)  # later iterations are sampled more often
            pred = net(x[idx])
            loss = F.mse_loss(pred, y[idx]) if regression else F.binary_cross_entropy_with_logits(pred, y[idx])
            self.opt[key].zero_grad()
            loss.backward()
            self.opt[key].step()

    def final_policy(self, s: float) -> tuple[np.ndarray, np.ndarray]:
        """The average strategy, as learned by the strategy networks."""
        x = self.inputs(s)
        with torch.no_grad():
            return tuple(torch.sigmoid(self.strat[p](x)).squeeze(1).numpy().astype(float) for p in PLAYERS)

    def evaluate(self, depths: list[float]) -> list[dict]:
        out = []
        for s in depths:
            shove, call = self.final_policy(s)
            exact = self.game.solve(s, iterations=4000)
            counts = self.game.counts
            out.append({
                "depth": s,
                "exploitability": self.game.exploitability(s, shove, call),
                "exact_exploitability": exact["exploitability"],
                "shove_range": self.game.range_share(shove), "exact_shove_range": self.game.range_share(exact["shove"]),
                "call_range": self.game.range_share(call), "exact_call_range": self.game.range_share(exact["call"]),
                # share of all hands where the networks and the exact solution make a different decision
                "shove_disagreement": float(np.sum(counts * ((shove > 0.5) != (exact["shove"] > 0.5))) / counts.sum()),
                "call_disagreement": float(np.sum(counts * ((call > 0.5) != (exact["call"] > 0.5))) / counts.sum()),
            })
        return out


def always_shove_always_call_exploitability(game: PushFold, s: float) -> float:
    """Scale for the numbers: how exploitable the naive policy "shove everything, call everything" is."""
    ones = np.ones(game.n)
    return game.exploitability(s, ones, ones)


def main() -> None:
    game = PushFold()
    model = DeepCFR(game)
    iterations = 400
    started = time.time()
    for i in range(1, iterations + 1):
        model.iterate()
        if i % 100 == 0:
            e = np.mean([r["exploitability"] for r in model.evaluate(TRAIN_DEPTHS)])
            print(f"iteration {i:4d}  mean exploitability on training depths {e:.4f} bb   ({time.time() - started:.0f}s)", flush=True)
    report = {"iterations": iterations, "train": model.evaluate(TRAIN_DEPTHS), "unseen": model.evaluate(UNSEEN_DEPTHS),
              "naive_exploitability": {str(s): always_shove_always_call_exploitability(game, s) for s in TRAIN_DEPTHS + UNSEEN_DEPTHS}}
    for name in ("train", "unseen"):
        print(f"\n{name} depths:   depth  exploit.  shove% (exact)   call% (exact)   shove-diff  call-diff")
        for r in report[name]:
            print(f"            {r['depth']:5.1f}  {r['exploitability']:.4f}   {r['shove_range']:5.1%} ({r['exact_shove_range']:5.1%})"
                  f"   {r['call_range']:5.1%} ({r['exact_call_range']:5.1%})   {r['shove_disagreement']:6.1%}   {r['call_disagreement']:6.1%}")
    (DATA / "deep_cfr_report.json").write_text(json.dumps(report, indent=1))
    MODEL_PATH.parent.mkdir(exist_ok=True)
    torch.save({"strategy_sb": model.strat["sb"].state_dict(), "strategy_bb": model.strat["bb"].state_dict(),
                "train_depths": TRAIN_DEPTHS, "iterations": iterations}, MODEL_PATH)


if __name__ == "__main__":
    main()
