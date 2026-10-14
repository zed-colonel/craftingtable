R-G19's Python check fixture: a packaged uv project (uv's own build backend, which uv builds with no
download) with a console script, `ctfix-app`, and one dependency, `ctfix-pkg`, a wheel in `vendor/`
that `python-fixture.ts` builds at test time before locking the project with the operator's uv,
offline. No file from PyPI is committed.
