-- R-G9 (SEC-04): a sign-in refused for too many failures, and a session's step-up (the operator's
-- password again before an unrestricted run or a final promotion), succeeded or failed.
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('auth.login.rate-limited', 37),
  ('auth.step-up', 37),
  ('auth.step-up.failed', 37);
