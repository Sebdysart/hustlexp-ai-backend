# HustleXP Classifier Blind Holdout V2

`blind_holdout_v2_1000.json` contains 1000 classifier-only cases.

Composition:
- 520 core category cases: 40 for each of 13 concrete categories
- 180 boundary/adversarial cases
- 100 multi-intent cases
- 80 vague cases expected to abstain
- 80 noisy/short realistic inputs
- 40 override false-positive traps

Policy:
- Final one-shot evaluation only.
- Do not inspect individual examples before evaluation.
- Do not train on it.
- Do not tune after reading its failures.
- After use, it becomes historical evaluation data, not a blind holdout.
