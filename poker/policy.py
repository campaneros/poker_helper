"""State, feature encoding and the EV-based teacher policy (also the network's fallback)."""
import math
from dataclasses import dataclass

SIZES = (0.33, 0.5, 0.75, 1.0, 1.5)     # bet size as fraction of (pot + call)
FOLD_OR_CHECK, CALL, RAISE = 0, 1, 2
N_FEATURES = 21
TEMPERATURE = 0.08                       # softmax temperature, in units of pot


@dataclass(frozen=True)
class State:
    equity: float
    pot: float            # chips in the middle, including opponents' current bets
    to_call: float
    stack: float          # hero chips behind
    bb: float
    n_opp: int
    street: int           # 0 pre, 1 flop, 2 turn, 3 river
    position: float       # 0 = first to act ... 1 = button
    opp_range: float      # mean top-fraction of opponents' ranges
    opp_aggr: float       # mean aggression factor
    bf: float = 1.0       # ICM bubble factor (1 = cash game)
    pot_limit: bool = False
    opp_ranges: tuple = ()  # per-opponent top-fraction ranges (multiway); () = use opp_range for all
    opp_aggrs: tuple = ()   # per-opponent aggression factors
    opp_folds: tuple = ()   # per-opponent fold-to-bet rates; () = derived from the ranges


def features(s: State) -> list[float]:
    stack = max(s.stack, 1e-9)
    pot = max(s.pot, 1e-9)
    street = [1.0 if s.street == i else 0.0 for i in range(4)]
    tightest = min(s.opp_ranges) if s.opp_ranges else s.opp_range
    wildest = max(s.opp_aggrs) if s.opp_aggrs else s.opp_aggr
    folds = s.opp_folds or default_folds(s)
    return [
        s.equity,
        s.to_call / (pot + s.to_call),
        min(stack / pot, 20) / 20,
        min(s.to_call / stack, 1.0),
        min(pot / s.bb, 200) / 200,
        min(stack / s.bb, 200) / 200,
        s.n_opp / 8,
        *street,
        s.position,
        s.opp_range,
        min(s.opp_aggr, 5) / 5,
        (s.bf - 1) / 3,
        1.0 if s.pot_limit else 0.0,
        1.0 if s.to_call <= 0 else 0.0,
        tightest,
        min(wildest, 5) / 5,
        sum(folds) / len(folds),
        min(folds),
    ]


def default_folds(s: State) -> tuple:
    """Fold-to-bet when only ranges are known (reproduces the original fold-equity model)."""
    ranges = s.opp_ranges or (s.opp_range,) * max(s.n_opp, 1)
    return tuple(0.42 * (1 - r) for r in ranges)


def bet_amount(s: State, frac: float) -> float:
    """Chips added on top of the call for a raise of `frac` x (pot + call)."""
    call = min(s.to_call, s.stack)
    b = frac * (s.pot + call)
    if s.pot_limit:
        b = min(b, s.pot + call)
    return max(min(b, s.stack - call), min(s.bb, s.stack - call))


def action_mask(s: State) -> tuple[bool, bool, bool]:
    can_call = s.to_call > 0
    can_raise = s.stack > min(s.to_call, s.stack)
    return True, can_call, can_raise


def teacher(s: State) -> dict:
    """EV (in chips, relative to folding) of each action; chooses the best raise size."""
    call = min(s.to_call, s.stack)
    eq = s.equity * (0.9 + 0.1 * s.position)       # position realization
    m = s.bf
    if call > 0:
        ev0 = 0.0
        ev_call = eq * (s.pot + call) - m * call
    else:
        ev0 = eq * s.pot
        ev_call = -math.inf
    ev_raise, best_frac = -math.inf, SIZES[1]
    folds = s.opp_folds or default_folds(s)
    if action_mask(s)[RAISE]:
        sizes = [f for f in SIZES if not (s.pot_limit and f > 1.0)]
        for f in sizes:
            b = bet_amount(s, f)
            eff = b / (s.pot + call) if s.pot + call > 0 else f
            size_factor = eff / (eff + 0.6) / 0.524  # 1.0 at a 2/3-pot bet
            fe = 1.0  # everybody must fold: product of each opponent's own fold chance
            for fold in folds:
                fe *= max(0.0, min(0.85, fold * size_factor))
            ev = fe * s.pot + (1 - fe) * (eq * (s.pot + call + 2 * b) - m * (call + b))
            if ev > ev_raise:
                ev_raise, best_frac = ev, f
    return {"evs": [ev0, ev_call, ev_raise], "size_frac": best_frac}


def teacher_probs(evs, mask, pot) -> list[float]:
    t = max(TEMPERATURE * pot, 1e-9)
    valid = [e / t if ok else -math.inf for e, ok in zip(evs, mask)]
    top = max(valid)
    exps = [math.exp(v - top) if v > -math.inf else 0.0 for v in valid]
    z = sum(exps)
    return [e / z for e in exps]
