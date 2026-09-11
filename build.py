"""Vercel build hook for the dlib-based face-recognition package.

The local launcher installs face-recognition after dlib-bin because the normal
package dependency would otherwise trigger a native dlib source build. Vercel
imports app.py directly, so it needs the same installation before bundling the
Flask function.
"""

from __future__ import annotations

import subprocess
import sys


subprocess.check_call(
    [sys.executable, "-m", "pip", "install", "--no-deps", "face-recognition==1.3.0"]
)
