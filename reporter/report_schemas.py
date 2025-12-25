from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


def schema_dir() -> Path:
    return Path(__file__).resolve().parent / "schemas"


def schema_path_for_check_id(check_id: str) -> Path:
    return schema_dir() / f"{check_id}.schema.json"


def load_schema(check_id: str) -> dict[str, Any]:
    path = schema_path_for_check_id(check_id)
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_report(report: dict[str, Any]) -> None:
    check_id = report.get("checkId")
    if not isinstance(check_id, str) or not check_id:
        raise ValueError("Report must have non-empty string 'checkId'")

    schema = load_schema(check_id)
    Draft202012Validator(schema).validate(report)


def query_schema_path() -> Path:
    return schema_dir() / "query.schema.json"


def load_query_schema() -> dict[str, Any]:
    path = query_schema_path()
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_query_file(payload: dict[str, Any]) -> None:
    """
    Validate per-query JSON files produced by PostgresReportGenerator.generate_per_query_jsons().
    """
    schema = load_query_schema()
    Draft202012Validator(schema).validate(payload)


