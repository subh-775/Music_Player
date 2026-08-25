"""Line-ending-safe search/replace helper for the one-off refactors in this repo.

Files here are a mix of CRLF and LF (prettier normalises what it touches, git
does not). Matching multi-line patterns against raw bytes therefore silently
fails on half the files. Load normalises to \n, save restores whatever the file
had.
"""


def load(path):
    raw = open(path, "rb").read()
    crlf = b"\r\n" in raw
    return raw.decode("utf-8").replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    if crlf:
        text = text.replace("\n", "\r\n")
    open(path, "wb").write(text.encode("utf-8"))


def sub(s, a, b, n=1):
    assert s.count(a) == n, (repr(a[:70]), s.count(a))
    return s.replace(a, b)
