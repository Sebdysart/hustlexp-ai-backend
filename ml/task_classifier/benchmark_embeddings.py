from __future__ import annotations

import json
from pathlib import Path
from statistics import mean, pstdev

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.neighbors import KNeighborsClassifier
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "tasks.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def load_dataset():
    with DATA_PATH.open("r", encoding="utf-8") as file:
        return json.load(file)


def encode(model, rows):
    texts = [row["input"] for row in rows]
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=True)
    labels = np.array([row["expected"] for row in rows])
    return np.asarray(embeddings, dtype=np.float32), labels


def build_models():
    return {
        "embedding_lr": LogisticRegression(max_iter=5000, class_weight="balanced", random_state=42),
        "embedding_svm": LinearSVC(class_weight="balanced", random_state=42),
        "embedding_knn_3": KNeighborsClassifier(n_neighbors=3, weights="distance", metric="cosine"),
        "embedding_knn_5": KNeighborsClassifier(n_neighbors=5, weights="distance", metric="cosine"),
    }


def evaluate(embeddings, labels, title):
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    results = []
    print(f"\n{'=' * 72}\n{title}\nExamples: {len(labels)}\n{'=' * 72}")
    for name, model in build_models().items():
        fold_scores = []
        for train_index, test_index in cv.split(embeddings, labels):
            model.fit(embeddings[train_index], labels[train_index])
            fold_scores.append(model.score(embeddings[test_index], labels[test_index]))
        results.append((name, mean(fold_scores), pstdev(fold_scores), fold_scores))
    results.sort(key=lambda item: item[1], reverse=True)
    for name, average, deviation, scores in results:
        score_text = ", ".join(f"{score * 100:.1f}%" for score in scores)
        print(f"{name:<18} {average * 100:>6.2f}% (± {deviation * 100:.2f}) [{score_text}]")
    winner = results[0]
    print(f"\nWinner: {winner[0]} ({winner[1] * 100:.2f}%)")


def main():
    rows = load_dataset()
    print(f"Loading {MODEL_NAME}...")
    model = SentenceTransformer(MODEL_NAME)
    embeddings, labels = encode(model, rows)
    evaluate(embeddings, labels, "ALL CATEGORIES INCLUDING OTHER")
    service_indices = np.array([index for index, row in enumerate(rows) if row["expected"] != "other"])
    evaluate(embeddings[service_indices], labels[service_indices], "SERVICE CATEGORIES ONLY")


if __name__ == "__main__":
    main()
