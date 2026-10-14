import subprocess

import docopt
import markupsafe


def test_escape():
    assert str(markupsafe.escape("<a>")) == "&lt;a&gt;"
    # The compiled speedups, from the wheel, not the pure-Python fallback.
    assert markupsafe._speedups is not None


def test_source_only_dependency():
    # docopt 0.6.2 has only a source distribution on PyPI: the install built it.
    assert docopt.__version__ == "0.6.2"


def test_console_script():
    out = subprocess.run(["ct-pypi-app"], capture_output=True, text=True, check=True).stdout
    assert out.strip() == "CT-PYPI-APP &lt;a&gt; 0.6.2"
