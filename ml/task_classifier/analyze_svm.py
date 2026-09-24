from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics import confusion_matrix
from sklearn.model_selection import StratifiedKFold
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "tasks.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
FOLDS = 5


def load_rows():
    with DATA_PATH.open("r", encoding="utf-8") as file:
        rows = json.load(file)
    return [row for row in rows if row["expected"] != "other"]


def encode_rows(model, rows):
    labels = np.array([row["expected"] for row in rows])
    embeddings = model.encode([row["input"] for row in rows], normalize_embeddings=True, show_progress_bar=True)
    return np.asarray(embeddings, dtype=np.float32), labels


def get_top_two(classes, scores):
    order = np.argsort(scores)[::-1]
    top_index, second_index = order[0], order[1]
    return {
        "top_category": classes[top_index],
        "top_score": float(scores[top_index]),
        "second_category": classes[second_index],
        "second_score": float(scores[second_index]),
        "margin": float(scores[top_index] - scores[second_index]),
    }


def main():
    rows = load_rows()
    print(f"Loading {MODEL_NAME}...")
    embeddings, labels = encode_rows(SentenceTransformer(MODEL_NAME), rows)
    cv = StratifiedKFold(n_splits=FOLDS, shuffle=True, random_state=42)
    predictions, expected_labels, detailed_results = [], [], []
    for fold_index, (train_index, test_index) in enumerate(cv.split(embeddings, labels), start=1):
        classifier = LinearSVC(class_weight="balanced", random_state=42)
        classifier.fit(embeddings[train_index], labels[train_index])
        scores = classifier.decision_function(embeddings[test_index])
        predicted = classifier.predict(embeddings[test_index])
        predictions.extend(predicted.tolist())
        expected_labels.extend(labels[test_index].tolist())
        for local_index, row_index in enumerate(test_index):
            top_two = get_top_two(classifier.classes_, scores[local_index])
            expected, actual = labels[row_index], predicted[local_index]
            detailed_results.append({"fold": fold_index, "input": rows[row_index]["input"], "expected": expected, "actual": actual, "correct": actual == expected, **top_two})

    labels_sorted = sorted(set(expected_labels))
    matrix = confusion_matrix(expected_labels, predictions, labels=labels_sorted)
    print("\n=== Confusion Matrix ===")
    print("expected\\actual".ljust(18) + " ".join(label[:8].ljust(9) for label in labels_sorted))
    for row_label, row_values in zip(labels_sorted, matrix):
        print(row_label.ljust(18) + " ".join(str(value).ljust(9) for value in row_values))
    print("\n=== Most Common Confusions ===")
    confusion_counts = defaultdict(int)
    for result in detailed_results:
        if not result["correct"]:
            confusion_counts[(result["expected"], result["actual"])] += 1
    for (expected, actual), count in sorted(confusion_counts.items(), key=lambda item: item[1], reverse=True):
        print(f"{expected:<16} → {actual:<16} {count}")
    print("\n=== Lowest-Margin Predictions ===")
    for result in sorted(detailed_results, key=lambda item: item["margin"])[:30]:
        print(f"\n[{'OK' if result['correct'] else 'WRONG'}] margin={result['margin']:.4f}\nexpected={result['expected']} actual={result['actual']}\ntop={result['top_category']} ({result['top_score']:.4f}) second={result['second_category']} ({result['second_score']:.4f})\n{result['input']}")
    print("\n=== Wrong Predictions, Highest Confidence ===")
    for result in sorted((item for item in detailed_results if not item["correct"]), key=lambda item: item["margin"], reverse=True)[:30]:
        print(f"\nmargin={result['margin']:.4f}\nexpected={result['expected']} actual={result['actual']}\ntop={result['top_category']} ({result['top_score']:.4f}) second={result['second_category']} ({result['second_score']:.4f})\n{result['input']}")


if __name__ == "__main__":
    main()
