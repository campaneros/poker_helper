"""Push/fold solver, its stored solution, and the Deep CFR experiment."""
import json

import numpy as np
import pytest

from bench.deep_cfr import DeepCFR
from bench.pushfold import DATA, PushFold


@pytest.fixture(scope="module")
def game():
    return PushFold()


@pytest.fixture(scope="module")
def nash():
    return json.loads((DATA / "pushfold_nash.json").read_text())


def idx(game, label):
    return game.classes.index(label)


# ---------- the equity matrix underneath everything ----------
def test_equity_matrix_matches_known_matchups(game):
    eq = game.eq
    assert eq[idx(game, "AA"), idx(game, "KK")] == pytest.approx(0.82, abs=0.01)
    assert eq[idx(game, "AKs"), idx(game, "QQ")] == pytest.approx(0.46, abs=0.015)
    assert eq[idx(game, "72o"), idx(game, "AA")] == pytest.approx(0.12, abs=0.015)
    # independently re-checked with the Python evaluator (treys, 60k boards): JTs beats 22 about 54% of the time
    assert eq[idx(game, "JTs"), idx(game, "22")] == pytest.approx(0.541, abs=0.012)


def test_equity_is_antisymmetric_and_card_removal_is_exact(game):
    assert np.abs(game.eq + game.eq.T - 1).max() < 1e-12
    raw = json.loads((DATA / "equity_matrix.json").read_text())["pairs"]
    assert raw[idx(game, "AA")][idx(game, "AA")] == 6      # ordered (combo, combo) pairs that do not share a card
    assert raw[idx(game, "AA")][idx(game, "KK")] == 36
    assert raw[idx(game, "AKs")][idx(game, "AKo")] == 24
    assert sum(map(sum, raw)) == 1326 * 1225
    assert game.w.sum() == pytest.approx(1.0)


# ---------- the exact solution ----------
def test_stored_solution_is_an_equilibrium_at_every_depth(game, nash):
    for k in range(0, len(nash["depths"]), 4):
        s = nash["depths"][k]
        shove, call = np.array(nash["shove"][k]), np.array(nash["call"][k])
        exploitability = game.exploitability(s, shove, call)
        assert -1e-6 <= exploitability < 1e-3, f"{s} bb"   # never negative: that would mean a term is missing


def test_cfr_plus_converges_on_its_own(game):
    for s in (6.0, 12.0):
        result = game.solve(s, iterations=3000)
        assert -1e-6 <= result["exploitability"] < 2e-3
        assert np.all((result["shove"] >= 0) & (result["shove"] <= 1))


def test_exploitability_notices_a_wrong_strategy(game, nash):
    k = nash["depths"].index(10.0)
    s, shove, call = 10.0, np.array(nash["shove"][k]), np.array(nash["call"][k])
    flipped = shove.copy()
    flipped[idx(game, "AA")] = 0.0                      # folding aces cannot be part of an equilibrium
    assert game.exploitability(s, flipped, call) > game.exploitability(s, shove, call) + 1e-3
    ones = np.ones(game.n)
    assert game.exploitability(s, ones, ones) > 0.5     # "shove everything, call everything" is very exploitable


def test_solution_has_the_expected_shape(game, nash):
    shove_share = [game.range_share(np.array(r)) for r in nash["shove"]]
    call_share = [game.range_share(np.array(r)) for r in nash["call"]]
    for r_shove, r_call in zip(nash["shove"], nash["call"]):
        assert r_shove[idx(game, "AA")] > 0.99 and r_call[idx(game, "AA")] > 0.99
    deep = [k for k, s in enumerate(nash["depths"]) if s >= 10]
    assert all(nash["shove"][k][idx(game, "72o")] < 0.01 for k in deep)
    # the shorter the stack, the wider both players go (small tolerance for the 0.3% equity noise)
    assert all(a >= b - 0.01 for a, b in zip(shove_share, shove_share[1:]))
    assert all(a >= b - 0.01 for a, b in zip(call_share, call_share[1:]))
    assert nash["call"][0].count(1.0) >= 160            # at 2 bb the big blind calls (almost) anything


def test_agrees_with_published_ranges_at_nine_big_blinds(game):
    # PokerStrategy lists the Nash big-blind calling range at 9 bb as ~42.7% of hands; ours between 8 and 10 bb
    s8, s10 = game.solve(8.0, 6000), game.solve(10.0, 6000)
    at_nine = (game.range_share(s8["call"]) + game.range_share(s10["call"])) / 2
    assert at_nine == pytest.approx(0.427, abs=0.03)


def test_payoffs_by_hand():
    """If the big blind never calls, a shove wins exactly the big blind: 1.0 vs -0.5 for folding."""
    g = PushFold()
    values = g.sb_values(10.0, np.zeros(g.n))
    assert np.allclose(values[:, 1], g.row * 1.0)
    assert np.allclose(values[:, 0], g.row * -0.5)
    # if the big blind always calls, a shove is an all-in for the whole stack: s * (2*equity - 1)
    always = g.sb_values(10.0, np.ones(g.n))
    aa = idx(g, "AA")
    assert always[aa, 1] == pytest.approx(10.0 * float(np.sum(g.w[aa] * (2 * g.eq[aa] - 1))))


# ---------- Deep CFR ----------
def test_deep_cfr_learns_much_better_than_chance(game):
    depths = [5.0, 10.0, 15.0]
    model = DeepCFR(game, depths=depths, seed=1)
    before = np.mean([game.exploitability(s, *model.final_policy(s)) for s in depths])
    for _ in range(40):
        model.iterate()
    after = np.mean([game.exploitability(s, *model.final_policy(s)) for s in depths])
    naive = np.mean([game.exploitability(s, np.ones(game.n), np.ones(game.n)) for s in depths])
    assert after < before * 0.5
    assert after < naive * 0.1
    shove, call = model.final_policy(10.0)               # and it has found the aces, and the trash
    assert shove[idx(game, "AA")] > 0.9 and shove[idx(game, "72o")] < 0.3
    assert call[idx(game, "AA")] > 0.9 and call[idx(game, "72o")] < 0.3
