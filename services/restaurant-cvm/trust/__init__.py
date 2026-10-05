"""Trust ring gate for the restaurant CVM — LSAG verifier + pinned set + policy.

This package ports the fleet's tested Liu–Wong LSAG over secp256k1 (do not
redesign it, do not write new crypto). The frozen entry point S4a calls is
``trust.gate.verify_order_proof``.
"""
from .gate import verify_order_proof  # noqa: F401

__all__ = ["verify_order_proof"]
