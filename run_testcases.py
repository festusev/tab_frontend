#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from typing import List, Dict, Any, Optional

BUILTIN_CASES: Dict[str, List[Dict[str, str]]] = {
    "keyboard": [
        {"in": "5\na\nb\nc\nd\ne\n", "out": "abcde"},
        {"in": "5\n^\na\nb\n^\nc\n", "out": "ABc"},
        {"in": "6\n~\na\nb\nc\n~\nd\ne\n", "out": "abbccde"},
        {"in": "10\n#\n1\n2\n.\n3\n.\n4\n#\nA\n5\n", "out": "12.34"},
        {"in": "7\n^\na\n~\nb\nc\n~\nd\n^\ne\n", "out": "ABBCCDe"},
        {"in": "6\na\n \nb\n^\nc\n \nd\n", "out": "a bC d"},
    ],
    "lava": [
        {
            "in": "3\n...\n...\n...\n2 2 R\n5\nMOVE\nFACE U\nMOVE\nFACE L\nMOVE\n",
            "out": "2 3 R\n2 3 U\n1 3 U\n1 3 L\n1 2 L\n",
        },
        {
            "in": "3\n..L\n...\n...\n2 2 R\n3\nMOVE\nFACE U\nMOVE\n",
            "out": "2 3 R\n2 3 U\nGame Over\n",
        },
        {
            "in": "5\n.....\n..L..\n.....\n.....\n.....\n3 3 D\n4\nFACE L\nFACE U\nFACE R\nFACE D\n",
            "out": "3 3 L\n3 3 U\n3 3 R\n3 3 D\n",
        },
        {
            "in": "4\n....\nL..L\n.L..\n....\n4 1 U\n5\nMOVE\nFACE R\nMOVE\nFACE U\nMOVE\n",
            "out": "3 1 U\n3 1 R\nGame Over\n",
        },
        {
            "in": "6\n......\n..L...\n...L..\n......\n.L....\n......\n1 1 R\n8\nMOVE\nMOVE\nMOVE\nFACE D\nMOVE\nFACE R\nMOVE\nMOVE\n",
            "out": "1 2 R\n1 3 R\n1 4 R\n1 4 D\n2 4 D\n2 4 R\n2 5 R\n2 6 R\n",
        },
    ],
    "binary_search": [
        {"in": "-5 -1 0 0.1 0.2\n0.5\n", "out": "2\n"},
        {"in": "10 20 30\n1000000000\n", "out": "2\n"},
        {"in": "-10 -9 -8\n1.0001\n", "out": "-1\n"},
        {"in": "-20 -10 -5\n0.000001\n", "out": "1\n"},
    ],
    "merge": [
        {"in": "1.0 3.0 5.0\n2.0 4.0 6.0\n0\n", "out": "1.0 2.0 3.0 4.0 5.0 6.0\n"},
        {"in": "1.0 2.0\n3.0 4.0\n0\n", "out": "1.0 2.0 3.0 4.0\n"},
        {
            "in": "1.0 2.0 2.0 5.0\n2.0 2.0 3.0\n0\n",
            "out": "1.0 2.0 2.0 2.0 2.0 3.0 5.0\n",
        },
        {
            "in": "-3.5 -1.2 0.0\n-2.0 -1.2 2.4\n0\n",
            "out": "-3.5 -2.0 -1.2 -1.2 0.0 2.4\n",
        },
        {"in": "0.1 0.2 0.3 4.0\n0.15 0.25\n0\n", "out": "0.1 0.15 0.2 0.25 0.3 4.0\n"},
        {"in": "1.5\n1.4\n0\n", "out": "1.4 1.5\n"},
        {
            "in": "100.0 200.0\n-50.0 0.0 50.0\n0\n",
            "out": "-50.0 0.0 50.0 100.0 200.0\n",
        },
        {"in": "1.1 1.2\n1.1 1.2\n0\n", "out": "1.1 1.1 1.2 1.2\n"},
    ],
    "cancel": [
        {"in": "1 2 3\n", "out": "1 2 3\n"},
        {"in": "-2 1 2 3 4\n", "out": "3 4\n"},
        {"in": "-2 0 1 0 -1 2 0 3\n", "out": "0 0 3\n"},
        {"in": "-3 1 -2 2 2 2\n", "out": "-2\n"},
        {"in": "1 2 -1 3 4\n", "out": "1 2 4\n"},
        {"in": "-1 -2 1 2 3\n", "out": "-2\n"},
        {"in": "0 0 -2 0 0 1 0\n", "out": "0 0 1 0\n"},
        {"in": "-2 -1 -1 5\n", "out": "-1 -1\n"},
    ],
    "vector": [
        {"in": "1 0\n0 1\n", "out": "1.5707963267948966\n"},
        {"in": "1 0\n1 0\n", "out": "0.0\n"},
        {"in": "1 0\n-1 0\n", "out": "3.141592653589793\n"},
        {"in": "1 2 3\n4 5 6\n", "out": "0.2257261285527342\n"},
        {"in": "2 0 0\n1 1 0\n", "out": "0.7853981633974484\n"},
        {"in": "1 1 1\n-1 1 -1\n", "out": "1.9106332362490186\n"},
        {"in": "-1 0\n1 1\n", "out": "2.356194490192345\n"},
    ],
}


@dataclass
class CaseResult:
    name: str
    passed: bool
    expected: str
    got: str
    diff: Optional[str]
    returncode: int
    timed_out: bool


def normalize(s: str) -> str:
    s = "\n".join(line.rstrip() for line in s.splitlines())
    if s and not s.endswith("\n"):
        s += "\n"
    return s


def load_cases(path: str) -> Dict[str, List[Dict[str, str]]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data


def choose_cases(
    mode: str, cases_from_file: Optional[Dict[str, Any]]
) -> List[Dict[str, str]]:
    if cases_from_file is not None:
        return cases_from_file[mode]
    return BUILTIN_CASES[mode]


def run_one_case(
    python_exe: str, solution_path: str, case_in: str, timeout: float
) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            [python_exe, solution_path],
            input=case_in.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(
            args=[python_exe, solution_path],
            returncode=-9,
            stdout=e.stdout or b"",
            stderr=e.stderr or b"TIMEOUT",
        )


def color(s: str, code: str) -> str:
    return f"\033[{code}m{s}\033[0m"


def green(s: str) -> str:
    return color(s, "32")


def red(s: str) -> str:
    return color(s, "31")


def yellow(s: str) -> str:
    return color(s, "33")


def bold(s: str) -> str:
    return color(s, "1")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run solution.py against testcases and verify output."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--transducer", action="store_true")
    group.add_argument("--lava", action="store_true")
    group.add_argument("--binary_search", action="store_true")
    group.add_argument("--merge", action="store_true")
    group.add_argument("--cancel", action="store_true")
    group.add_argument("--vector", action="store_true")
    parser.add_argument("--cases", type=str, default=None)
    parser.add_argument("--solution", type=str, default="solution.py")
    parser.add_argument("--python", type=str, default=sys.executable)
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--exact", action="store_true")
    parser.add_argument("--show-stderr", action="store_true")
    parser.add_argument("--stop-on-fail", action="store_true")
    args = parser.parse_args()

    if args.transducer:
        mode = "transducer"
    elif args.lava:
        mode = "lava"
    elif args.binary_search:
        mode = "binary_search"
    elif args.merge:
        mode = "merge"
    elif args.cancel:
        mode = "cancel"
    elif args.vector:
        mode = "vector"

    cases_from_file = load_cases(args.cases) if args.cases else None
    cases = choose_cases(mode, cases_from_file)

    print(bold(f"Running {len(cases)} {mode} test(s) against {args.solution}"))
    failed = 0

    for idx, case in enumerate(cases, start=1):
        name = f"{mode}#{idx}"
        expected = case["out"]
        completed = run_one_case(args.python, args.solution, case["in"], args.timeout)
        out = completed.stdout.decode("utf-8", errors="replace")

        if args.exact:
            exp_cmp, out_cmp = expected, out
        else:
            exp_cmp, out_cmp = normalize(expected), normalize(out)

        passed = (exp_cmp == out_cmp) and (completed.returncode == 0)

        if passed:
            print(green(f"✔ {name} passed"))
            # Optionally show stderr for passing cases if requested
            if args.show_stderr and completed.stderr:
                print(yellow("— stderr —"))
                sys.stdout.write(completed.stderr.decode("utf-8", errors="replace"))
                print()
        else:
            failed += 1
            print(red(f"✘ {name} failed (returncode={completed.returncode})"))
            print(yellow("- input -"))
            print(case["in"])
            print(yellow("- your output -"))
            print(out)
            print(yellow("- expected -"))
            print(expected)
            print(yellow("— return code —"))
            print(str(completed.returncode))
            # Always show stderr for failing cases to aid debugging
            if completed.stderr:
                print(yellow("— stderr —"))
                sys.stdout.write(completed.stderr.decode("utf-8", errors="replace"))
                print()
            if args.stop_on_fail:
                break

    total = len(cases)
    if failed == 0:
        print(bold(green(f"\nAll {total} test(s) passed.")))
        return 0
    else:
        print(bold(red(f"\n{failed}/{total} test(s) failed; {total - failed} passed.")))
        return 1


if __name__ == "__main__":
    sys.exit(main())
