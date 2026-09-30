import boa
import pytest

CREATION_FEE = 100_000_000_000_000
CANDLE_PRICE = 100_000_000_000_000


@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def user():
    addr = boa.env.generate_address("user")
    boa.env.set_balance(addr, 10**18)
    return addr


@pytest.fixture
def broken_treasury():
    # Контракт, симулирующий сломанный Safe с бесконечным циклом / OOG
    source = """
@external
@payable
def __default__():
    raise "Safe hook failed: out of gas"
"""
    return boa.loads(source)


@pytest.fixture
def rescue_treasury():
    return boa.env.generate_address("rescue_treasury")


@pytest.fixture
def mod_module():
    return boa.load("src/ModerationModule.vy")


@pytest.fixture
def core(owner, mod_module):
    with boa.env.prank(owner):
        return boa.load(
            "src/MemoryChainCore.vy",
            mod_module.address,
            CANDLE_PRICE,
            CREATION_FEE,
        )

def test_broken_treasury_dos_and_recovery(core, owner, user, broken_treasury, rescue_treasury):
    # 1. Назначаем сломанную казну
    with boa.env.prank(owner):
        core.set_treasury(broken_treasury.address)

    # 2. Пользователь создает мемориал, пополняя баланс контракта
    with boa.env.prank(user):
        core.create_memorial("Rex", "arweave_hash", True, value=CREATION_FEE)

    # Исправлено: запрашиваем баланс адреса через окружение boa
    assert boa.env.get_balance(core.address) == CREATION_FEE

    # 3. Попытка вывода на сломанную казну должна ревертиться (DoS)
    with boa.env.prank(owner):
        with boa.reverts("Safe hook failed: out of gas"):
            core.withdraw()

    # Баланс ядра остался нетронутым
    assert boa.env.get_balance(core.address) == CREATION_FEE

    # 4. Спасение: Owner переключает казну на рабочий адрес и выводит средства
    with boa.env.prank(owner):
        core.set_treasury(rescue_treasury)
        core.withdraw()

    assert boa.env.get_balance(core.address) == 0
    assert boa.env.get_balance(rescue_treasury) == CREATION_FEE