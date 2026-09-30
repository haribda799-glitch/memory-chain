import boa
import pytest

CANDLE_PRICE = 10**15
CREATION_FEE = 10**14

TIMELOCK_DELAY = 172800        # 48 часов
TIMELOCK_GRACE_PERIOD = 604800 # 7 дней


@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def initial_module():
    return boa.load("src/ModerationModule.vy")


@pytest.fixture
def new_module():
    return boa.load("src/ModerationModule.vy")


@pytest.fixture
def core(owner, initial_module):
    with boa.env.prank(owner):
        return boa.load(
            "src/MemoryChainCore.vy",
            initial_module.address,
            CANDLE_PRICE,
            CREATION_FEE,
        )


def test_timelock_lifecycle_three_phase_invariants(core, owner, new_module):
    print("\n" + "=" * 72)
    print(" 🛡️  REGRESSION: Проверка трехфазного окна исполнения Timelock")
    print("=" * 72)

    # 1. Создаем предложение
    with boa.env.prank(owner):
        core.propose_moderation_module(new_module.address)

    ready_at = core.moderation_module_timelock()
    print(f"[*] Предложение зарегистрировано. Разблокировка: ts={ready_at}")

    # ── ФАЗА 1: Попытка применить раньше 48 часов ──
    print("\n[1] Проверка вызова до истечения 48 часов...")
    with boa.env.prank(owner):
        with boa.reverts("Timelock not expired"):
            core.apply_moderation_module()
    print("    [✓] REVERT: Сработал заслон 'Timelock not expired'")

    # Перематываемся ровно в момент наступления окна исполнения
    boa.env.time_travel(seconds=TIMELOCK_DELAY)
    print(f"\n[2] Время перемотано на +48ч. Текущий ts={boa.env.timestamp}")

    # ── ФАЗА 3: Проверка протухания (перематываемся за пределы Grace Period) ──
    # Перематываем еще на Grace Period + 1 секунду
    boa.env.time_travel(seconds=TIMELOCK_GRACE_PERIOD + 1)
    expired_ts = boa.env.timestamp
    print(f"[*] Перемотка за пределы Grace Period (+7 дней + 1с). Текущий ts={expired_ts}")

    print("\n[3] Попытка применить протухшее предложение...")
    with boa.env.prank(owner):
        with boa.reverts("Proposal expired"):
            core.apply_moderation_module()
    print("    [✓] REVERT: Сработал заслон 'Proposal expired'. Атака 6 месяцев закрыта!")

    # ── ФАЗА 2: Проверка успешного применения внутри Grace Window ──
    # Отменяем или перезаписываем предложение, чтобы протестировать валидный сценарий
    print("\n[4] Создание свежего предложения и проверка валидного окна...")
    with boa.env.prank(owner):
        core.propose_moderation_module(new_module.address)

    # Перематываемся на 48ч + 1 час (строго внутри Grace Period)
    boa.env.time_travel(seconds=TIMELOCK_DELAY + 3600)

    with boa.env.prank(owner):
        core.apply_moderation_module()

    assert core.moderation_module() == new_module.address
    assert core.proposed_moderation_module() == "0x0000000000000000000000000000000000000000"
    assert core.moderation_module_timelock() == 0
    print("    [✓] Модуль успешно применен внутри валидного окна исполнения!")
    print("=" * 72 + "\n")