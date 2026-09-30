import boa
import pytest

CANDLE_PRICE = 10**15
CREATION_FEE = 10**14


@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def victim():
    addr = boa.env.generate_address("victim")
    boa.env.set_balance(addr, 10**18)
    return addr


@pytest.fixture
def sybils():
    # 5 атакующих аккаунтов
    addrs = [boa.env.generate_address(f"sybil_{i}") for i in range(5)]
    for a in addrs:
        boa.env.set_balance(a, 10**18)
    return addrs


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


def test_ceil_division_enforces_strict_percentage_barrier(mod_module):
    print("\n" + "=" * 72)
    print(" 🛡️  REGRESSION 1: Проверка устранения Truncation Bias (Ceil Division)")
    print("=" * 72)

    total_users = 29
    # 20% от 29 = 5.8.
    # Ceil division: (29 * 20 + 99) // 100 = 679 // 100 = 6.
    weight_5 = 5
    weight_6 = 6

    # Вес 5 (17.24%) больше НЕ должен скрывать объект
    is_hidden_5 = mod_module.is_hidden(weight_5, total_users)
    print(f"[*] База пользователей: {total_users}")
    print(f"[*] Вес 5 (17.24%): is_hidden = {is_hidden_5} (Ожидаем False)")
    assert is_hidden_5 is False, "Вес 5 не должен пробивать 20% барьер при ceil-делении!"

    # Вес 6 (20.68%) обязан скрывать объект
    is_hidden_6 = mod_module.is_hidden(weight_6, total_users)
    print(f"[*] Вес 6 (20.68%): is_hidden = {is_hidden_6} (Ожидаем True)")
    assert is_hidden_6 is True

    print("    [✓] ИНВАРИАНТ СОБЛЮДЕН: Занижение порога полностью ликвидировано.")
    print("=" * 72)


def test_cold_start_quorum_blocks_cheap_sybil_censorship(core, victim, sybils):
    print("\n" + "=" * 72)
    print(" 🛡️  REGRESSION 2: Защита от цензуры на раннем этапе (Cold Start Quorum)")
    print("=" * 72)

    # 1. Жертва создает мемориал
    with boa.env.prank(victim):
        core.create_memorial("Rex", "hash-rex", True, value=CREATION_FEE)
    target_id = 1

    # 2. Атакующий запускает 5 сибил-аккаунтов с репортами
    for idx, s in enumerate(sybils):
        with boa.env.prank(s):
            core.create_memorial(f"Spam_{idx}", f"hash_{idx}", True, value=CREATION_FEE)
            core.report_memorial(target_id)

    total_owners = core.total_memorial_owners()
    accumulated_weight = core.report_weight(target_id)

    print(f"[*] Всего владельцев в базе:       {total_owners} (Кворум: 20)")
    print(f"[*] Вес накопленных жалоб:        {accumulated_weight}")

    # 3. Проверяем инвариант безопасности: авто-скрытие заблокировано кворумом
    is_hidden_storage = core.memorials(target_id).is_hidden
    is_visible = core.is_memorial_visible(target_id)
    is_flagged = core.is_memorial_flagged(target_id)

    print(f"[*] Статус is_hidden в хранилище: {is_hidden_storage} (Ожидаем False)")
    print(f"[*] Видимость в галерее:          {is_visible} (Ожидаем True)")
    print(f"[*] Помечен ли флагом (Совет):    {is_flagged} (Ожидаем True)")

    # Мемориал НЕ скрыт, атака за 0.0005 ETH провалилась!
    assert is_hidden_storage is False
    assert is_visible is True

    # Но Совет Хранителей оповещен через флаг
    assert is_flagged is True

    print("\n    [✓] ИНВАРИАНТ СОБЛЮДЕН: До кворума в 20 участников автоцензура невозможна!")
    print("=" * 72 + "\n")