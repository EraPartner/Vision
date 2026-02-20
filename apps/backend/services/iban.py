"""IBAN validation utilities.

Prefer `python-stdnum` when available; otherwise fall back to a small, dependency-free
checksum implementation.

Public API:
- normalize_iban(iban: str) -> str
- is_valid_iban(iban: str) -> bool
"""
from __future__ import annotations


def _fallback_normalize(iban: str) -> str:
    return "".join(iban.split()).upper()


def _fallback_is_valid(iban: str) -> bool:
    # simple mod-97 checksum implementation
    def _char_to_int(ch: str) -> str:
        if ch.isdigit():
            return ch
        return str(ord(ch) - ord("A") + 10)

    try:
        s = _fallback_normalize(iban)
    except Exception:
        return False
    if len(s) < 4:
        return False
    rearranged = s[4:] + s[:4]
    parts = [_char_to_int(ch) for ch in rearranged]
    num_str = "".join(parts)
    # compute mod 97 in chunks
    rem = 0
    chunk = 9
    for i in range(0, len(num_str), chunk):
        piece = num_str[i: i + chunk]
        rem = (rem * (10 ** len(piece)) + int(piece)) % 97
    return rem == 1


# Try to use python-stdnum if available
try:
    from stdnum import iban as _std_iban  # type: ignore


    def normalize_iban(iban: str) -> str:
        return _std_iban.compact(iban)


    def is_valid_iban(iban: str) -> bool:
        try:
            return _std_iban.is_valid(iban)
        except Exception:
            return False

except Exception:
    # Fallback implementations
    normalize_iban = _fallback_normalize
    is_valid_iban = _fallback_is_valid

__all__ = ["normalize_iban", "is_valid_iban"]
