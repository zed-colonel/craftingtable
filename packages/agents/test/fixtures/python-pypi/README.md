R-G19's real-PyPI fixture, for the opt-in tests (`CRAFTINGTABLE_REAL_PYPI=1`): a packaged uv project
built by `hatchling` from PyPI, with a console script, `ct-pypi-app`, locking `markupsafe` (a
compiled wheel), `docopt` (a source distribution only) and `pytest`, as locked with uv 0.12.22 on
2026-10-14. Its tests import markupsafe's compiled speedups, the built docopt, and run the console
script.
