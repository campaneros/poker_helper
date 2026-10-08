"""Monte Carlo equity vs opponents with range-weighted holdings + hero hand-category odds."""
import random
import time
from itertools import combinations

from treys import Evaluator

from .cards import FULL_DECK
from .ranges import hand_pct

_EVAL = Evaluator()
CLASS_NAMES = {
    1: "Scala colore", 2: "Poker", 3: "Full", 4: "Colore", 5: "Scala",
    6: "Tris", 7: "Doppia coppia", 8: "Coppia", 9: "Carta alta",
}
_REJECTION_TRIES = 40


PREFLOP_KEEP = 0.25  # postflop, hands in the top 25% of the range preflop always stay (draws, overpairs)


def _made_hand_pct(deck, board):
    """Percentile of every possible holding by its made-hand strength on the current board."""
    scored = sorted((_EVAL.evaluate(list(board), [a, b]), a, b) for a, b in combinations(deck, 2))
    n = len(scored)
    table, i = {}, 0
    while i < n:
        j = i
        while j < n and scored[j][0] == scored[i][0]:
            j += 1
        for _, a, b in scored[i:j]:
            table[(a, b) if a < b else (b, a)] = j / n
        i = j
    return table


def _in_range(a, b, frac, made):
    if frac >= 1.0:
        return True
    if made is None:
        return hand_pct(a, b) <= frac
    key = (a, b) if a < b else (b, a)
    return made[key] <= frac or hand_pct(a, b) <= frac * PREFLOP_KEEP


def _draw_hand(deck, used, frac, rng, made=None):
    for _ in range(_REJECTION_TRIES):
        a, b = rng.sample(deck, 2)
        if a in used or b in used:
            continue
        if _in_range(a, b, frac, made):
            return a, b
    while True:  # range too narrow for the remaining deck: fall back to any free hand
        a, b = rng.sample(deck, 2)
        if a not in used and b not in used:
            return a, b


def simulate(hero, board, opp_fracs, n_sims=30000, budget=0.8, rng=None):
    """hero: 2 cards, board: 0-5 cards, opp_fracs: top-fraction range per opponent."""
    rng = rng or random.Random()
    known = set(hero) | set(board)
    deck = [c for c in FULL_DECK if c not in known]
    need = 5 - len(board)
    made = _made_hand_pct(deck, board) if len(board) >= 3 and any(f < 1.0 for f in opp_fracs) else None
    share_total, wins, cats, done = 0.0, 0, [0] * 10, 0
    start = time.perf_counter()
    for i in range(n_sims):
        if i and i % 200 == 0 and time.perf_counter() - start > budget:
            break
        used = set()
        hands = []
        for frac in opp_fracs:
            h = _draw_hand(deck, used, frac, rng, made)
            used.update(h)
            hands.append(h)
        extra = []
        while len(extra) < need:
            c = rng.choice(deck)
            if c not in used:
                used.add(c)
                extra.append(c)
        full = list(board) + extra
        hero_score = _EVAL.evaluate(full, list(hero))
        cats[_EVAL.get_rank_class(hero_score)] += 1
        best_opp, ties = 10**9, 0
        for h in hands:
            s = _EVAL.evaluate(full, list(h))
            if s < best_opp:
                best_opp, ties = s, 1
            elif s == best_opp:
                ties += 1
        if hero_score < best_opp:
            share_total += 1
            wins += 1
        elif hero_score == best_opp:
            share_total += 1 / (ties + 1)
        done += 1
    return {
        "equity": share_total / done,
        "win": wins / done,
        "sims": done,
        "categories": {CLASS_NAMES[k]: cats[k] / done for k in range(1, 10)},
    }
