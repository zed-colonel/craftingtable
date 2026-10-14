import markupsafe

def test_escape():
    assert str(markupsafe.escape("<a>")) == "&lt;a&gt;"
    # The compiled speedups, from the wheel, not the pure-Python fallback.
    assert markupsafe._speedups is not None
