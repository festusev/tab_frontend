import sys


def read_string():
    """Reads the input string S from stdin (single line)."""
    line = sys.stdin.readline()
    if not line:
        return ""
    return line.rstrip("\n")


def main():
    # Step 1: Read the raw input string
    s = read_string()
