import random

import pytest

from poker.cards import parse
from poker.equity import simulate
from poker.icm import bubble_factor, icm_equity
from poker.policy import State, teacher
from poker.ranges import hand_pct


def eq(hero, board, fracs, sims=20000):
    return simulate([parse(c) for c in hero], [parse(c) for c in board], fracs,
                    n_sims=sims, budget=5, rng=random.Random(1))


def test_aces_vs_random_is_about_85_percent():
    assert eq(["Ah", "As"], [], [1.0])["equity"] == pytest.approx(0.852, abs=0.015)


def test_aces_vs_kings_is_about_81_percent():
    # opponent range pinned to the very top (KK-AA is ~top 1.2%)
    r = eq(["Ah", "As"], [], [0.0091], sims=15000)
    assert r["equity"] > 0.78


def test_flush_draw_on_flop_is_about_35_percent_to_hit():
    r = eq(["Ah", "Kh"], ["2h", "7h", "Jc"], [1.0], sims=15000)
    flush = r["categories"]["Colore"]
    assert flush == pytest.approx(0.35, abs=0.03)


def test_range_percentile_order():
    assert hand_pct(parse("Ah"), parse("As")) < hand_pct(parse("7h"), parse("2c"))


def test_icm_sums_to_prize_pool_and_bubble_factor_above_one():
    stacks, pays = [5000, 3000, 1500, 500], [50, 30, 20]
    assert sum(icm_equity(stacks, pays)) == pytest.approx(100)
    assert bubble_factor(stacks, pays, hero=2, risk=1500) > 1.0
    assert bubble_factor([100, 100], [100]) == pytest.approx(1.0, abs=1e-6)


def base(**kw):
    d = dict(equity=0.5, pot=10, to_call=5, stack=100, bb=1, n_opp=1, street=1, position=0.5,
             opp_range=0.5, opp_aggr=1.5)
    return State(**{**d, **kw})


def test_teacher_folds_trash_calls_when_priced_in_raises_monster():
    assert teacher(base(equity=0.05))["evs"][0] > teacher(base(equity=0.05))["evs"][1]
    assert teacher(base(equity=0.5, to_call=2))["evs"][1] > 0
    ev = teacher(base(equity=0.95))["evs"]
    assert ev[2] > ev[1] > ev[0]


def test_icm_pressure_makes_marginal_call_worse():
    cash = teacher(base(equity=0.4, to_call=8))["evs"][1]
    bubble = teacher(base(equity=0.4, to_call=8, bf=2.0))["evs"][1]
    assert bubble < cash


def test_postflop_range_is_filtered_by_board_strength():
    # flush draw + overcards must be roughly a coin flip vs a betting range, not a favourite
    r = eq(["Ah", "Kh"], ["2h", "7h", "Jc"], [0.186], sims=15000)
    assert 0.40 < r["equity"] < 0.58
