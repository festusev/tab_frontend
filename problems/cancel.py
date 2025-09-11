import sys
import math


def read_list():
    """Reads a space-separated list of integers from stdin."""
    line = sys.stdin.readline().strip()
    return list(map(int, line.split())) if line else []


def main():
    arr = read_list()
