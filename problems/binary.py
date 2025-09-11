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

if __name__ == "__main__":
    # Process the input data
    for num in arr:
        if num >= k:
            print(num)
    sys.exit(0)  # Add a clean exit
    # Sort the array in ascending order
    arr.sort()
    # Binary search for the k-th largest element
    def binary_search(arr, target):
        low, high = 0, len(arr) - 1
        while low <= high:
            mid = (lo