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


def test_ceil_division_prevents_truncation_bias(mod_module):
    print("\n" + "=" * 70)
    print(" 🧮 ТЕСТ 1: Проверка устранения смещения порога через ceil division")
    print("=" * 70)

    total_users = 29
    # Ceil division: (29 * 20 + 99) // 100 = 6
    # При весе 5 (17.24% < 20.00%) объект НЕ должен быть скрыт
    weight_5 = 5
    is_hidden_5 = mod_module.is_hidden(weight_5, total_users)
    print(f"[*] Число пользователей: {total_users}")
    print(f"[*] Вес жалоб:           {weight_5} (17.24%)")
    print(f"[*] Результат is_hidden: {is_hidden_5}")
    assert is_hidden_5 is False, "При весе 17.24% объект не должен скрываться!"

    # При весе 6 (20.69% >= 20.00%) объект скрывается
    weight_6 = 6
    is_hidden_6 = mod_module.is_hidden(weight_6, total_users)
    print(f"[*] Вес жалоб:           {weight_6} (20.69%)")
    print(f"[*] Результат is_hidden: {is_hidden_6}")
    assert is_hidden_6 is True, "При весе >= 20% объект обязан быть скрыт!"
    print("    [✓] ЗАЩИТА ПОДТВЕРЖДЕНА: Ceil division устранил truncation bias!")
    print("=" * 70)


def test_cold_start_quorum_prevents_early_censorship(core, victim, sybils):
    print("\n" + "=" * 70)
    print(" 🛡️ ТЕСТ 2: Защита от Sybil-цензуры на раннем этапе (Cold Start Quorum)")
    print("=" * 70)

    # 1. Жертва создает публичный мемориал
    with boa.env.prank(victim):
        core.create_memorial("VictimPet", "arweave-hash-victim", True, value=CREATION_FEE)
    target_id = 1

    assert core.is_memorial_visible(target_id) is True
    print("[*] Мемориал жертвы создан и виден в публичной галерее.")

    # 2. Атакующий создает 5 мемориалов и сразу репортит жертву (вес 1 на аккаунт)
    total_spent = 0
    for idx, s in enumerate(sybils):
        with boa.env.prank(s):
            core.create_memorial(f"Spam_{idx}", f"hash_{idx}", True, value=CREATION_FEE)
            total_spent += CREATION_FEE
            core.report_memorial(target_id)

    print(f"[*] Затраты атакующего:           {total_spent} wei ({total_spent / 1e18:.6f} ETH)")
    print(f"[*] Итоговый вес репортов:        {core.report_weight(target_id)}")
    print(f"[*] Всего владельцев в системе:   {core.total_memorial_owners()}")

    # 3. До достижения кворума (MIN_COMMUNITY_QUORUM = 20) мемориал НЕ скрывается
    is_visible = core.is_memorial_visible(target_id)
    is_hidden_ratchet = core.memorials(target_id).is_hidden

    print(f"[*] Статус is_hidden в хранилище: {is_hidden_ratchet}")
    print(f"[*] Видимость в галерее:          {is_visible}")

    assert is_hidden_ratchet is False, "Мемориал НЕ должен быть скрыт до достижения кворума 20 пользователей!"
    assert is_visible is True, "Мемориал должен оставаться видимым в галерее!"
    print("\n    [✓] ЗАЩИТА ПОДТВЕРЖДЕНА: Атака 5 аккаунтов на ранней стадии отражена кворумом!")
    print("=" * 70 + "\n")