from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.model_selection import StratifiedKFold
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "tasks.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
THRESHOLDS = [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.75, 1.00]


def load_rows():
    with DATA_PATH.open("r", encoding="utf-8") as file:
        return [row for row in json.load(file) if row["expected"] != "other"]


def get_margin(scores):
    ordered = np.sort(scores)[::-1]
    return float(ordered[0] - ordered[1])


def main():
    rows = load_rows()
    texts = [row["input"] for row in rows]
    labels = np.array([row["expected"] for row in rows])
    print(f"Loading {MODEL_NAME}...")
    embeddings = np.asarray(SentenceTransformer(MODEL_NAME).encode(texts, normalize_embeddings=True, show_progress_bar=True), dtype=np.float32)
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    results = []
    for train_index, test_index in cv.split(embeddings, labels):
        classifier = LinearSVC(class_weight="balanced", random_state=42)
        classifier.fit(embeddings[train_index], labels[train_index])
        scores = classifier.decision_function(embeddings[test_index])
        predicted = classifier.predict(embeddings[test_index])
        results.extend({"correct": predicted[index] == labels[test_index][index], "margin": get_margin(scores[index])} for index in range(len(test_index)))
    total = len(results)
    print("\n=== Margin Threshold Analysis ===")
    print(f"{'threshold':<12}{'auto':<10}{'coverage':<12}{'accuracy':<12}{'clarify':<10}")
    for threshold in THRESHOLDS:
        accepted = [result for result in results if result["margin"] >= threshold]
        correct = sum(1 for result in accepted if result["correct"])
        accuracy = correct / len(accepted) if accepted else 0
        print(f"{threshold:<12.2f}{len(accepted):<10}{len(accepted) / total * 100:<11.1f}%{accuracy * 100:<11.1f}%{total - len(accepted):<10}")


if __name__ == "__main__":
    main()
