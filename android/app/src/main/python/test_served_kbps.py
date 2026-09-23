"""Self-check for the quality badge's numbers.

Run it directly:  python test_served_kbps.py

The badge used to fall back to the quality SETTING, so on Auto every source
read "320 kbps". These pin the two helpers that now supply the real figure.
"""

import mobile_server as m

assert m._jiosaavn_rung("https://aac.saavncdn.com/1/abc_320.mp4?Expires=1") == 320
assert m._jiosaavn_rung("https://aac.saavncdn.com/1/abc_160.mp4") == 160
assert m._jiosaavn_rung("https://aac.saavncdn.com/1/abc.mp4") == 0

m._note_kbps("u", "youtube", 320, 129.6)
assert m._SERVED_KBPS[("youtube", "u", 320)] == 130
# Unknown stays unknown — never a made-up number.
m._note_kbps("v", "soundcloud", 320, None)
assert ("soundcloud", "v", 320) not in m._SERVED_KBPS

print("ok")
