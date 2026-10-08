"""Quality bench for the teacher/network: legality, monotonicity, agreement, and textbook spots."""
import random

import pytest

from poker.advisor import _label
from poker.model import predict, random_state
from poker.policy import CALL, FOLD_OR_CHECK, RAISE, State, action_mask, teacher

N_STATES = 3000
MIN_AGREEMENT = 0.95
SLACK = 0.51  # advisor rounds chip amounts to integers


def states(seed, n=N_STATES):
    rng = random.Random(seed)
    return [random_state(rng) for _ in range(n)]


def decide(s):
    pred = predict(s)
    cls = max(range(3), key=pred["probs"].__getitem__)
    return cls, pred, _label(s, cls, pred["size_frac"])


# ---------- legality (must hold for 100% of states) ----------
def test_never_picks_masked_action_and_probs_sum_to_one():
    for s in states(101):
        cls, pred, _ = decide(s)
        assert action_mask(s)[cls], s
        assert sum(pred["probs"]) == pytest.approx(1.0, abs=1e-5)


def test_never_folds_when_check_is_free():
    for s in states(102):
        if s.to_call <= 0:
            assert decide(s)[2][0] != "fold", s


def test_amounts_are_legal():
    for s in states(103):
        action, amount = decide(s)[2]
        assert 0 <= amount <= s.stack + 1e-9, (s, action, amount)
        if action in ("bet", "raise"):
            assert amount >= min(s.bb, s.stack) - 1e-9, (s, action, amount)
            assert amount > min(s.to_call, s.stack) - 1e-9, (s, action, amount)
        if action == "call":
            assert amount == pytest.approx(min(s.to_call, s.stack))


def test_pot_limit_cap_respected():
    for s in states(104):
        if not s.pot_limit:
            continue
        action, amount = decide(s)[2]
        if action in ("bet", "raise"):
            call = min(s.to_call, s.stack)
            assert amount <= call + (s.pot + call) + SLACK, (s, amount)


# ---------- monotonicity of the teacher ----------
@pytest.mark.parametrize("seed", range(5))
def test_call_and_raise_ev_increase_with_equity(seed):
    for s in states(200 + seed, 60):
        prev = None
        for eq in [i / 20 for i in range(21)]:
            cur = teacher(State(**{**s.__dict__, "equity": eq}))["evs"][1:]
            if prev is not None:
                for a, b in zip(prev, cur):
                    if a != -float("inf"):
                        assert b >= a - 1e-9, (s, eq)
            prev = cur


def test_higher_bubble_factor_never_makes_calling_better():
    for s in states(300, 500):
        if s.to_call <= 0:
            continue
        lo = teacher(State(**{**s.__dict__, "bf": 1.0}))["evs"][CALL]
        hi = teacher(State(**{**s.__dict__, "bf": 2.0}))["evs"][CALL]
        assert hi <= lo + 1e-9


# ---------- network vs teacher ----------
def test_network_agrees_with_teacher_on_unseen_states():
    ok = total = 0
    for s in states(999, 5000):
        evs, mask = teacher(s)["evs"], action_mask(s)
        teacher_cls = max(range(3), key=lambda i: evs[i] if mask[i] else -1e18)
        ok += decide(s)[0] == teacher_cls
        total += 1
    assert ok / total >= MIN_AGREEMENT, f"accordo {ok / total:.3f}"


# ---------- textbook spots: (id, state kwargs, allowed classes) ----------
BASE = dict(equity=0.5, pot=10, to_call=5, stack=100, bb=1, n_opp=1, street=1,
            position=0.5, opp_range=0.5, opp_aggr=1.5)
F, C, R = FOLD_OR_CHECK, CALL, RAISE
SPOTS = [
    ("equity well above pot odds -> not fold", dict(equity=0.60), {C, R}),
    ("equity far below pot odds -> fold", dict(equity=0.10), {F}),
    ("nuts, facing bet -> raise", dict(equity=0.97), {R}),
    ("nuts, check available -> bet", dict(equity=0.97, to_call=0), {R}),
    ("air, check available -> check", dict(equity=0.05, to_call=0), {F}),
    ("slightly below pot odds (28% vs 33%) -> fold", dict(equity=0.28), {F}),
    ("slightly above pot odds (40% vs 33%) -> continue", dict(equity=0.40), {C, R}),
    ("getting 4:1 with 30% equity -> call", dict(equity=0.30, pot=20, to_call=5), {C, R}),
    ("pot-sized bet needs 33%, has 20% -> fold", dict(equity=0.20, pot=20, to_call=20), {F}),
    ("multiway 4 opps, 12% equity, pot odds 33% -> fold", dict(equity=0.12, n_opp=4), {F}),
    ("multiway 3 opps, 32% equity, cheap call -> continue",
     dict(equity=0.32, n_opp=3, pot=20, to_call=5), {C, R}),
    ("bubble factor 2.0 turns a marginal call into a fold", dict(equity=0.40, bf=2.0), {F}),
    ("cash game same spot is a continue", dict(equity=0.40, bf=1.0), {C, R}),
    ("short stack, priced in, strong -> continue", dict(equity=0.55, stack=3, to_call=2, pot=6), {C, R}),
    ("partial all-in call, equity below required -> fold",
     dict(equity=0.2, stack=20, to_call=50, pot=60), {F}),
    ("river nuts vs loose caller -> bet", dict(equity=0.99, street=3, to_call=0, opp_range=0.8), {R}),
    ("75% equity facing a third-pot bet -> continue", dict(equity=0.75, pot=30, to_call=10), {C, R}),
    ("pot-limit nuts -> raise",
     dict(equity=0.97, pot_limit=True, pot=20, to_call=10, stack=400), {R}),
]


@pytest.mark.parametrize("name,kw,allowed", SPOTS, ids=[s[0] for s in SPOTS])
def test_textbook_spot(name, kw, allowed):
    s = State(**{**BASE, **kw})
    cls = decide(s)[0]
    assert cls in allowed, f"{name}: scelta {cls}, ammesse {allowed}, probs {predict(s)['probs']}"


# ---------- simulator smoke: engine invariants hold (chip conservation is asserted inside) ----------
@pytest.mark.parametrize("bot", ["station", "random", "tag"])
def test_simulator_plays_clean_hands(bot):
    from bench import sim
    rng = random.Random(5)
    nets = [sim.play_hand(bot, rng, i % 2) for i in range(40)]
    assert all(-sim.START <= n <= sim.START for n in nets)
