import sys
import math


def read_list():
    """Reads a space-separated list of numbers from stdin."""
    line = sys.stdin.readline().strip()
    return list(map(float, line.split()))


def main():
    arr1 = read_list()
    arr2 = read_list()
