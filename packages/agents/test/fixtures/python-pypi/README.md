R-G17's real-PyPI fixture, for the opt-in tests (`CRAFTINGTABLE_REAL_PYPI=1`): a virtual uv project
locking `markupsafe` (a compiled wheel) and `pytest`, as locked with uv 0.12.22 on 2026-10-13. Its
tests import markupsafe's compiled speedups.
