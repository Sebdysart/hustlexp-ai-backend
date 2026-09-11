from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "tasks.json"
OUTPUT_PATH = (ROOT / ".." / ".." / "backend" / "models" / "task-classifier.json").resolve()
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
PRODUCTION_EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX"
AMBIGUITY_THRESHOLD = 0.45


def load_rows():
    with DATA_PATH.open("r", encoding="utf-8") as file:
        return [row for row in json.load(file) if row["expected"] != "other"]


def main():
    rows = load_rows()
    texts = [row["input"] for row in rows]
    labels = np.array([row["expected"] for row in rows])
    print(f"Loading embedding model: {MODEL_NAME}")
    embedding_model = SentenceTransformer(MODEL_NAME)
    print(f"Encoding {len(texts)} training examples...")
    embeddings = np.asarray(embedding_model.encode(texts, normalize_embeddings=True, show_progress_bar=True), dtype=np.float32)
    if embeddings.ndim != 2:
        raise RuntimeError("Expected a 2D embedding matrix.")
    dimensions = embeddings.shape[1]
    classifier = LinearSVC(class_weight="balanced", random_state=42)
    classifier.fit(embeddings, labels)
    artifact = {"format_version": 1, "classifier": "linear_svc", "training_embedding_model": MODEL_NAME, "runtime_embedding_model": PRODUCTION_EMBEDDING_MODEL, "embedding_dimensions": int(dimensions), "ambiguity_threshold": AMBIGUITY_THRESHOLD, "training_examples": len(rows), "classes": classifier.classes_.tolist(), "weights": classifier.coef_.astype(np.float64).tolist(), "bias": classifier.intercept_.astype(np.float64).tolist()}
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as file:
        json.dump(artifact, file, indent=2)
    print(f"\nTrained on {len(rows)} service examples.\nClasses: {', '.join(artifact['classes'])}\nSaved model to:\n{OUTPUT_PATH}")


if __name__ == "__main__":
    main()
