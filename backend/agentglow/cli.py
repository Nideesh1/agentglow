"""`agentglow serve [--host 0.0.0.0] [--port 8100] [--falkor URL] [--secret S] [--ingest-key K] [--run-idle-min M]`"""
from __future__ import annotations

import argparse
import os
import sys

from . import __version__

LOOPBACK = ("127.0.0.1", "localhost", "::1")


def capture_prompts(host: str, env: dict | None = None) -> bool:
    """AGENTGLOW_CAPTURE_PROMPTS=1 keeps Claude Code prompts, but only on a loopback bind (shared servers never get
    them); on any other host it is ignored with a warning."""
    if (env if env is not None else os.environ).get("AGENTGLOW_CAPTURE_PROMPTS") != "1":
        return False
    if host in LOOPBACK:
        return True
    print(f"agentglow: AGENTGLOW_CAPTURE_PROMPTS ignored: listening on {host}, prompt capture is for 127.0.0.1 only",
          file=sys.stderr, flush=True)
    return False


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="agentglow", description="Live 3D views of agent systems from OpenTelemetry spans")
    ap.add_argument("--version", action="version", version=f"agentglow {__version__}")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="run the server + UI (one per environment)")
    s.add_argument("--host", default=os.environ.get("AGENTGLOW_HOST", "0.0.0.0"))
    s.add_argument("--port", type=int, default=int(os.environ.get("AGENTGLOW_PORT", "8100")))
    s.add_argument("--falkor", default=os.environ.get("AGENTGLOW_FALKOR_URL"), help="FalkorDB URL for /live/graph, e.g. redis://localhost:6379/demo")
    s.add_argument("--secret", default=os.environ.get("AGENTGLOW_SECRET"),
                   help="HMAC secret: viewers need `Authorization: Bearer <agentglow.make_token(...)>` (env AGENTGLOW_SECRET)")
    s.add_argument("--ingest-key", default=os.environ.get("AGENTGLOW_INGEST_KEY"),
                   help="span producers must send `x-api-key: K` to the ingest endpoints; comma-separated keys for "
                        "rotation (env AGENTGLOW_INGEST_KEY)")
    s.add_argument("--run-idle-min", type=float, default=None,
                   help="close an open run as abandoned after this many minutes without events, unless it is waiting "
                        "(env AGENTGLOW_RUN_IDLE_MIN, default 30, 0 = off)")
    args = ap.parse_args(argv)
    if args.cmd != "serve":
        ap.print_help()
        return

    # Windows consoles default to cp1252: never let a non-ASCII character in console output crash the server.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    import uvicorn

    from .server import create_app

    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print(f"agentglow {__version__} -> http://{shown}:{args.port}   (spans: POST /v1/live, OTLP: /v1/traces)", flush=True)
    capture = capture_prompts(args.host)
    if capture:
        print("agentglow: prompts: captured (local only, AGENTGLOW_CAPTURE_PROMPTS=1)", flush=True)
    if args.host not in LOOPBACK and not (args.secret and args.ingest_key):
        import logging

        logging.basicConfig()
        log = logging.getLogger("agentglow")
        if not args.secret:
            log.warning("agentglow: listening on %s without --secret / AGENTGLOW_SECRET: every viewer sees every run "
                        "and can pick any scope. Set a secret before exposing this beyond localhost.", args.host)
        if not args.ingest_key:
            log.warning("agentglow: listening on %s without --ingest-key / AGENTGLOW_INGEST_KEY: anyone who can reach "
                        "it can post spans. Set an ingest key before exposing this beyond localhost.", args.host)
    uvicorn.run(create_app(falkor_url=args.falkor, secret=args.secret, ingest_key=args.ingest_key,
                           capture_prompts=capture, run_idle_min=args.run_idle_min), host=args.host,
                port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
