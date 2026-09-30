"""
conftest_core.py — Shared fixtures for MemoryChainCore & ModerationModule tests.
"""
import boa
import pytest


CANDLE_PRICE = 1_000_000_000_000_000  # 0.001 ETH (within MIN/MAX bounds)
CREATION_FEE = 2_000_000_000_000_000  # 0.002 ETH (within MIN/MAX bounds)


@pytest.fixture
def owner():
    """Contract deployer / owner address."""
    return boa.env.generate_address()


@pytest.fixture
def alice():
    """Regular user address."""
    return boa.env.generate_address()


@pytest.fixture
def bob():
    """Another regular user address."""
    return boa.env.generate_address()


@pytest.fixture
def moderation_module(owner):
    """Deploy ModerationModule."""
    from src import ModerationModule

    with boa.env.prank(owner):
        mod = ModerationModule.deploy()
    return mod


@pytest.fixture
def core(owner, moderation_module):
    """Deploy MemoryChainCore with ModerationModule."""
    from src import MemoryChainCore

    with boa.env.prank(owner):
        contract = MemoryChainCore.deploy(
            moderation_module.address,
            CANDLE_PRICE,
            CREATION_FEE,
        )
    return contract
