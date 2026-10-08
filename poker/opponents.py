"""Opponent stat tracking (VPIP / PFR / aggression) with Bayesian smoothing."""
import json
import threading
import uuid
from dataclasses import dataclass, asdict, field
from pathlib import Path

PRIOR_HANDS = 20
PRIOR_VPIP, PRIOR_PFR, PRIOR_AF_CALLS, PRIOR_AF = 0.28, 0.15, 10, 1.5


@dataclass
class Player:
    name: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    hands: int = 0
    vpip: int = 0
    pfr: int = 0
    bets: int = 0   # bets + raises
    calls: int = 0

    def stats(self) -> dict:
        n = self.hands + PRIOR_HANDS
        vpip = (self.vpip + PRIOR_VPIP * PRIOR_HANDS) / n
        pfr = min((self.pfr + PRIOR_PFR * PRIOR_HANDS) / n, vpip)
        af = (self.bets + PRIOR_AF * PRIOR_AF_CALLS) / (self.calls + PRIOR_AF_CALLS)
        style = ("loose" if vpip > 0.35 else "tight" if vpip < 0.2 else "medio") + \
                ("-aggressivo" if af > 2 else "-passivo" if af < 1 else "")
        return {"vpip": vpip, "pfr": pfr, "af": af, "style": style, "hands": self.hands}


def fold_to_bet(st: dict) -> float:
    """How often this player folds to a ~2/3-pot bet, estimated from VPIP and aggression."""
    return max(0.03, min(0.8, 0.52 - 0.75 * st["vpip"] - 0.02 * st["af"]))  # average player ~0.28


def range_fraction(st: dict, street: int, action: str, bet_frac: float = 0.6) -> float:
    """Top-fraction of starting hands this opponent plausibly holds given their action."""
    if action == "none":
        f = st["vpip"] if street == 0 else min(1.0, st["vpip"] * 1.4)
    elif action == "call":
        f = st["vpip"] * 0.85
    else:  # bet / raise
        base = st["pfr"] if street == 0 else st["pfr"] + (st["vpip"] - st["pfr"]) * 0.4
        f = base * (1.2 - 0.35 * min(bet_frac, 1.5)) * (0.8 + 0.1 * min(st["af"], 4))
    return max(0.04, min(1.0, f))


class Store:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.players: dict[str, Player] = {}
        if path.exists():
            self.players = {p["id"]: Player(**p) for p in json.loads(path.read_text())}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps([asdict(p) for p in self.players.values()], indent=1))

    def add(self, name: str) -> Player:
        with self._lock:
            p = Player(name=name)
            self.players[p.id] = p
            self._save()
            return p

    def remove(self, pid: str) -> bool:
        with self._lock:
            ok = self.players.pop(pid, None) is not None
            if ok:
                self._save()
            return ok

    def record_hand(self, pid: str, vpip: bool, pfr: bool, bets: int, calls: int) -> Player | None:
        with self._lock:
            p = self.players.get(pid)
            if p is None:
                return None
            p.hands += 1
            p.vpip += int(vpip or pfr)
            p.pfr += int(pfr)
            p.bets += max(bets, 0)
            p.calls += max(calls, 0)
            self._save()
            return p

    def get_stats(self, pid: str | None) -> dict:
        p = self.players.get(pid) if pid else None
        return (p or Player(name="?")).stats()
