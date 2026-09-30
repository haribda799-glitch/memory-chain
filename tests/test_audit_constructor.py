import boa

# Границы комиссии из MemoryChainCore.vy
MIN_CREATION_FEE = 100_000_000_000_000
MAX_CREATION_FEE = 10_000_000_000_000_000

def test_constructor_fee_below_min():
    mod = boa.load("src/ModerationModule.vy")
    invalid_fee = MIN_CREATION_FEE - 1
    valid_price = 100_000_000_000_000

    with boa.reverts("Fee below minimum"):
        boa.load("src/MemoryChainCore.vy", mod.address, valid_price, invalid_fee)

def test_constructor_fee_below_max():
    mod = boa.load("src/ModerationModule.vy")
    invalid_fee = MAX_CREATION_FEE + 1
    valid_price = 100_000_000_000_000

    with boa.reverts("Fee above maximum"):
        boa.load("src/MemoryChainCore.vy", mod.address, valid_price, invalid_fee)
