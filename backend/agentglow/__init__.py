"""AgentGlow: live 3D views of agent systems, driven only by OpenTelemetry spans."""
try:  # single source of truth: the installed package metadata (the release workflow sets it from the git tag)
    from importlib.metadata import version as _version

    __version__ = _version("agentglow")
except Exception:  # running from a source tree without metadata
    __version__ = "0.0.0+local"

from .auth import make_token, verify_token  # noqa: E402
from .otel import LiveSpanProcessor  # noqa: E402
from .scope import ScopeSpanProcessor, scope, set_scope  # noqa: E402
from .watch import mark_error, mark_outcome, pulse, register_mcp, watch  # noqa: E402
from .manual import agent, current_agent, decided, decision, graph, llm, mcp, order, run, skill, tool, traced_agent, traced_tool  # noqa: E402
from .primitives import (backlog, cache, capacity, capture, complete, event, fallback, gate, inference, job, lifecycle,  # noqa: E402
                         link, metric, pool, progress, rejected, resource_group, sample_backlog, session, session_ws, stage, traced, wait, approval)

__all__ = ["watch", "pulse", "register_mcp", "mark_error", "mark_outcome", "LiveSpanProcessor", "ScopeSpanProcessor", "scope", "set_scope", "make_token",
           "verify_token", "__version__",
           "run", "agent", "llm", "tool", "mcp", "graph", "skill", "decision", "decided", "order", "traced_agent", "traced_tool", "current_agent",
           "session", "session_ws", "capture", "stage", "progress", "capacity", "rejected", "pool", "inference", "job", "link",
           "complete", "fallback", "gate", "backlog", "sample_backlog", "lifecycle", "metric", "event", "cache", "resource_group", "traced", "wait", "approval"]
