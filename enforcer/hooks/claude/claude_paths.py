"""Claude Code's own on-disk names, in ONE place (Python side).

Everything outside hooks/claude/ is harness-neutral and keeps state under
~/.config/enforcer/. Whatever has to name Claude Code's directories (its plugin
cache, its plugin manifest directory, the legacy project config and the legacy
state locations that first-run migration reads) imports them from here.
"""
import os

DOT = "." + "claude"
MANIFEST_DIR = DOT + "-plugin"                      # the Claude fallback manifest directory
LEGACY_PROJECT_CONFIG = os.path.join(DOT, "graph.json")


def config_dir():
    """Claude Code's own config directory (its plugin bookkeeping lives here)."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser(os.path.join("~", DOT))


def plugin_cache_glob(*parts):
    return os.path.join(config_dir(), "plugins", "cache", "*", *parts)


def plugin_data_env():
    """The directory Claude Code hands a plugin for its own data, when it does."""
    return os.environ.get("CLAUDE_PLUGIN_DATA")


def legacy_state_dir():
    """Where enforcer-graph kept session state before ~/.config/enforcer/sessions/."""
    return os.path.join(config_dir(), "enforcer-graph")
