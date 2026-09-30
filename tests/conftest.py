import pytest
import boa

@pytest.fixture
def owner():
    """Contract deployer / owner address (acts as multisig in tests)."""
    return boa.env.generate_address()

@pytest.fixture
def alice():
    """Regular user address funded with 10 ETH."""
    addr = boa.env.generate_address()
    boa.env.set_balance(addr, 10 * 10**18)
    return addr

@pytest.fixture
def bob():
    """Another regular user address funded with 10 ETH."""
    addr = boa.env.generate_address()
    boa.env.set_balance(addr, 10 * 10**18)
    return addr

@pytest.fixture
def users():
    """Multiple users for moderation testing."""
    return [boa.env.generate_address() for _ in range(10)]

@pytest.fixture
def moderation_module(owner):
    """Deploy ModerationModule."""
    import src.ModerationModule as ModerationModule
    with boa.env.prank(owner):
        contract = ModerationModule.deploy()
    return contract

@pytest.fixture
def core(owner, moderation_module):
    """Deploy MemoryChainCore contract as owner."""
    import src.MemoryChainCore as MemoryChainCore
    initial_price = 100_000_000_000_000  # 0.0001 ETH
    initial_creation_fee = 2_000_000_000_000_000  # 0.002 ETH
    with boa.env.prank(owner):
        contract = MemoryChainCore.deploy(moderation_module.address, initial_price, initial_creation_fee)
    return contract

# Sample test data
SAMPLE_PET_NAME = "Buddy"
SAMPLE_ARWEAVE_TX = "dE0rmDfl9_OWjkDznNEXHaSO_JohJkRolvMzaCroUdw"
SAMPLE_PET_NAME_2 = "Whiskers"
SAMPLE_ARWEAVE_TX_2 = "xYz123AbCdEfGhIjKlMnOpQrStUvWxYz0123456789A"
