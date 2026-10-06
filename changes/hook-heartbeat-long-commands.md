Long tool calls no longer lose the lease: PreToolUse on Bash starts a detached ticker that heartbeats every lease/3 until the call ends, the session ends, or a heartbeat answers anything but ok.
