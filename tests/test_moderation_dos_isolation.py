import boa
import pytest

CANDLE_PRICE = 10**15
CREATION_FEE = 10**14


@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def alice():
    addr = boa.env.generate_address("alice")
    boa.env.set_balance(addr, 10**19)
    return addr


@pytest.fixture
def bob():
    addr = boa.env.generate_address("bob")
    boa.env.set_balance(addr, 10**19)
    return addr


@pytest.fixture
def broken_module():
    return boa.load("src/MaliciousModerationModule.vy")


@pytest.fixture
def core(owner, broken_module):
    with boa.env.prank(owner):
        return boa.load(
            "src/MemoryChainCore.vy",
            broken_module.address,
            CANDLE_PRICE,
            CREATION_FEE,
        )


def test_moderation_crash_does_not_break_economics(core, alice, bob):
    print("\n" + "=" * 70)
    print(" 🧪 REGRESSION: Изоляция экономики при падении ModerationModule")
    print("=" * 70)

    # 1. Регрессия бага с ID=0: view-метод мирно возвращает False
    print("[1] Проверка вызова is_memorial_flagged(0)...")
    assert core.is_memorial_flagged(0) is False
    print("    [✓] Guard сработал: вернул False без падения транзакции.")

    # 2. Alice создает публичный мемориал (is_hidden = False)
    with boa.env.prank(alice):
        core.create_memorial("Rex", "hash-rex", True, value=CREATION_FEE)
    mem_id = 1
    print("\n[2] Публичный мемориал #1 создан (is_hidden = False).")

    # Добавляем второго пользователя, чтобы total_memorial_owners стал равен 2
    # и staticcall гарантированно вышел за пределы probe-параметров (0, 1)
    with boa.env.prank(bob):
        core.create_memorial("Buddy", "hash-buddy", True, value=CREATION_FEE)

    # 3. Теперь is_memorial_visible обязан совершить staticcall и упасть
    print("\n[3] Проверка отказа функции чтения галереи (is_memorial_visible)...")
    with boa.reverts("CRASH: Malicious DoS Triggered"):
        core.is_memorial_visible(mem_id)
    print("    [✓] Ожидаемый DoS подтвержден: внешний модуль заблокировал чтение галереи.")

    # 4. Инвариант: финансовые функции продолжают работать
    print("\n[4] Проверка жизнеспособности экономических функций ядра...")

    with boa.env.prank(bob):
        core.light_candle(mem_id, 2, value=CANDLE_PRICE * 3)
    assert core.total_candles_lit(mem_id) == 1
    print("    [✓] light_candle успешно выполнен (Tier 2 оплачен, свеча горит)")

    with boa.env.prank(bob):
        core.donate_and_light(mem_id, value=10**16)
    assert core.total_candles_lit(mem_id) == 2
    print("    [✓] donate_and_light успешно выполнен (донат принят)")

    print("\n" + "=" * 70)
    print(" ✅ ИНВАРИАНТ СОБЛЮДЕН: Финансовый контур полностью изолирован от сбоев модуля!")
    print("=" * 70 + "\n")


def test_view_functions_zero_id_graceful_handling(core):
    print("\n" + "=" * 70)
    print(" 🛡️  ТЕСТ: Graceful handling view-функций при пустом стейте и нулевом ID")
    print("=" * 70)

    assert core.memorial_count() == 0
    assert core.total_memorial_owners() == 0

    assert core.is_memorial_visible(0) is False
    assert core.is_memorial_hidden(0) is False
    assert core.is_memorial_flagged(0) is False

    assert core.is_memorial_visible(999) is False
    assert core.is_memorial_hidden(999) is False
    assert core.is_memorial_flagged(999) is False

    print("[✓] Все view-функции корректно возвращают False для невалидных ID.")
    print("=" * 70 + "\n")