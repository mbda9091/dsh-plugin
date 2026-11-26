"""Fetch pinned local retrieval weights; no LLM credentials or inference calls."""
from huggingface_hub import snapshot_download

MODELS = (
    (
        "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
        "/models/embedding",
    ),
    (
        "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
        "1427fd652930e4ba29e8149678df786c240d8825",
        "/models/reranker",
    ),
)

if __name__ == "__main__":
    for model_id, revision, destination in MODELS:
        snapshot_download(
            repo_id=model_id,
            revision=revision,
            local_dir=destination,
            allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model"],
        )
