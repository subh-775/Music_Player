"""
Fuzzy-ratio compatibility layer
===============================
Exposes a `fuzz` object with rapidfuzz's API. On desktop that IS rapidfuzz. On
Android it is a pure-Python reimplementation.

Why this exists: rapidfuzz is a C++ extension and has no Android wheel, so the
APK cannot ship it (see mobile/android/app/build.gradle). Callers used to guard
with `try: from rapidfuzz import fuzz / except ImportError: <give up>`, which
meant search ranking and cross-source dedup silently did NOTHING on mobile —
results came back in raw source order, unranked and unfiltered.

Import `fuzz` from here instead and the algorithm behaves the same on both
platforms; only the speed differs. Song titles are short, so the Python path
costs microseconds and nothing here is on a hot loop.

Scores are 0-100 floats, matching rapidfuzz.
"""

from difflib import SequenceMatcher
from typing import List

try:
    from rapidfuzz import fuzz  # noqa: F401  (re-exported)

    RAPIDFUZZ_AVAILABLE = True
except ImportError:
    RAPIDFUZZ_AVAILABLE = False


def _tokens(s: str) -> List[str]:
    return (s or "").split()


class _PyFuzz:
    """Pure-Python stand-in for the subset of rapidfuzz.fuzz we actually use.

    Callers are expected to have normalized (lowercased, punctuation-stripped)
    their input already — same assumption rapidfuzz callers make here.
    """

    @staticmethod
    def ratio(s1: str, s2: str, **_kw) -> float:
        if not s1 and not s2:
            return 100.0
        if not s1 or not s2:
            return 0.0
        return SequenceMatcher(None, s1, s2).ratio() * 100.0

    @staticmethod
    def partial_ratio(s1: str, s2: str, **_kw) -> float:
        """Best ratio of the shorter string against any window of the longer one.

        This is what lets "blinding lights" score high against
        "the weeknd - blinding lights (official video)".
        """
        if not s1 or not s2:
            return 0.0
        shorter, longer = (s1, s2) if len(s1) <= len(s2) else (s2, s1)
        n = len(shorter)
        if n == len(longer):
            return _PyFuzz.ratio(shorter, longer)

        best = 0.0
        # Slide a window the size of the shorter string across the longer one.
        # Titles are tens of characters, so the quadratic cost is irrelevant.
        for i in range(len(longer) - n + 1):
            score = SequenceMatcher(None, shorter, longer[i : i + n]).ratio() * 100.0
            if score > best:
                best = score
                if best == 100.0:
                    break
        return best

    @staticmethod
    def token_sort_ratio(s1: str, s2: str, **_kw) -> float:
        """Order-independent: "lights blinding" == "blinding lights"."""
        a = " ".join(sorted(_tokens(s1)))
        b = " ".join(sorted(_tokens(s2)))
        return _PyFuzz.ratio(a, b)

    @staticmethod
    def token_set_ratio(s1: str, s2: str, **_kw) -> float:
        """Tolerates EXTRA words on either side — the workhorse for search.

        Compares the shared tokens against each full string, so a query of
        "blinding lights" still scores ~100 against "blinding lights slowed
        reverb": the extra words cost nothing, they just don't help.

        Mirrors rapidfuzz: build the intersection, then each side's
        intersection+leftovers, and take the best of the three pairings.
        """
        t1, t2 = set(_tokens(s1)), set(_tokens(s2))
        if not t1 or not t2:
            return 0.0

        intersection = sorted(t1 & t2)
        if not intersection:
            # Nothing in common — fall back to a plain sorted-token compare
            # rather than reporting a hard 0.
            return _PyFuzz.token_sort_ratio(s1, s2)

        base = " ".join(intersection)
        full1 = (base + " " + " ".join(sorted(t1 - t2))).strip()
        full2 = (base + " " + " ".join(sorted(t2 - t1))).strip()

        return max(
            _PyFuzz.ratio(base, full1),
            _PyFuzz.ratio(base, full2),
            _PyFuzz.ratio(full1, full2),
        )

    @staticmethod
    def WRatio(s1: str, s2: str, **_kw) -> float:
        """rapidfuzz's "best guess" blend. Approximated as the strongest of the
        three measures, with the length-insensitive ones slightly discounted so
        an exact match still outranks a partial one."""
        if not s1 or not s2:
            return 0.0
        return max(
            _PyFuzz.ratio(s1, s2),
            _PyFuzz.partial_ratio(s1, s2) * 0.90,
            _PyFuzz.token_set_ratio(s1, s2) * 0.95,
        )

    @staticmethod
    def jaro_winkler(s1: str, s2: str, **_kw) -> float:
        """Jaro-Winkler, which rewards a shared prefix — good for short names."""
        if not s1 or not s2:
            return 0.0
        if s1 == s2:
            return 100.0

        len1, len2 = len(s1), len(s2)
        window = max(len1, len2) // 2 - 1
        if window < 0:
            window = 0

        s1_matches = [False] * len1
        s2_matches = [False] * len2
        matches = 0

        for i in range(len1):
            lo = max(0, i - window)
            hi = min(i + window + 1, len2)
            for j in range(lo, hi):
                if s2_matches[j] or s1[i] != s2[j]:
                    continue
                s1_matches[i] = s2_matches[j] = True
                matches += 1
                break

        if matches == 0:
            return 0.0

        # Transpositions: matched chars that are out of order relative to each other.
        transpositions = 0
        k = 0
        for i in range(len1):
            if not s1_matches[i]:
                continue
            while not s2_matches[k]:
                k += 1
            if s1[i] != s2[k]:
                transpositions += 1
            k += 1
        transpositions //= 2

        m = float(matches)
        jaro = (m / len1 + m / len2 + (m - transpositions) / m) / 3.0

        # Winkler bonus for a common prefix, capped at 4 chars.
        prefix = 0
        for i in range(min(4, len1, len2)):
            if s1[i] != s2[i]:
                break
            prefix += 1

        return (jaro + prefix * 0.1 * (1 - jaro)) * 100.0


if not RAPIDFUZZ_AVAILABLE:
    fuzz = _PyFuzz()  # type: ignore[assignment]


__all__ = ["fuzz", "RAPIDFUZZ_AVAILABLE"]
