"""R-G19's real-PyPI fixture: a packaged project whose console script uses its dependencies."""

import docopt
import markupsafe


def main() -> None:
    print("CT-PYPI-APP", markupsafe.escape("<a>"), docopt.__version__)
