from __future__ import annotations

import json
from pathlib import Path
from statistics import mean, pstdev

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "tasks.json"


def load_dataset():
    with DATA_PATH.open("r", encoding="utf-8") as file:
        rows = json.load(file)
    return rows, [row["input"] for row in rows], [row["expected"] for row in rows]


def build_models():
    def word():
        return TfidfVectorizer(lowercase=True, ngram_range=(1, 2), min_df=1, sublinear_tf=True)

    def char():
        return TfidfVectorizer(analyzer="char_wb", lowercase=True, ngram_range=(3, 5), min_df=1, sublinear_tf=True)

    def combined():
        return FeatureUnion([("word", word()), ("char", char())])

    return {
        "word_lr": Pipeline([("tfidf", word()), ("classifier", LogisticRegression(max_iter=5000, class_weight="balanced", random_state=42))]),
        "word_svm": Pipeline([("tfidf", word()), ("classifier", LinearSVC(class_weight="balanced", random_state=42))]),
        "word_char_lr": Pipeline([("features", combined()), ("classifier", LogisticRegression(max_iter=5000, class_weight="balanced", random_state=42))]),
        "word_char_svm": Pipeline([("features", combined()), ("classifier", LinearSVC(class_weight="balanced", random_state=42))]),
    }


def evaluate_dataset(rows, title: str):
    texts = [row["input"] for row in rows]
    labels = [row["expected"] for row in rows]
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    print(f"\n{'=' * 72}\n{title}\nExamples: {len(rows)}\n{'=' * 72}")
    results = []
    for name, model in build_models().items():
        scores = cross_val_score(model, texts, labels, cv=cv, scoring="accuracy")
        results.append((name, mean(scores), pstdev(scores), scores))
    results.sort(key=lambda item: item[1], reverse=True)
    for name, average, deviation, scores in results:
        folds = ", ".join(f"{score * 100:.1f}%" for score in scores)
        print(f"{name:<18} {average * 100:>6.2f}% (± {deviation * 100:.2f}) [{folds}]")
    winner = results[0]
    print(f"\nWinner: {winner[0]} ({winner[1] * 100:.2f}%)")


def main():
    rows, _, _ = load_dataset()
    evaluate_dataset(rows, "ALL CATEGORIES INCLUDING OTHER")
    evaluate_dataset([row for row in rows if row["expected"] != "other"], "SERVICE CATEGORIES ONLY")


if __name__ == "__main__":
    main()
