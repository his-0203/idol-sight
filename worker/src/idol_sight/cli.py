"""Typer-based command-line entrypoint."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

import typer

from idol_sight.notify import notify_failure

app = typer.Typer(no_args_is_help=True, add_completion=False)


KNOWN_SOURCES = {
    "youtube", "naver", "dc", "theqoo", "instiz", "twitter",
    "hanteo", "channel-stats",
}
KNOWN_GROUPS = {
    "plave", "isedol", "stellive", "skinz",
    "myrakl", "miiwan", "owis", "bdawn",
}


@app.command(help="Run a collector for one (group, source) pair.")
def collect(
    source: str = typer.Option(..., "--source", help="One of: " + ", ".join(sorted(KNOWN_SOURCES))),
    group: str = typer.Option(..., "--group", help="Group key, e.g. plave"),
) -> None:
    if source not in KNOWN_SOURCES:
        typer.echo(f"unknown source: {source}", err=True)
        raise typer.Exit(code=2)
    if group not in KNOWN_GROUPS:
        typer.echo(f"unknown group: {group}", err=True)
        raise typer.Exit(code=2)
    typer.echo(f"[collect] {source}:{group} — not yet implemented (Plan 2)")


@app.command("notify-fail", help="Send a failure notification to Discord.")
def notify_fail(job: str = typer.Option(..., "--job")) -> None:
    webhook = os.environ.get("DISCORD_WEBHOOK")
    if not webhook:
        typer.echo("DISCORD_WEBHOOK unset; nothing to send", err=True)
        raise typer.Exit(code=0)
    notify_failure(
        webhook_url=webhook,
        job=job,
        error=f"job failed at {datetime.now(timezone.utc).isoformat()}",
    )
    typer.echo(f"notified: {job}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
