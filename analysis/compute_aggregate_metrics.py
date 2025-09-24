#!/usr/bin/env python3
"""
Compute aggregate suggestion metrics across multiple problems/ folders.

This script processes all problem directories in human_study_problems_folders/,
loads the mapping files to determine which actual method each assistant represents,
and aggregates metrics by method across all problems.

Usage:
    python3 analysis/compute_aggregate_metrics.py [--problems-dir PATH]

Defaults to scanning the "human_study_problems_folders" directory.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

try:
    from scipy.stats import norm, ttest_ind
except ImportError:
    norm = None
    ttest_ind = None

# Import the existing metrics computation functionality
from compute_suggestion_metrics import Metrics, scan_problems_dir


@dataclass(frozen=True)
class AggregateMetrics:
    """Aggregated metrics for a method across all problems."""

    total_proposed: int = 0
    total_accepted: int = 0
    total_suggested_chars: int = 0
    total_suggested_chars_deleted: int = 0
    problem_count: int = 0
    csv_file_count: int = 0
    # Individual measurements for standard error calculation
    individual_acceptance_rates: List[float] = None  # type: ignore
    individual_avg_deleted_chars: List[float] = None  # type: ignore
    individual_avg_suggestion_lengths: List[float] = None  # type: ignore

    def __post_init__(self):
        if self.individual_acceptance_rates is None:
            object.__setattr__(self, "individual_acceptance_rates", [])
        if self.individual_avg_deleted_chars is None:
            object.__setattr__(self, "individual_avg_deleted_chars", [])
        if self.individual_avg_suggestion_lengths is None:
            object.__setattr__(self, "individual_avg_suggestion_lengths", [])

    @property
    def acceptance_rate(self) -> float:
        """Calculate acceptance rate (accepted / proposed)."""
        return (
            (self.total_accepted / self.total_proposed * 100.0)
            if self.total_proposed > 0
            else 0.0
        )

    @property
    def deletion_rate(self) -> float:
        """Calculate deletion rate (deleted suggested chars / total suggested chars)."""
        return (
            (self.total_suggested_chars_deleted / self.total_suggested_chars * 100.0)
            if self.total_suggested_chars > 0
            else 0.0
        )

    @property
    def avg_deleted_chars_per_acceptance(self) -> float:
        """Calculate average deleted characters per accepted suggestion."""
        return (
            (self.total_suggested_chars_deleted / self.total_accepted)
            if self.total_accepted > 0
            else 0.0
        )

    @property
    def avg_accepted_suggestion_length(self) -> float:
        """Calculate average length of accepted suggestions in characters."""
        return (
            (self.total_suggested_chars / self.total_accepted)
            if self.total_accepted > 0
            else 0.0
        )

    @property
    def acceptance_rate_standard_error(self) -> float:
        """Calculate standard error of acceptance rate."""
        if len(self.individual_acceptance_rates) <= 1:
            return 0.0
        import statistics

        return statistics.stdev(self.individual_acceptance_rates) / (
            len(self.individual_acceptance_rates) ** 0.5
        )

    @property
    def avg_deleted_chars_standard_error(self) -> float:
        """Calculate standard error of average deleted characters."""
        if len(self.individual_avg_deleted_chars) <= 1:
            return 0.0
        import statistics

        return statistics.stdev(self.individual_avg_deleted_chars) / (
            len(self.individual_avg_deleted_chars) ** 0.5
        )

    @property
    def avg_suggestion_length_standard_error(self) -> float:
        """Calculate standard error of average suggestion length."""
        if len(self.individual_avg_suggestion_lengths) <= 1:
            return 0.0
        import statistics

        return statistics.stdev(self.individual_avg_suggestion_lengths) / (
            len(self.individual_avg_suggestion_lengths) ** 0.5
        )


def two_proportion_z_test(
    metrics1: AggregateMetrics, metrics2: AggregateMetrics
) -> float:
    """
    Perform a two-proportion z-test to compare acceptance rates between two methods.

    Tests the hypothesis that method1 has a higher acceptance rate than method2.

    Args:
        metrics1: Metrics for the first method (e.g., eta4)
        metrics2: Metrics for the second method (e.g., untrained10)

    Returns:
        p-value for the one-sided test (method1 > method2)
    """
    if norm is None:
        return float("nan")  # Return NaN if scipy is not available

    # Get the counts
    n1 = metrics1.total_proposed
    x1 = metrics1.total_accepted
    n2 = metrics2.total_proposed
    x2 = metrics2.total_accepted

    if n1 == 0 or n2 == 0:
        return float("nan")

    # Calculate sample proportions
    p1 = x1 / n1
    p2 = x2 / n2

    # If both proportions are identical, p-value should be 0.5 (no difference)
    if p1 == p2:
        return 0.5

    # Calculate the pooled proportion under the null hypothesis
    # (that both methods have the same acceptance rate)
    pooled_p = (x1 + x2) / (n1 + n2)

    # Calculate the standard error of the difference
    se = (pooled_p * (1 - pooled_p) * (1 / n1 + 1 / n2)) ** 0.5

    if se == 0:
        return 0.5  # If standard error is 0, no difference between methods

    # Calculate the z-statistic
    z = (p1 - p2) / se

    # Calculate the p-value for the one-sided test (method1 > method2)
    p_value = 1 - norm.cdf(z)
    return p_value


def t_test_deleted_chars(
    metrics1: AggregateMetrics, metrics2: AggregateMetrics
) -> float:
    """
    Perform a t-test to compare average deleted characters per acceptance between two methods.

    Tests the hypothesis that method1 has fewer deleted characters per acceptance than method2.

    Args:
        metrics1: Metrics for the first method (e.g., eta4)
        metrics2: Metrics for the second method (e.g., untrained10)

    Returns:
        p-value for the one-sided test (method1 < method2)
    """
    if ttest_ind is None:
        return float("nan")  # Return NaN if scipy is not available

    # Get the individual measurements for each method
    values1 = metrics1.individual_avg_deleted_chars
    values2 = metrics2.individual_avg_deleted_chars

    if len(values1) < 2 or len(values2) < 2:
        return float("nan")

    # Perform a two-sample t-test
    # We use alternative='less' to test if method1 < method2
    _, p_value = ttest_ind(values1, values2, alternative="less")
    return p_value


def load_mapping_file(problems_dir: Path) -> Dict[str, str]:
    """
    Load the mapping file for a problems directory.

    Returns a dict mapping obfuscated_dir_name -> actual_name.
    """
    mapping_path = problems_dir / "mapping_do_not_read.json"
    if not mapping_path.exists():
        print(f"Warning: No mapping file found in {problems_dir}")
        return {}

    try:
        with mapping_path.open("r", encoding="utf-8") as f:
            mapping_data = json.load(f)

        # Convert the nested structure to a simple mapping
        result = {}
        for assistant_data in mapping_data.values():
            if isinstance(assistant_data, dict):
                obfuscated = assistant_data.get("obfuscatedDirName")
                actual = assistant_data.get("actualName")
                if obfuscated and actual:
                    result[obfuscated] = actual

        return result
    except (json.JSONDecodeError, KeyError) as e:
        print(f"Warning: Error reading mapping file {mapping_path}: {e}")
        return {}


def aggregate_metrics_for_method(
    all_results: List[Tuple[str, Dict[str, Dict[str, Metrics]]]],
) -> AggregateMetrics:
    """
    Aggregate metrics across all problem directories.

    Args:
        all_results: List of (problem_dir_name, results) tuples from scan_problems_dir

    Returns:
        AggregateMetrics aggregated across all results
    """
    total_proposed = 0
    total_accepted = 0
    total_suggested_chars = 0
    total_suggested_chars_deleted = 0
    problem_count = 0
    csv_file_count = 0

    for _, results in all_results:
        # Find which obfuscated assistant name corresponds to this method
        method_found_in_problem = False

        for assistant_name, csv_files in results.items():
            # We need to check if this assistant corresponds to our method
            # This will be determined by the mapping file loaded separately
            if assistant_name in [
                "assistant_1",
                "assistant_2",
            ]:  # Only process assistant directories
                method_found_in_problem = True

                for _, metrics in csv_files.items():
                    total_proposed += metrics.proposed
                    total_accepted += metrics.accepted
                    total_suggested_chars += metrics.suggested_chars
                    total_suggested_chars_deleted += metrics.suggested_chars_deleted
                    csv_file_count += 1

        if method_found_in_problem:
            problem_count += 1

    return AggregateMetrics(
        total_proposed=total_proposed,
        total_accepted=total_accepted,
        total_suggested_chars=total_suggested_chars,
        total_suggested_chars_deleted=total_suggested_chars_deleted,
        problem_count=problem_count,
        csv_file_count=csv_file_count,
    )


def process_all_problems(problems_base_dir: Path) -> Dict[str, AggregateMetrics]:
    """
    Process all problem directories and aggregate metrics by method.

    Args:
        problems_base_dir: Base directory containing all problem folders

    Returns:
        Dict mapping method_name -> AggregateMetrics
    """
    if not problems_base_dir.exists() or not problems_base_dir.is_dir():
        raise SystemExit(f"Problems base directory not found: {problems_base_dir}")

    # Collect all results and mappings
    all_results: List[Tuple[str, Dict[str, Dict[str, Metrics]]]] = []
    all_mappings: List[Tuple[str, Dict[str, str]]] = []

    # Process each problem directory
    for problem_dir in sorted(p for p in problems_base_dir.iterdir() if p.is_dir()):
        problem_name = problem_dir.name
        print(f"Processing {problem_name}...")

        # Load mapping for this problem
        mapping = load_mapping_file(problem_dir)
        all_mappings.append((problem_name, mapping))

        # Scan the problems directory
        try:
            results = scan_problems_dir(problem_dir)
            all_results.append((problem_name, results))
        except (OSError, ValueError) as e:
            print(f"Warning: Error processing {problem_name}: {e}")
            continue

    # Create reverse mapping: method_name -> list of (problem_name, assistant_name)
    method_to_assistants: Dict[str, List[Tuple[str, str]]] = {}

    for problem_name, mapping in all_mappings:
        for obfuscated_name, actual_name in mapping.items():
            if actual_name not in method_to_assistants:
                method_to_assistants[actual_name] = []
            method_to_assistants[actual_name].append((problem_name, obfuscated_name))

    # Aggregate metrics for each method
    method_metrics: Dict[str, AggregateMetrics] = {}

    for method_name, assistant_list in method_to_assistants.items():
        total_proposed = 0
        total_accepted = 0
        total_suggested_chars = 0
        total_suggested_chars_deleted = 0
        problem_count = 0
        csv_file_count = 0

        # Track individual measurements per problem for standard error calculation
        individual_acceptance_rates = []
        individual_avg_deleted_chars = []
        individual_avg_suggestion_lengths = []

        # Count unique problems for this method
        unique_problems = set(problem_name for problem_name, _ in assistant_list)
        problem_count = len(unique_problems)

        # Aggregate metrics from all relevant assistant directories
        for problem_name, obfuscated_assistant in assistant_list:
            # Find the results for this problem
            problem_results = None
            for pname, results in all_results:
                if pname == problem_name:
                    problem_results = results
                    break

            if problem_results and obfuscated_assistant in problem_results:
                assistant_results = problem_results[obfuscated_assistant]

                # Calculate per-problem metrics
                problem_proposed = 0
                problem_accepted = 0
                problem_suggested_chars_deleted = 0
                problem_suggested_chars = 0

                for _, metrics in assistant_results.items():
                    total_proposed += metrics.proposed
                    total_accepted += metrics.accepted
                    total_suggested_chars += metrics.suggested_chars
                    total_suggested_chars_deleted += metrics.suggested_chars_deleted
                    csv_file_count += 1

                    # Accumulate for this problem
                    problem_proposed += metrics.proposed
                    problem_accepted += metrics.accepted
                    problem_suggested_chars_deleted += metrics.suggested_chars_deleted
                    problem_suggested_chars += metrics.suggested_chars

                # Calculate per-problem rates
                if problem_proposed > 0:
                    problem_acceptance_rate = (
                        problem_accepted / problem_proposed
                    ) * 100.0
                    individual_acceptance_rates.append(problem_acceptance_rate)

                if problem_accepted > 0:
                    problem_avg_deleted = (
                        problem_suggested_chars_deleted / problem_accepted
                    )
                    individual_avg_deleted_chars.append(problem_avg_deleted)

                    problem_avg_suggestion_length = (
                        problem_suggested_chars / problem_accepted
                    )
                    individual_avg_suggestion_lengths.append(
                        problem_avg_suggestion_length
                    )

        method_metrics[method_name] = AggregateMetrics(
            total_proposed=total_proposed,
            total_accepted=total_accepted,
            total_suggested_chars=total_suggested_chars,
            total_suggested_chars_deleted=total_suggested_chars_deleted,
            problem_count=problem_count,
            csv_file_count=csv_file_count,
            individual_acceptance_rates=individual_acceptance_rates,
            individual_avg_deleted_chars=individual_avg_deleted_chars,
            individual_avg_suggestion_lengths=individual_avg_suggestion_lengths,
        )

    return method_metrics


def print_aggregate_results(method_metrics: Dict[str, AggregateMetrics]) -> None:
    """Print the aggregated results in a formatted way."""
    if not method_metrics:
        print("No metrics found.")
        return

    print("=" * 80)
    print("AGGREGATE METRICS BY METHOD")
    print("=" * 80)
    print()

    for method_name, metrics in sorted(method_metrics.items()):
        print(f"Method: {method_name}")
        print(f"  Problems: {metrics.problem_count}")
        print(f"  CSV Files: {metrics.csv_file_count}")
        print(f"  Total Proposed: {metrics.total_proposed}")
        print(f"  Total Accepted: {metrics.total_accepted}")
        print(
            f"  Acceptance Rate: {metrics.acceptance_rate:.2f}% ± {metrics.acceptance_rate_standard_error:.2f}%"
        )
        print(f"  Total Suggested Chars: {metrics.total_suggested_chars}")
        print(
            f"  Total Deleted Suggested Chars: {metrics.total_suggested_chars_deleted}"
        )
        print(
            f"  Avg Accepted Suggestion Length: {metrics.avg_accepted_suggestion_length:.2f} ± {metrics.avg_suggestion_length_standard_error:.2f} chars"
        )
        print(
            f"  Avg Deleted Chars per Acceptance: {metrics.avg_deleted_chars_per_acceptance:.2f} ± {metrics.avg_deleted_chars_standard_error:.2f}"
        )
        print()

    # Print comparison if we have exactly 2 methods
    if len(method_metrics) == 2:
        methods = list(method_metrics.keys())
        m1, m2 = methods[0], methods[1]
        metrics1, metrics2 = method_metrics[m1], method_metrics[m2]

        print("=" * 80)
        print("COMPARISON")
        print("=" * 80)
        print()

        print("Acceptance Rate:")
        print(
            f"  {m1}: {metrics1.acceptance_rate:.2f}% ± {metrics1.acceptance_rate_standard_error:.2f}%"
        )
        print(
            f"  {m2}: {metrics2.acceptance_rate:.2f}% ± {metrics2.acceptance_rate_standard_error:.2f}%"
        )
        print(
            f"  Difference: {metrics1.acceptance_rate - metrics2.acceptance_rate:+.2f} percentage points"
        )

        # Calculate and display p-value from two-proportion z-test
        # Test if m1 has higher acceptance rate than m2
        p_value = two_proportion_z_test(metrics1, metrics2)
        if not (p_value != p_value):  # Check if not NaN
            print(f"  P-value ({m1} > {m2}): {p_value:.4f}")
            if p_value < 0.001:
                print("  Significance: *** (p < 0.001)")
            elif p_value < 0.01:
                print("  Significance: ** (p < 0.01)")
            elif p_value < 0.05:
                print("  Significance: * (p < 0.05)")
            else:
                print("  Significance: not significant (p >= 0.05)")
        else:
            print("  P-value: N/A (scipy not available)")
        print()

        print("Avg Deleted Chars per Acceptance:")
        print(
            f"  {m1}: {metrics1.avg_deleted_chars_per_acceptance:.2f} ± {metrics1.avg_deleted_chars_standard_error:.2f}"
        )
        print(
            f"  {m2}: {metrics2.avg_deleted_chars_per_acceptance:.2f} ± {metrics2.avg_deleted_chars_standard_error:.2f}"
        )
        print(
            f"  Difference: {metrics1.avg_deleted_chars_per_acceptance - metrics2.avg_deleted_chars_per_acceptance:+.2f} characters"
        )

        # Calculate and display p-value from t-test
        # Test if m1 has fewer deleted chars per acceptance than m2
        t_p_value = t_test_deleted_chars(metrics1, metrics2)
        if not (t_p_value != t_p_value):  # Check if not NaN
            print(f"  P-value ({m1} < {m2}): {t_p_value:.4f}")
            if t_p_value < 0.001:
                print("  Significance: *** (p < 0.001)")
            elif t_p_value < 0.01:
                print("  Significance: ** (p < 0.01)")
            elif t_p_value < 0.05:
                print("  Significance: * (p < 0.05)")
            else:
                print("  Significance: not significant (p >= 0.05)")
        else:
            print("  P-value: N/A (insufficient data or scipy not available)")
        print()

        print("Total Activity:")
        print(
            f"  {m1}: {metrics1.total_proposed} proposed, {metrics1.total_accepted} accepted"
        )
        print(
            f"  {m2}: {metrics2.total_proposed} proposed, {metrics2.total_accepted} accepted"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--problems-dir",
        dest="problems_dir",
        type=str,
        default="human_study_problems_folders",
        help="Path to the base directory containing all problem folders (default: human_study_problems_folders)",
    )
    args = parser.parse_args()

    problems_base_dir = Path(args.problems_dir).expanduser().resolve()
    method_metrics = process_all_problems(problems_base_dir)
    print_aggregate_results(method_metrics)


if __name__ == "__main__":
    main()
