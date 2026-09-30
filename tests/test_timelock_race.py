import boa
import pytest

CREATION_FEE = 100_000_000_000_000
CANDLE_PRICE = 100_000_000_000_000


@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def alice():
    addr = boa.env.generate_address("alice")
    boa.env.set_balance(addr, 10**18)
    return addr


@pytest.fixture
def standard_module():
    # Модуль со строгим порогом: 20% (минимум 5)
    return boa.load("src/ModerationModule.vy")


@pytest.fixture
def lenient_module():
    # Новый модуль со смягченным порогом: 50% (минимум 10)
    source = """
# pragma version ~=0.4.3
# pragma evm-version cancun

@external
@view
def is_hidden(report_weight: uint256, total_users: uint256) -> bool:
    if total_users == 0:
        return False
    threshold: uint256 = (total_users * 50 + 99) // 100
    if threshold < 10:
        threshold = 10
    return report_weight >= threshold

@external
@view
def is_flagged(report_weight: uint256, total_users: uint256) -> bool:
    return False
"""
    return boa.loads(source)


@pytest.fixture
def core(owner, standard_module):
    with boa.env.prank(owner):
        return boa.load(
            "src/MemoryChainCore.vy",
            standard_module.address,
            CANDLE_PRICE,
            CREATION_FEE,
        )


def test_frontrun_timelock_upgrade_prevents_ratchet(core, owner, alice, lenient_module):
    # 1. Создаем 25 пользователей для преодоления кворума
    users = [boa.env.generate_address() for _ in range(25)]
    for u in users:
        boa.env.set_balance(u, 10**18)
        with boa.env.prank(u):
            core.create_memorial("Pet", "uri", False, value=CREATION_FEE)

    # 2. Alice создает спорный мемориал
    with boa.env.prank(alice):
        core.create_memorial("Controversial", "bad_uri", True, value=CREATION_FEE)
    target_id = core.memorial_count()

    # 3. Совет предлагает мягкий модуль
    with boa.env.prank(owner):
        core.propose_moderation_module(lenient_module.address)

    # 4. Пользователи подают 5 жалоб (порог строгого модуля: 26 * 20 / 100 = 5.2 -> 6)
    for u in users[:5]:
        with boa.env.prank(u):
            core.report_memorial(target_id)

    assert core.report_weight(target_id) == 5
    assert core.memorials(target_id).is_hidden is False

    # 5. Проходит ровно 48 часов таймлока
    boa.env.time_travel(seconds=172801)

    # Ветка А: Совет успевает вызвать apply_moderation_module ДО 6-й жалобы
    with boa.env.prank(owner):
        core.apply_moderation_module()

    # Приходит 6-я жалоба, которая при старом модуле навсегда захлопнула бы храповик
    with boa.env.prank(users[5]):
        core.report_memorial(target_id)

    assert core.report_weight(target_id) == 6

    # Результат: Храповик НЕ сработал, так как порог нового модуля = max(26 * 50 / 100, 10) = 13
    assert core.memorials(target_id).is_hidden is False
    assert core.is_memorial_visible(target_id) is True