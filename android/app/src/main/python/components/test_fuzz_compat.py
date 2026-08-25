"""Self-check for the pure-Python fuzz path — the one that runs on Android.

Run it directly:  python components/test_fuzz_compat.py

Why this exists: the dev machine HAS rapidfuzz installed, so `from
fuzz_compat import fuzz` gives you rapidfuzz here and _PyFuzz on the phone.
Testing `fuzz` therefore tests the wrong implementation and proves nothing about
the APK. Everything below drives _PyFuzz explicitly.

What it guards: _PyFuzz.ratio is memoised and partial_ratio short-circuits on a
contained substring. Both are meant to be pure speed-ups. This asserts they
return exactly what the un-optimised implementation returned, because a drift
here silently re-ranks every search result and re-buckets every cross-source
merge — with nothing to see until someone notices the wrong song at the top.
"""

import sys
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from components.fuzz_compat import _PyFuzz  # noqa: E402


# ── The implementation as it stood before the optimisations ──────────────────
def ref_ratio(s1, s2):
    if not s1 and not s2:
        return 100.0
    if not s1 or not s2:
        return 0.0
    return SequenceMatcher(None, s1, s2).ratio() * 100.0


def ref_partial(s1, s2):
    if not s1 or not s2:
        return 0.0
    shorter, longer = (s1, s2) if len(s1) <= len(s2) else (s2, s1)
    n = len(shorter)
    if n == len(longer):
        return ref_ratio(shorter, longer)
    best = 0.0
    for i in range(len(longer) - n + 1):
        score = SequenceMatcher(None, shorter, longer[i:i + n]).ratio() * 100.0
        if score > best:
            best = score
            if best == 100.0:
                break
    return best


def ref_token_sort(s1, s2):
    # The token LIST, not the set — duplicates are kept, which matters for a
    # title like "kun faya kun".
    a = " ".join(sorted((s1 or "").split()))
    b = " ".join(sorted((s2 or "").split()))
    return ref_ratio(a, b)


def ref_token_set(s1, s2):
    t1, t2 = set((s1 or "").split()), set((s2 or "").split())
    if not t1 or not t2:
        return 0.0
    inter = sorted(t1 & t2)
    if not inter:
        return ref_token_sort(s1, s2)
    base = " ".join(inter)
    f1 = (base + " " + " ".join(sorted(t1 - t2))).strip()
    f2 = (base + " " + " ".join(sorted(t2 - t1))).strip()
    return max(ref_ratio(base, f1), ref_ratio(base, f2), ref_ratio(f1, f2))


PAIRS = [
    ("blinding lights", "the weeknd - blinding lights official video"),
    ("arz kiya hai", "arz kiya hai anuv jain"),
    ("ars kiya hai", "arz kiya hai"),
    ("", ""),
    ("", "x"),
    ("abc", "abc"),
    ("phir se ud chala", "kun faya kun"),
    ("tum hi ho", "tum hi ho aashiqui 2"),
    ("channa mereya", "channa mereya - ae dil hai mushkil"),
    ("a", "aaaaaaaaab"),
    ("hello world", "world hello"),
    ("kal ho naa ho", "kal ho na ho title track"),
    ("song", "song slowed and reverb"),
]


def main():
    for a, b in PAIRS:
        # Both orders: ratio is NOT symmetric, which is exactly why the cache
        # must key on the arguments in order rather than on a sorted pair.
        for x, y in ((a, b), (b, a)):
            assert abs(_PyFuzz.ratio(x, y) - ref_ratio(x, y)) < 1e-9, \
                f"ratio drifted on {(x, y)}"
            assert abs(_PyFuzz.partial_ratio(x, y) - ref_partial(x, y)) < 1e-9, \
                f"partial_ratio drifted on {(x, y)}"
            assert abs(_PyFuzz.token_set_ratio(x, y) - ref_token_set(x, y)) < 1e-9, \
                f"token_set_ratio drifted on {(x, y)}"

    # Calling twice must give the same answer — a cache that returns a stale or
    # wrong-keyed entry would show up here.
    for a, b in PAIRS:
        assert _PyFuzz.ratio(a, b) == _PyFuzz.ratio(a, b)

    # The behaviour search actually depends on: extra words must stay cheap.
    assert _PyFuzz.token_set_ratio(
        "blinding lights", "blinding lights slowed reverb") > 88
    # ...and a contained title is a perfect partial match.
    assert _PyFuzz.partial_ratio("blinding lights", "xx blinding lights yy") == 100.0
    # Degenerate inputs.
    assert _PyFuzz.ratio("", "") == 100.0
    assert _PyFuzz.ratio("", "x") == 0.0
    assert _PyFuzz.partial_ratio("", "") == 0.0

    print("fuzz_compat: OK")


if __name__ == "__main__":
    main()
