R-G17's Python check fixture: a virtual uv project whose one dependency, `ctfix-pkg`, is a wheel
`python-fixture.ts` builds at test time, with the `uv.lock` that names it by SHA-256. No wheel
from PyPI is committed.
