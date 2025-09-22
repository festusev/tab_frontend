#!/usr/bin/env python3
"""
Compute suggestion metrics from a problems/ folder.

For each assistant (subdirectory of the problems directory), and for each
problem CSV log file within that assistant's folder, count the number of
proposed suggestions and accepted suggestions, then print the results.

Usage:
    python3 analysis/compute_suggestion_metrics.py [--problems PATH]

Defaults to scanning the "problems" folder in the repository root.
"""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Tuple


@dataclass(frozen=True)
class Metrics:
    proposed: int = 0
    accepted: int = 0
    suggested_chars: int = 0
    suggested_chars_deleted: int = 0


def compute_metrics_for_csv(csv_path: Path) -> Metrics:
    proposed = 0
    accepted = 0

    # Track buffer origins: 'S' (suggested), 'T' (typed), 'U' (unknown)
    buf: list[str] = []
    caret = 0  # current caret index
    suggested_chars = 0
    suggested_chars_deleted = 0

    def clamp(v: int, lo: int, hi: int) -> int:
        return max(lo, min(hi, v))

    with csv_path.open("r", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f, delimiter="\t")
        if not reader.fieldnames:
            return Metrics()
        headers = {h.strip(): h for h in reader.fieldnames if h is not None}
        action_col = headers.get("action_type")
        info_col = headers.get("action_info")
        caret_col = headers.get("caret_index")

        if action_col is None:
            # Fallback line parser (position-based)
            f.seek(0)
            next(f, None)
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 2:
                    continue
                action = parts[1]
                if action == "proposed_suggestion":
                    proposed += 1
                elif action == "accepted_suggestion":
                    accepted += 1
            return Metrics(
                proposed=proposed,
                accepted=accepted,
                suggested_chars=suggested_chars,
                suggested_chars_deleted=suggested_chars_deleted,
            )

        for row in reader:
            action = (row.get(action_col) or "").strip()
            info = row.get(info_col) if info_col else None
            try:
                caret_after = int((row.get(caret_col) or caret)) if caret_col else caret
            except ValueError:
                caret_after = caret
            caret_after = (
                clamp(caret_after, 0, len(buf))
                if action != "accepted_suggestion"
                else caret_after
            )

            before = caret

            if action == "proposed_suggestion":
                proposed += 1
                # No buffer change
            elif action == "accepted_suggestion":
                accepted += 1
                # Use the actual suggestion content length instead of caret delta
                suggestion_length = len(info) if info else 0
                if suggestion_length > 0:
                    # Grow buf with 'U's if before extends beyond current buffer
                    if before > len(buf):
                        buf.extend(["U"] * (before - len(buf)))
                    buf[before:before] = ["S"] * suggestion_length
                    suggested_chars += suggestion_length
                caret = clamp(caret_after, 0, len(buf))
            elif action == "character_typed":
                # Estimate inserted char count by caret delta
                d = max(0, caret_after - before)
                if d:
                    if before > len(buf):
                        buf.extend(["U"] * (before - len(buf)))
                    buf[before:before] = ["T"] * d
                caret = clamp(caret_after, 0, len(buf))
            elif action == "deletion":
                # Prefer explicit count from info; fallback to caret delta
                n = 0
                if info is not None:
                    try:
                        n = int(str(info).strip() or 0)
                    except ValueError:
                        n = 0
                if n <= 0:
                    n = max(0, before - caret_after)
                # Ensure caret is within buffer bounds before deletion
                caret = clamp(before, 0, len(buf))
                for _ in range(min(n, caret)):
                    ch = buf.pop(caret - 1)
                    if ch == "S":
                        suggested_chars_deleted += 1
                    caret -= 1
                # Sync to reported caret
                caret = clamp(caret_after, 0, len(buf))
            elif action == "current_code":
                # Reset buffer to unknown with length equal to caret_after
                buf = ["U"] * max(0, caret_after)
                caret = clamp(caret_after, 0, len(buf))
            else:
                # Movements or unhandled actions: sync caret only
                caret = clamp(caret_after, 0, len(buf))

    return Metrics(
        proposed=proposed,
        accepted=accepted,
        suggested_chars=suggested_chars,
        suggested_chars_deleted=suggested_chars_deleted,
    )


def scan_problems_dir(problems_dir: Path) -> Dict[str, Dict[str, Metrics]]:
    """Return nested dict: assistant -> csv_name -> Metrics."""
    results: Dict[str, Dict[str, Metrics]] = {}

    if not problems_dir.exists() or not problems_dir.is_dir():
        raise SystemExit(f"Problems directory not found: {problems_dir}")

    # Assistants are subdirectories of problems_dir; skip files at root.
    for assistant_dir in sorted(p for p in problems_dir.iterdir() if p.is_dir()):
        assistant_name = assistant_dir.name
        csv_counts: Dict[str, Metrics] = {}
        # Consider any .csv file in the assistant directory as a log.
        for csv_path in sorted(assistant_dir.glob("*.csv")):
            metrics = compute_metrics_for_csv(csv_path)
            csv_counts[csv_path.name] = metrics
        if csv_counts:
            results[assistant_name] = csv_counts
    return results


def print_results(results: Dict[str, Dict[str, Metrics]]) -> None:
    if not results:
        print("No CSV logs found.")
        return

    # Pretty, stable output
    for assistant, files in sorted(results.items()):
        print(f"Assistant: {assistant}")
        for csv_name, m in sorted(files.items()):
            pct = (
                (m.suggested_chars_deleted / m.suggested_chars * 100.0)
                if m.suggested_chars
                else 0.0
            )
            print(
                f"  - {csv_name}: proposed={m.proposed}, accepted={m.accepted}, "
                f"suggested_chars={m.suggested_chars}, deleted_from_suggestions={m.suggested_chars_deleted}, "
                f"deleted_pct={pct:.2f}%"
            )
        print()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--problems",
        dest="problems",
        type=str,
        default="problems",
        help="Path to the problems directory (default: problems)",
    )
    args = parser.parse_args()

    problems_dir = Path(args.problems).expanduser().resolve()
    results = scan_problems_dir(problems_dir)
    print_results(results)


if __name__ == "__main__":
    main()
