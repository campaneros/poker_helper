"""Policy network: distills the EV teacher into an MLP (fast inference, smooth outputs)."""
import math
import random
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

from .opponents import fold_to_bet
from .policy import (N_FEATURES, SIZES, State, action_mask, features, teacher, teacher_probs)

MODEL_PATH = Path(__file__).resolve().parent.parent / "model" / "policy.pt"
_LO, _HI = SIZES[0], SIZES[-1]


class PolicyNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = nn.Sequential(
            nn.Linear(N_FEATURES, 128), nn.ReLU(), nn.Linear(128, 128), nn.ReLU())
        self.head = nn.Linear(128, 4)  # 3 action logits + raw size

    def forward(self, x):
        out = self.head(self.body(x))
        return out[:, :3], _LO + (_HI - _LO) * torch.sigmoid(out[:, 3])


def random_state(rng: random.Random) -> State:
    n_opp = rng.randint(1, 8)
    mean = 1 / (n_opp + 1)
    if rng.random() < 0.5:
        eq = rng.random()
    else:
        k = 8.0
        eq = rng.betavariate(mean * k + 0.5, (1 - mean) * k + 0.5)
    stack_bb = math.exp(rng.uniform(math.log(3), math.log(250)))
    pot_bb = min(rng.uniform(1.5, 1.5 + stack_bb * rng.random()), stack_bb * 2)
    to_call = 0.0 if rng.random() < 0.35 else pot_bb * rng.uniform(0.1, 1.5)
    vpips = [rng.uniform(0.1, 0.8) for _ in range(n_opp)]
    aggrs = tuple(rng.uniform(0.3, 4.0) for _ in range(n_opp))
    ranges = tuple(min(0.95, max(0.05, v * rng.uniform(0.5, 1.4))) for v in vpips)
    folds = tuple(max(0.03, min(0.8, fold_to_bet({"vpip": v, "af": a}) + rng.gauss(0, 0.05)))
                  for v, a in zip(vpips, aggrs))
    return State(
        equity=eq, pot=pot_bb, to_call=min(to_call, stack_bb), stack=stack_bb, bb=1.0,
        n_opp=n_opp, street=rng.randint(0, 3), position=rng.random(),
        opp_range=sum(ranges) / n_opp, opp_aggr=sum(aggrs) / n_opp,
        opp_ranges=ranges, opp_aggrs=aggrs, opp_folds=folds,
        bf=1.0 if rng.random() < 0.6 else rng.uniform(1.0, 2.5),
        pot_limit=rng.random() < 0.3)


def make_dataset(n: int, seed: int):
    rng = random.Random(seed)
    xs, ps, fs = [], [], []
    for _ in range(n):
        s = random_state(rng)
        t = teacher(s)
        xs.append(features(s))
        ps.append(teacher_probs(t["evs"], action_mask(s), s.pot))
        fs.append(t["size_frac"])
    return (torch.tensor(xs), torch.tensor(ps), torch.tensor(fs))


def train(n_train=300_000, n_val=20_000, epochs=25, batch=2048, seed=0, device=None):
    device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
    torch.manual_seed(seed)
    x, p, f = (t.to(device) for t in make_dataset(n_train, seed))
    xv, pv, fv = (t.to(device) for t in make_dataset(n_val, seed + 1))
    net = PolicyNet().to(device)
    opt = torch.optim.Adam(net.parameters(), lr=2e-3)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    for ep in range(epochs):
        perm = torch.randperm(n_train, device=device)
        for i in range(0, n_train, batch):
            idx = perm[i:i + batch]
            logits, size = net(x[idx])
            loss = -(p[idx] * F.log_softmax(logits, -1)).sum(-1).mean()
            loss = loss + 4 * (p[idx][:, 2] * (size - f[idx]) ** 2).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        sched.step()
    net.eval()
    with torch.no_grad():
        logits, _ = net(xv)
        agree = (logits.argmax(-1) == pv.argmax(-1)).float().mean().item()
    MODEL_PATH.parent.mkdir(exist_ok=True)
    torch.save(net.cpu().state_dict(), MODEL_PATH)
    return {"agreement_with_teacher": agree}


_net: PolicyNet | None = None


def load() -> PolicyNet | None:
    global _net
    if _net is None and MODEL_PATH.exists():
        net = PolicyNet()
        net.load_state_dict(torch.load(MODEL_PATH, map_location="cpu"))
        net.eval()
        _net = net
    return _net


def predict(s: State) -> dict:
    """Network probabilities (masked) + size; falls back to the teacher if untrained."""
    t = teacher(s)
    mask = action_mask(s)
    net = load()
    if net is None:
        return {"probs": teacher_probs(t["evs"], mask, s.pot), "size_frac": t["size_frac"],
                "source": "teacher", "teacher": t}
    with torch.no_grad():
        logits, size = net(torch.tensor([features(s)]))
    logits = logits[0].masked_fill(~torch.tensor(mask), -1e9)
    return {"probs": F.softmax(logits, -1).tolist(), "size_frac": float(size[0]),
            "source": "net", "teacher": t}
