import sys
import math


def read_list():
    """Reads a space-separated list of numbers from stdin."""
    line = sys.stdin.readline().strip()
    return list(map(float, line.split()))


def read_value():
    """Reads a single number k from stdin."""
    line = sys.stdin.readline().strip()
    return float(line)


def main():
    arr = read_list()
    k = read_value()
