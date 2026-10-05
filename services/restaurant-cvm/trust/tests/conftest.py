"""Make the ``trust`` package importable from the test suite."""
import os
import sys

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))   # .../trust/tests
_TRUST_DIR = os.path.dirname(_TESTS_DIR)                  # .../trust
_PKG_PARENT = os.path.dirname(_TRUST_DIR)                 # .../restaurant-cvm
if _PKG_PARENT not in sys.path:
    sys.path.insert(0, _PKG_PARENT)
