# HustleXP classifier evaluation pack

- `blind_holdout_300.json` has been consumed. It is historical evaluation evidence and must not be presented or reused as a fresh blind score.
- `known_classifier_regressions.json` contains four known classifier mismatches promoted to development/regression data.
- `classifierDevelopmentCases.ts` contains the current 380-case generated development suite. It remains separate from classifier training data.

Run the TypeScript development sweep and export raw model scores from the repository root:

```powershell
npx tsx backend/src/services/taskClassification/evaluateClassifierDevelopment.ts --write=ml/task_classifier/eval/development_scores.json
```

Then run the Python C-grid and cross-validation report:

```powershell
cd ml/task_classifier
.\.venv\Scripts\python.exe evaluate_extended.py
```

`development_scores.json` and the embedding cache are generated inputs and should not be committed. A new, separately supplied holdout is required for the next blind evaluation.
