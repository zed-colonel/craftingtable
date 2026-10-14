"""R-G19's Python check fixture: the locked package and the project's own console script."""

import subprocess
import unittest

import ctfix_pkg


class FixtureTest(unittest.TestCase):
    def test_value(self) -> None:
        print("CTFIX", ctfix_pkg.VALUE, ctfix_pkg.__file__)
        self.assertEqual(ctfix_pkg.VALUE, 42)

    def test_console_script(self) -> None:
        out = subprocess.run(["ctfix-app"], capture_output=True, text=True, check=True).stdout
        print("FROM-SCRIPT", out.strip())
        self.assertEqual(out.strip(), "CTFIX-APP 42")


if __name__ == "__main__":
    unittest.main()
