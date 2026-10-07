The report hook runs a node's acceptance lines within a 15 s budget (8 s per line, cheap read-only lines first) so it never overruns the PreToolUse timeout and drops the evidence it was attaching.
