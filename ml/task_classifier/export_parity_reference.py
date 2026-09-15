from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "tasks.json"
OUTPUT_PATH = ROOT / "data" / "parity_reference.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def load_rows():
    with DATA_PATH.open("r", encoding="utf-8") as file:
        return [row for row in json.load(file) if row["expected"] != "other"]


def main():
    rows = load_rows()
    labels = np.array([row["expected"] for row in rows])
    print(f"Loading {MODEL_NAME}...")
    model = SentenceTransformer(MODEL_NAME)
    embeddings = np.asarray(model.encode([row["input"] for row in rows], normalize_embeddings=True, show_progress_bar=True), dtype=np.float32)
    classifier = LinearSVC(class_weight="balanced", random_state=42)
    classifier.fit(embeddings, labels)
    scores = classifier.decision_function(embeddings)
    output = []
    for index, row in enumerate(rows):
        row_scores = scores[index]
        order = np.argsort(row_scores)[::-1]
        top, second = int(order[0]), int(order[1])
        top_score, second_score = float(row_scores[top]), float(row_scores[second])
        output.append({"input": row["input"], "expected": row["expected"], "top_category": classifier.classes_[top], "top_score": top_score, "second_category": classifier.classes_[second], "second_score": second_score, "margin": top_score - second_score})
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as file:
        json.dump(output, file, indent=2)
    print(f"\nExported {len(output)} Python reference predictions.\n{OUTPUT_PATH}")


if __name__ == "__main__":
    main()
