"""Starting-hand percentile table (Chen score) used to model opponent ranges."""
from itertools import combinations

from treys import Card

from .cards import FULL_DECK

_HIGH_POINTS = {12: 10, 11: 8, 10: 7, 9: 6}  # A K Q J
_GAP_PENALTY = {0: 0, 1: 1, 2: 2, 3: 4}


def _chen(hi: int, lo: int, suited: bool) -> float:
    pts = _HIGH_POINTS.get(hi, (hi + 2) / 2)
    if hi == lo:
        return max(5.0, 2 * pts)
    score = pts + (2 if suited else 0)
    gap = hi - lo - 1
    score -= _GAP_PENALTY.get(gap, 5)
    if gap <= 1 and hi < 10:
        score += 1
    return score


def _build() -> dict[tuple[int, int], float]:
    classes = []
    for hi in range(13):
        for lo in range(hi + 1):
            for suited in ((False,) if hi == lo else (False, True)):
                combos = 6 if hi == lo else (4 if suited else 12)
                classes.append((_chen(hi, lo, suited), hi, lo, suited, combos))
    classes.sort(key=lambda c: (-c[0], -c[1], -c[2]))
    pct_by_class, cum = {}, 0
    for _, hi, lo, suited, combos in classes:
        cum += combos
        pct_by_class[(hi, lo, suited)] = cum / 1326
    table = {}
    for a, b in combinations(FULL_DECK, 2):
        ra, rb = Card.get_rank_int(a), Card.get_rank_int(b)
        suited = Card.get_suit_int(a) == Card.get_suit_int(b)
        key = (max(ra, rb), min(ra, rb), suited and ra != rb)
        table[(a, b) if a < b else (b, a)] = pct_by_class[key]
    return table


_PCT = _build()


def hand_pct(a: int, b: int) -> float:
    """Fraction of all hands that are at least as strong as (a, b); 0.0045 = AA."""
    return _PCT[(a, b) if a < b else (b, a)]
