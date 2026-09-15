from __future__ import annotations

import hashlib
import json
import re
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.model_selection import StratifiedKFold
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
TRAINING_PATH = ROOT / "data" / "tasks.json"
DEVELOPMENT_PATH = ROOT / "eval" / "development_scores.json"
CACHE_PATH = Path(tempfile.gettempdir()) / "hustlexp_classifier_extended_embeddings.npz"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
THRESHOLDS = [0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
C_VALUES = [0.25, 0.5, 1.0, 2.0, 4.0]
PRODUCTION_THRESHOLD = 0.50

EVENT_SEMANTICS = re.compile(
    r"\b(?:event|party|wedding|reception|ceremony|celebration|gala|banquet|guests?|attendees?|"
    r"baby shower|corporate dinner|company dinner|anniversary dinner|graduation gathering)\b",
    re.IGNORECASE,
)


def load_data():
    with TRAINING_PATH.open("r", encoding="utf-8") as file:
        training_rows = [row for row in json.load(file) if row["expected"] != "other"]
    with DEVELOPMENT_PATH.open("r", encoding="utf-8") as file:
        development_rows = json.load(file)
    return training_rows, development_rows


def data_hash(training_rows, development_rows):
    payload = json.dumps(
        {
            "model": MODEL_NAME,
            "training": [(row["input"], row["expected"]) for row in training_rows],
            "development": [
                (row["input"], row["expectedCategory"]) for row in development_rows
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_or_encode(training_rows, development_rows):
    expected_hash = data_hash(training_rows, development_rows)
    if CACHE_PATH.exists():
        cached = np.load(CACHE_PATH)
        if str(cached["data_hash"].item()) == expected_hash:
            print(f"Using cached embeddings: {CACHE_PATH}")
            return cached["training"], cached["development"]

    model = SentenceTransformer(MODEL_NAME)
    training = np.asarray(
        model.encode(
            [row["input"] for row in training_rows],
            normalize_embeddings=True,
            show_progress_bar=True,
        ),
        dtype=np.float32,
    )
    development = np.asarray(
        model.encode(
            [row["input"] for row in development_rows],
            normalize_embeddings=True,
            show_progress_bar=True,
        ),
        dtype=np.float32,
    )
    np.savez_compressed(
        CACHE_PATH,
        data_hash=np.array(expected_hash),
        training=training,
        development=development,
    )
    return training, development


def top_predictions(classifier, embeddings):
    scores = classifier.decision_function(embeddings)
    order = np.argsort(scores, axis=1)[:, ::-1]
    top_indices = order[:, 0]
    second_indices = order[:, 1]
    top = classifier.classes_[top_indices]
    second = classifier.classes_[second_indices]
    margins = scores[np.arange(len(scores)), top_indices] - scores[
        np.arange(len(scores)), second_indices
    ]
    return top, second, margins


def resolve_predictions(inputs, top, margins, threshold):
    resolved = []
    for input_text, category, margin in zip(inputs, top, margins):
        if category == "events" and not EVENT_SEMANTICS.search(input_text):
            resolved.append(None)
        elif margin >= threshold:
            resolved.append(str(category))
        else:
            resolved.append(None)
    return resolved


def metrics(expected, actual):
    correct_emitted = 0
    incorrect_emitted = 0
    unnecessary_abstentions = 0
    correct_abstentions = 0
    false_concrete_on_vague = 0
    for wanted, got in zip(expected, actual):
        if wanted is None:
            if got is None:
                correct_abstentions += 1
            else:
                false_concrete_on_vague += 1
        elif wanted == got:
            correct_emitted += 1
        elif got is None:
            unnecessary_abstentions += 1
        else:
            incorrect_emitted += 1

    concrete_total = sum(wanted is not None for wanted in expected)
    emitted_total = correct_emitted + incorrect_emitted + false_concrete_on_vague
    return {
        "precision": correct_emitted / emitted_total if emitted_total else 0.0,
        "emission": emitted_total / len(expected),
        "concrete_accuracy": correct_emitted / concrete_total if concrete_total else 0.0,
        "incorrect_emitted": incorrect_emitted,
        "unnecessary_abstentions": unnecessary_abstentions,
        "false_concrete_on_vague": false_concrete_on_vague,
        "correct_emitted": correct_emitted,
        "correct_abstentions": correct_abstentions,
    }


def print_metric_row(prefix, result):
    print(
        f"{prefix:<22} {result['precision'] * 100:>8.2f}%"
        f" {result['emission'] * 100:>8.2f}%"
        f" {result['concrete_accuracy'] * 100:>8.2f}%"
        f" {result['incorrect_emitted']:>6}"
        f" {result['unnecessary_abstentions']:>7}"
        f" {result['false_concrete_on_vague']:>8}"
    )


def evaluate_development(training_embeddings, training_labels, development_embeddings, rows):
    inputs = [row["input"] for row in rows]
    expected = [row["expectedCategory"] for row in rows]
    print("\n=== Full-development SVM grid (model only; event semantic guard retained) ===")
    print("variant                 precision emission accuracy  wrong abstain false-vague")
    summaries = []
    for class_weight in ("balanced", None):
        for c_value in C_VALUES:
            classifier = LinearSVC(
                C=c_value, class_weight=class_weight, random_state=42
            )
            classifier.fit(training_embeddings, training_labels)
            top, _, margins = top_predictions(classifier, development_embeddings)
            candidates = []
            for threshold in THRESHOLDS:
                actual = resolve_predictions(inputs, top, margins, threshold)
                result = metrics(expected, actual)
                candidates.append((threshold, result))
                print_metric_row(
                    f"{class_weight or 'none'} C={c_value:g} t={threshold:.2f}", result
                )
            safe = [item for item in candidates if item[1]["precision"] >= 0.98]
            best = max(safe, key=lambda item: item[1]["emission"]) if safe else max(
                candidates, key=lambda item: item[1]["precision"]
            )
            summaries.append((class_weight or "none", c_value, best[0], best[1]))

    print("\n=== Best development point per SVM variant (>=98% when available) ===")
    print("variant                 precision emission accuracy  wrong abstain false-vague")
    for class_weight, c_value, threshold, result in summaries:
        print_metric_row(f"{class_weight} C={c_value:g} t={threshold:.2f}", result)


def evaluate_cross_validation(training_embeddings, labels):
    print(
        f"\n=== Five-fold cross-validation by C at threshold "
        f"{PRODUCTION_THRESHOLD:.2f} ==="
    )
    print("C       precision(mean±sd) coverage(mean±sd) recall(mean±sd)")
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    for c_value in C_VALUES:
        fold_precision = []
        fold_coverage = []
        fold_recall = []
        for train_index, test_index in cv.split(training_embeddings, labels):
            classifier = LinearSVC(
                C=c_value, class_weight="balanced", random_state=42
            )
            classifier.fit(training_embeddings[train_index], labels[train_index])
            top, _, margins = top_predictions(classifier, training_embeddings[test_index])
            accepted = margins >= PRODUCTION_THRESHOLD
            correct = top == labels[test_index]
            fold_precision.append(float(correct[accepted].mean()) if accepted.any() else 0.0)
            fold_coverage.append(float(accepted.mean()))
            fold_recall.append(float((correct & accepted).mean()))
        print(
            f"{c_value:<7g}"
            f" {np.mean(fold_precision) * 100:>7.2f}±{np.std(fold_precision) * 100:<5.2f}"
            f" {np.mean(fold_coverage) * 100:>7.2f}±{np.std(fold_coverage) * 100:<5.2f}"
            f" {np.mean(fold_recall) * 100:>7.2f}±{np.std(fold_recall) * 100:<5.2f}"
        )


def evaluate_cv_threshold_sweep(training_embeddings, labels):
    print("\n=== Five-fold threshold sweep: balanced C=1 ===")
    print("threshold precision(mean±sd) coverage(mean±sd) recall(mean±sd)")
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    fold_outputs = []
    for train_index, test_index in cv.split(training_embeddings, labels):
        classifier = LinearSVC(C=1.0, class_weight="balanced", random_state=42)
        classifier.fit(training_embeddings[train_index], labels[train_index])
        top, _, margins = top_predictions(classifier, training_embeddings[test_index])
        fold_outputs.append((top, margins, labels[test_index]))

    for threshold in THRESHOLDS:
        fold_precision = []
        fold_coverage = []
        fold_recall = []
        for top, margins, expected in fold_outputs:
            accepted = margins >= threshold
            correct = top == expected
            fold_precision.append(float(correct[accepted].mean()) if accepted.any() else 0.0)
            fold_coverage.append(float(accepted.mean()))
            fold_recall.append(float((correct & accepted).mean()))
        print(
            f"{threshold:<9.2f}"
            f" {np.mean(fold_precision) * 100:>7.2f}±{np.std(fold_precision) * 100:<5.2f}"
            f" {np.mean(fold_coverage) * 100:>7.2f}±{np.std(fold_coverage) * 100:<5.2f}"
            f" {np.mean(fold_recall) * 100:>7.2f}±{np.std(fold_recall) * 100:<5.2f}"
        )


def detailed_cross_validation(
    training_embeddings,
    labels,
    rows,
    c_value=1.0,
    threshold=PRODUCTION_THRESHOLD,
):
    print(f"\n=== Detailed CV: balanced C={c_value:g}, threshold={threshold:.2f} ===")
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    fold_results = []
    category_total = Counter()
    category_correct = Counter()
    confusion = Counter()
    for fold, (train_index, test_index) in enumerate(
        cv.split(training_embeddings, labels), start=1
    ):
        classifier = LinearSVC(
            C=c_value, class_weight="balanced", random_state=42
        )
        classifier.fit(training_embeddings[train_index], labels[train_index])
        top, _, margins = top_predictions(classifier, training_embeddings[test_index])
        accepted = margins >= threshold
        correct = top == labels[test_index]
        emitted_correct = int((accepted & correct).sum())
        emitted_total = int(accepted.sum())
        result = {
            "precision": emitted_correct / emitted_total if emitted_total else 0.0,
            "coverage": emitted_total / len(test_index),
            "recall": emitted_correct / len(test_index),
        }
        fold_results.append(result)
        print(
            f"fold {fold}: precision={result['precision'] * 100:.2f}% "
            f"coverage={result['coverage'] * 100:.2f}% "
            f"recall={result['recall'] * 100:.2f}%"
        )
        for local_index, row_index in enumerate(test_index):
            expected = str(labels[row_index])
            category_total[expected] += 1
            if accepted[local_index] and correct[local_index]:
                category_correct[expected] += 1
            elif accepted[local_index] and not correct[local_index]:
                confusion[(expected, str(top[local_index]))] += 1

    print(
        "variance: "
        f"precision={np.var([item['precision'] for item in fold_results]):.5f}, "
        f"coverage={np.var([item['coverage'] for item in fold_results]):.5f}, "
        f"recall={np.var([item['recall'] for item in fold_results]):.5f}"
    )
    print("\nPer-category accepted recall:")
    for category in sorted(category_total):
        print(
            f"{category:<16} {category_correct[category]}/{category_total[category]} "
            f"({category_correct[category] / category_total[category] * 100:.2f}%)"
        )
    print("\nEmitted confusion pairs:")
    for (expected, actual), count in confusion.most_common():
        print(f"{expected} -> {actual}: {count}")


def main():
    training_rows, development_rows = load_data()
    training_embeddings, development_embeddings = load_or_encode(
        training_rows, development_rows
    )
    labels = np.array([row["expected"] for row in training_rows])
    print(
        f"Training examples: {len(training_rows)}; "
        f"development examples: {len(development_rows)}"
    )
    evaluate_development(
        training_embeddings, labels, development_embeddings, development_rows
    )
    evaluate_cross_validation(training_embeddings, labels)
    evaluate_cv_threshold_sweep(training_embeddings, labels)
    detailed_cross_validation(training_embeddings, labels, training_rows)


if __name__ == "__main__":
    main()
