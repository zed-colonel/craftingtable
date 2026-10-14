"""R-G17's Python check fixture: the adopted check imports the locked package from its venv."""

import unittest

import ctfix_pkg


class FixtureTest(unittest.TestCase):
    def test_value(self) -> None:
        print("CTFIX", ctfix_pkg.VALUE, ctfix_pkg.__file__)
        self.assertEqual(ctfix_pkg.VALUE, 42)


if __name__ == "__main__":
    unittest.main()
