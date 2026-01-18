"""
FastEmbed HTTP Service

Simple HTTP API for generating embeddings using fastembed.
"""

import os
from flask import Flask, request, jsonify
from fastembed import TextEmbedding

app = Flask(__name__)

# Initialize model (lazy loading)
_model = None
MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")


def get_model():
    """Lazy load the embedding model."""
    global _model
    if _model is None:
        print(f"Loading model: {MODEL_NAME}")
        _model = TextEmbedding(model_name=MODEL_NAME)
        print("Model loaded successfully")
    return _model


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok"})


@app.route("/embed", methods=["POST"])
def embed():
    """
    Generate embeddings for text.

    Request body:
        {"text": "single text"} or {"texts": ["text1", "text2", ...]}

    Response:
        {"embeddings": [[...], [...], ...], "dimensions": 384}
    """
    data = request.get_json()

    if not data:
        return jsonify({"error": "No JSON body provided"}), 400

    # Support both single text and batch
    if "text" in data:
        texts = [data["text"]]
    elif "texts" in data:
        texts = data["texts"]
    else:
        return jsonify({"error": "Provide 'text' or 'texts' field"}), 400

    if not texts:
        return jsonify({"embeddings": [], "dimensions": 384})

    try:
        model = get_model()

        # Generate embeddings
        embeddings = list(model.embed(texts))

        # Convert to lists (from numpy arrays)
        embeddings_list = [emb.tolist() for emb in embeddings]

        return jsonify({
            "embeddings": embeddings_list,
            "dimensions": len(embeddings_list[0]) if embeddings_list else 384
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/info", methods=["GET"])
def info():
    """Return model information."""
    return jsonify({
        "model": MODEL_NAME,
        "dimensions": 384,  # MiniLM default
        "max_tokens": 256
    })


if __name__ == "__main__":
    # Pre-load model on startup
    get_model()
    app.run(host="0.0.0.0", port=8080)
