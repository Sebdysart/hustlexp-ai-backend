from __future__ import annotations

import hashlib
import json
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.model_selection import StratifiedKFold
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
TRAINING_PATH = ROOT / "data" / "tasks.json"
STRESS_PATH = ROOT / "eval" / "classifier_hardening.semantic4.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
CACHE_PATH = Path(tempfile.gettempdir()) / "hustlexp_hardening_model_embeddings.npz"
C_VALUES = [0.5, 1.0, 1.5, 2.0]
THRESHOLDS = [0.40, 0.45, 0.50, 0.55, 0.60]

BOUNDARY_ADDITIONS = [
    ("Rewire the bedroom fan beside a patched ceiling.", "electrical"),
    ("Repair the powered socket beside the storage cabinet.", "electrical"),
    ("Replace the switch mounted next to a bookcase.", "electrical"),
    ("Diagnose the dead receptacle above the counter.", "electrical"),
    ("Fix the light circuit behind the wall shelf.", "electrical"),
    ("Service the breaker beside a utility cupboard.", "electrical"),
    ("Repair the copper pipe below the vanity unit.", "plumbing"),
    ("Fix the drain line behind the wash basin.", "plumbing"),
    ("Replace the tap beside a damaged cabinet door.", "plumbing"),
    ("Unclog the basin near the wall panel.", "plumbing"),
    ("Service the shower valve behind the access cabinet.", "plumbing"),
    ("Mend the existing bracket behind the hallway mirror.", "handyman"),
    ("Repair the cupboard beside a working receptacle.", "handyman"),
    ("Tighten the fitted cabinet hinge near the sink.", "handyman"),
    ("Fix the wall surface surrounding a live switch.", "handyman"),
    ("Repair the installed shelf support below the panel.", "handyman"),
    ("Put the boxed entryway console table together.", "assembly"),
    ("Construct the flat packed sideboard in the hall.", "assembly"),
    ("Anchor the completed shelving unit to blockwork.", "assembly"),
    ("Secure the assembled display cabinet to plasterboard.", "assembly"),
]

LANGUAGE_ADDITIONS = [
    ("My saloon shudders whenever I apply the brakes.", "auto"),
    ("The hatchback takes several tries to crank on cold days.", "auto"),
    ("A dashboard warning symbol appeared during the drive.", "auto"),
    ("The gearbox pauses before it selects the next gear.", "auto"),
    ("Steering vibration starts once the car reaches speed.", "auto"),
    ("The rear screen wiper smears instead of clearing rain.", "auto"),
    ("Please diagnose a grinding noise from the brake pedal area.", "auto"),
    ("The vehicle turns over slowly despite a charged battery.", "auto"),
    ("Assess the damp stain spreading beside the skylight.", "home_services"),
    ("Investigate a bowed ceiling panel after rain entered.", "home_services"),
    ("Evaluate the swollen trim around the upstairs window.", "home_services"),
    ("Check the spongy wall section before repairs are planned.", "home_services"),
    ("Could you cut the overgrown grass behind the workshop?", "yard"),
    ("Looking for help weeding the narrow side garden.", "yard"),
    ("Need somebody to trim the shrubs along the driveway.", "yard"),
    ("Can a person assemble the boxed hallway bench?", "assembly"),
    ("I need help anchoring a finished cupboard to brickwork.", "assembly"),
    ("Looking for someone to rewire the faulty room light.", "electrical"),
    ("Can somebody repair the waste pipe below the basin?", "plumbing"),
    ("Need help mending a loose mirror mounting bracket.", "handyman"),
]


def encode(model, texts):
    return np.asarray(
        model.encode(texts, normalize_embeddings=True, show_progress_bar=True),
        dtype=np.float32,
    )


def top_and_margin(classifier, matrix):
    scores = classifier.decision_function(matrix)
    order = np.argsort(scores, axis=1)[:, ::-1]
    top_index = order[:, 0]
    second_index = order[:, 1]
    top = classifier.classes_[top_index]
    margins = scores[np.arange(len(scores)), top_index] - scores[
        np.arange(len(scores)), second_index
    ]
    return top, margins


def calculate(expected, top, margins, threshold):
    concrete = expected != None  # noqa: E711
    accepted = margins >= threshold
    correct = top == expected
    correct_emitted = int((concrete & accepted & correct).sum())
    wrong = int((concrete & accepted & ~correct).sum())
    abstained = int((concrete & ~accepted).sum())
    false_vague = int((~concrete & accepted).sum())
    vague_ok = int((~concrete & ~accepted).sum())
    emitted = correct_emitted + wrong + false_vague
    concrete_count = int(concrete.sum())
    return {
        "correct": correct_emitted,
        "wrong": wrong,
        "abstained": abstained,
        "vague_ok": vague_ok,
        "false_vague": false_vague,
        "precision": correct_emitted / emitted if emitted else 0.0,
        "coverage": (correct_emitted + wrong) / concrete_count,
        "accuracy": correct_emitted / concrete_count,
    }


def main():
    training = [
        row
        for row in json.loads(TRAINING_PATH.read_text(encoding="utf-8"))
        if row["expected"] != "other"
    ]
    stress = json.loads(STRESS_PATH.read_text(encoding="utf-8"))["rows"]
    existing_inputs = {row["input"] for row in training}
    boundary_additions = [
        row for row in BOUNDARY_ADDITIONS if row[0] not in existing_inputs
    ]
    language_additions = [
        row for row in LANGUAGE_ADDITIONS if row[0] not in existing_inputs
    ]
    additions = boundary_additions + language_additions
    all_texts = (
        [row["input"] for row in training]
        + [row["input"] for row in stress]
        + [text for text, _ in additions]
    )
    digest = hashlib.sha256(json.dumps(all_texts).encode()).hexdigest()
    if CACHE_PATH.exists():
        cache = np.load(CACHE_PATH)
        if str(cache["digest"].item()) == digest:
            embeddings = cache["embeddings"]
        else:
            embeddings = None
    else:
        embeddings = None
    if embeddings is None:
        model = SentenceTransformer(MODEL_NAME)
        embeddings = encode(model, all_texts)
        np.savez_compressed(CACHE_PATH, digest=np.array(digest), embeddings=embeddings)

    train_end = len(training)
    stress_end = train_end + len(stress)
    base_x = embeddings[:train_end]
    stress_x = embeddings[train_end:stress_end]
    addition_x = embeddings[stress_end:]
    base_y = np.array([row["expected"] for row in training])
    expected = np.array([row["expectedCategory"] for row in stress], dtype=object)
    variants = {"final_training": (base_x, base_y)}

    results = []
    for variant, (train_x, train_y) in variants.items():
        for c_value in C_VALUES:
            classifier = LinearSVC(C=c_value, class_weight="balanced", random_state=42)
            classifier.fit(train_x, train_y)
            top, margins = top_and_margin(classifier, stress_x)
            for threshold in THRESHOLDS:
                results.append(
                    {
                        "variant": variant,
                        "C": c_value,
                        "threshold": threshold,
                        **calculate(expected, top, margins, threshold),
                    }
                )

    cv_results = []
    combined_x, combined_y = variants["final_training"]
    cv_by_c = []
    for c_value in C_VALUES:
        folds = []
        splitter = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
        for fold, (train_index, test_index) in enumerate(
            splitter.split(combined_x, combined_y), start=1
        ):
            classifier = LinearSVC(C=c_value, class_weight="balanced", random_state=42)
            classifier.fit(combined_x[train_index], combined_y[train_index])
            top, margins = top_and_margin(classifier, combined_x[test_index])
            accepted = margins >= 0.5
            correct = top == combined_y[test_index]
            emitted = int(accepted.sum())
            correct_emitted = int((accepted & correct).sum())
            folds.append(
                {
                    "fold": fold,
                    "precision": correct_emitted / emitted if emitted else 0,
                    "coverage": emitted / len(test_index),
                    "accepted_recall": correct_emitted / len(test_index),
                }
            )
        cv_by_c.append({"C": c_value, "folds": folds})

    splitter = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    category_totals = Counter()
    category_correct = Counter()
    confusions = Counter()
    for fold, (train_index, test_index) in enumerate(
        splitter.split(combined_x, combined_y), start=1
    ):
        classifier = LinearSVC(C=1.0, class_weight="balanced", random_state=42)
        classifier.fit(combined_x[train_index], combined_y[train_index])
        top, margins = top_and_margin(classifier, combined_x[test_index])
        accepted = margins >= 0.5
        correct = top == combined_y[test_index]
        emitted = int(accepted.sum())
        correct_emitted = int((accepted & correct).sum())
        cv_results.append(
            {
                "fold": fold,
                "precision": correct_emitted / emitted if emitted else 0,
                "coverage": emitted / len(test_index),
                "accepted_recall": correct_emitted / len(test_index),
            }
        )
        for index, wanted in enumerate(combined_y[test_index]):
            category_totals[str(wanted)] += 1
            if accepted[index] and correct[index]:
                category_correct[str(wanted)] += 1
            elif accepted[index]:
                confusions[(str(wanted), str(top[index]))] += 1

    output = {
        "training_count": len(training),
        "stress_count": len(stress),
        "candidate_additions": {
            "boundary": len(boundary_additions),
            "language": len(language_additions),
        },
        "results": results,
        "cross_validation": {
            "by_c": cv_by_c,
            "folds": cv_results,
            "per_category_accepted_recall": {
                category: {
                    "correct": category_correct[category],
                    "total": category_totals[category],
                }
                for category in sorted(category_totals)
            },
            "confusions": [
                {"expected": pair[0], "actual": pair[1], "count": count}
                for pair, count in confusions.most_common()
            ],
        },
    }
    output_path = ROOT / "eval" / "hardening_model_final_grid.json"
    output_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    for row in results:
        if row["threshold"] == 0.5:
            print(
                f"{row['variant']:<20} C={row['C']:<3} "
                f"precision={row['precision']:.4f} coverage={row['coverage']:.4f} "
                f"correct={row['correct']} wrong={row['wrong']} abstain={row['abstained']} "
                f"false_vague={row['false_vague']}"
            )
    print("CV folds:", cv_results)
    print("Wrote", output_path)


if __name__ == "__main__":
    main()
