"""Export the authoritative OpenAPI schema without starting the HTTP server."""

import json
from pathlib import Path

from .main import app

if __name__ == "__main__":
    target = Path(__file__).resolve().parents[2] / "contracts" / "openapi.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"OpenAPI exported: {target.name}")
