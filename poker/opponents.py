"""Opponent formulas of the reference policy: how often a player folds to a bet and which hands he holds."""


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
