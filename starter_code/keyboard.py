import sys
from typing import List, Tuple


def read_q() -> int:
    """Read the number of typed characters (q) from the first line."""
    line = sys.stdin.readline()
    if not line:
        raise EOFError("Expected an integer q on the first line.")
    return int(line.strip())


def read_next_char() -> str:
    """
    Read the next 'character per line'.
    """
    line = sys.stdin.readline()
    if line == "":
        raise EOFError("Unexpected end of input while reading characters.")
    # Take the first character on the line.
    return line[0]


def main() -> None:
    q = read_q()

    for _ in range(q):
        char = read_next_char()
