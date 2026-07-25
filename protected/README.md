# Protected CT-04 acceptance specification

The YAML in this directory is operator-owned acceptance policy.

It is intentionally visible to implementers. Independence comes from write authority, not secrecy.

During CT-04:

- record its SHA-256 before implementation;
- exclude it from implementation-agent write scope;
- verify the hash before accepting every slice;
- require a separate contract amendment to change any required outcome.

An implementation may add tests that exercise these cases. It may not edit the expected outcomes to fit the code.
