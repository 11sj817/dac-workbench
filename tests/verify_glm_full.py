"""Compatibility entry point for the current, exemption-free GLM reference check."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name("verify_glm_reference.py")), run_name="__main__")
