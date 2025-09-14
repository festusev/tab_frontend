import sys


def read_grid():
    """Reads N and then N lines of the grid. Returns (N, grid)."""
    n = int(sys.stdin.readline().strip())
    grid = [list(sys.stdin.readline().strip()) for _ in range(n)]
    return n, grid


def read_starting_position():
    """Reads r, c, dir. Returns (r, c, dir)."""
    parts = sys.stdin.readline().split()
    r, c, d = int(parts[0]), int(parts[1]), parts[2]
    return r, c, d

def read_q():
    """Reads q from stdin."""
    return int(sys.stdin.readline().strip())

def read_next_move():
    """Reads and returns the next command as a string, or None if EOF."""
    line = sys.stdin.readline()
    if not line:
        return None
    return line.strip()


def main():
