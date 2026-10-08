from treys import Card

RANKS = "23456789TJQKA"
SUITS = "shdc"
FULL_DECK = [Card.new(r + s) for r in RANKS for s in SUITS]


def parse(text: str) -> int:
    """'As', 'td', '10h' -> treys card int. Raises ValueError on bad input."""
    s = text.strip()
    if len(s) == 3 and s.startswith("10"):
        s = "T" + s[2]
    if len(s) != 2 or s[0].upper() not in RANKS or s[1].lower() not in SUITS:
        raise ValueError(f"carta non valida: {text!r}")
    return Card.new(s[0].upper() + s[1].lower())


def fmt(card: int) -> str:
    return Card.int_to_str(card)
