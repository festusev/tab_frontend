# Metrics Test Data

This folder contains sample test data for testing the metrics computation scripts.

## Structure

```
metrics_tests/
├── test_problem_1/
│   ├── mapping_do_not_read.json
│   ├── assistant_1/
│   │   └── coding_log.csv
│   └── assistant_2/
│       └── coding_log.csv
└── test_problem_2/
    ├── mapping_do_not_read.json
    ├── assistant_1/
    │   └── coding_log.csv
    └── assistant_2/
        └── coding_log.csv
```

## Test Scenarios

### Test Problem 1
- **Assistant 1 (eta4)**: 2 suggestions accepted, 2 characters deleted from suggestions
- **Assistant 2 (untrained10)**: 2 suggestions accepted, 3 characters deleted from suggestions

### Test Problem 2  
- **Assistant 1 (untrained10)**: 2 suggestions accepted, 3 characters deleted from suggestions
- **Assistant 2 (eta4)**: 2 suggestions accepted, 1 character deleted from suggestions

## Expected Results

When running the aggregate metrics script on this test data:

- **eta4**: 0.75 ± 0.25 avg deleted chars per acceptance
- **untrained10**: 1.50 ± 0.00 avg deleted chars per acceptance
- **Difference**: untrained10 has 0.75 more characters deleted per acceptance

## Usage

```bash
# Test individual problem
python3 analysis/compute_suggestion_metrics.py --problems metrics_tests/test_problem_1

# Test aggregate metrics across all problems
python3 analysis/compute_aggregate_metrics.py --problems-dir metrics_tests
```

## Test Data Details

The CSV files contain realistic coding session logs with:
- `current_code` actions to set initial state
- `proposed_suggestion` actions showing AI suggestions
- `accepted_suggestion` actions when users accept suggestions
- `character_typed` actions for manual typing
- `deletion` actions for removing characters

The mapping files correctly map the obfuscated assistant names to the actual method names (eta4 and untrained10).
