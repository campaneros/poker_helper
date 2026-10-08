"""How good is the advisor's policy (the MLP that imitates the EV teacher) against the exact push/fold Nash?

The spot: heads-up, small blind first to act preflop with a short stack. For each of the 169 hand classes the
advisor sees exactly what it would see in the app (equity against an average opponent, pot odds, stack) and
decides; we compare that shove/fold decision with the Nash solution.

The advisor has no shove option unless the stack is tiny (its bets stop at 1.5x pot), so a literal "does it
go all-in" test would only measure that. The fair question is whether it CONTINUES (raises or limps) with the
hands Nash plays and FOLDS the hands Nash folds. Per stack depth:
  * agreement  - share of all hands where the advisor continues/folds like Nash plays/folds
  * too tight  - share of all hands the advisor folds although Nash plays them
  * too loose  - share of all hands the advisor continues with although Nash folds them

Read it with care: the Nash game only allows shove or fold, while the advisor can also limp, and limping is
real play. "Too loose" therefore means "plays hands the push/fold game would fold", not "loses money by it".
What it does show for sure: with a short stack the advisor has no way to recommend an all-in (column all-in).

Run: .venv/bin/python -m bench.vs_teacher
"""
import random

import numpy as np

from bench.pushfold import PushFold
from poker.advisor import _label
from poker.cards import parse
from poker.equity import simulate
from poker.model import predict
from poker.opponents import fold_to_bet, range_fraction
from poker.policy import FOLD_OR_CHECK, State

DEPTHS = [4.0, 6.0, 8.0, 10.0, 12.0, 15.0, 20.0]
PRIOR = {"vpip": 0.28, "pfr": 0.15, "af": 1.5}
SIMS = 3000


def representative_hand(label: str) -> list[str]:
    """One concrete holding for a class label such as 'AKs', 'T9o' or '77'."""
    hi, lo = label[0], label[1]
    if hi == lo:
        return [hi + "h", lo + "d"]
    return [hi + "h", lo + ("h" if label.endswith("s") else "d")]


def advisor_continues(game: PushFold, equities: np.ndarray, s: float) -> tuple[np.ndarray, np.ndarray]:
    """(continues, shoves): 1.0 where the advisor does not fold / goes all-in, small blind to act with `s` bb."""
    frac = range_fraction(PRIOR, 0, "none")
    cont, shove = np.zeros(game.n), np.zeros(game.n)
    for i, eq in enumerate(equities):
        state = State(
            equity=float(eq), pot=1.5, to_call=0.5, stack=s - 0.5, bb=1.0, n_opp=1, street=0, position=0.95,
            opp_range=frac, opp_aggr=PRIOR["af"], opp_ranges=(frac,), opp_aggrs=(PRIOR["af"],),
            opp_folds=(fold_to_bet(PRIOR),))
        pred = predict(state)
        cls = max(range(3), key=pred["probs"].__getitem__)
        action, _ = _label(state, cls, pred["size_frac"])
        cont[i] = 0.0 if cls == FOLD_OR_CHECK else 1.0
        shove[i] = 1.0 if action == "all-in" else 0.0
    return cont, shove


def main() -> None:
    game = PushFold()
    rng = random.Random(7)
    frac = range_fraction(PRIOR, 0, "none")
    equities = np.array([
        simulate([parse(c) for c in representative_hand(label)], [], [frac], n_sims=SIMS, budget=60, rng=rng)["equity"]
        for label in game.classes])
    print(f"advisor policy vs exact Nash, small blind first to act (equity vs the average player's range, {SIMS} sims)\n")
    print(" stack  Nash plays  advisor continues  all-in  agreement  too tight  too loose")
    for s in DEPTHS:
        nash = game.solve(s, iterations=8000)
        mine, allin = advisor_continues(game, equities, s)
        decided_nash = (nash["shove"] > 0.5).astype(float)
        total = game.counts.sum()
        agree = float(np.sum(game.counts * (mine == decided_nash)) / total)
        too_tight = float(np.sum(game.counts * ((mine == 0) & (decided_nash == 1))) / total)
        too_loose = float(np.sum(game.counts * ((mine == 1) & (decided_nash == 0))) / total)
        print(f"{s:5.1f}bb  {game.range_share(nash['shove']):9.1%}  {game.range_share(mine):15.1%}  {game.range_share(allin):6.1%}"
              f"  {agree:8.1%}  {too_tight:8.1%}  {too_loose:8.1%}")


if __name__ == "__main__":
    main()
