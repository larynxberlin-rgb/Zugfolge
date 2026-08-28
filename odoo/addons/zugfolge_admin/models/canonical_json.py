import hashlib
import json


MAX_SAFE_INTEGER = 9_007_199_254_740_991


def _json_contract_value(value):
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise TypeError("Nur sichere Ganzzahlen duerfen kanonisch signiert werden.")
        return value
    if isinstance(value, float):
        raise TypeError("Gleitkommazahlen duerfen nicht kanonisch signiert werden.")
    if isinstance(value, list):
        return [_json_contract_value(item) for item in value]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("Kanonische JSON-Objektschluessel muessen Zeichenketten sein.")
        return {key: _json_contract_value(item) for key, item in value.items()}
    raise TypeError("Nicht serialisierbarer Wert darf nicht kanonisch signiert werden.")


def canonical_json(value):
    """Match Commerce canonicalJson: sorted keys, compact UTF-8 JSON values."""
    return json.dumps(
        _json_contract_value(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def canonical_sha256(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
