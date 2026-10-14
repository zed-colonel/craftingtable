"""R-G19's Python check fixture: a packaged project whose console script prints its dependency."""

import ctfix_pkg


def main() -> None:
    print("CTFIX-APP", ctfix_pkg.VALUE)
