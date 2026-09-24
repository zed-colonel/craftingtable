-- One row, written when the daemon finishes a controlled drain and consumed by the next
-- start. Its absence at start means the previous daemon did not stop cleanly (R-B9).
CREATE TABLE daemon_clean_stop (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 stopped_at TEXT NOT NULL,
 interrupted_run_count INTEGER NOT NULL CHECK (interrupted_run_count >= 0)
) STRICT;
