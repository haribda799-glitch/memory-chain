import boa
import pytest

CANDLE_PRICE = 10**15       # 0.001 ETH
CREATION_FEE = 10**14       # 0.0001 ETH
PET_NAME = "Rex"
ARWEAVE_URI = "arweave-hash-001"


# ──────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────

@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def treasury_safe():
    # Имитирует адрес Multisig Safe (Совет Хранителей) или будущий Splitter
    addr = boa.env.generate_address("treasury_safe")
    boa.env.set_balance(addr, 0)
    return addr


@pytest.fixture
def attacker():
    addr = boa.env.generate_address("attacker")
    boa.env.set_balance(addr, 10**18)
    return addr


@pytest.fixture
def alice():
    addr = boa.env.generate_address("alice")
    boa.env.set_balance(addr, 10**19)
    return addr


@pytest.fixture
def moderation_module():
    return boa.load("src/ModerationModule.vy")


@pytest.fixture
def core(owner, moderation_module):
    with boa.env.prank(owner):
        return boa.load(
            "src/MemoryChainCore.vy",
            moderation_module.address,
            CANDLE_PRICE,
            CREATION_FEE,
        )


# ──────────────────────────────────────────────────────────────
# 1. Access Control & Input Validation: set_treasury
# ──────────────────────────────────────────────────────────────

def test_set_treasury_access_control_and_validation(core, owner, attacker, treasury_safe):
    print("\n" + "=" * 70)
    print(" 🛡️  ТЕСТ 1: Access Control и валидация границ set_treasury")
    print("=" * 70)

    # Инвариант развертывания: по умолчанию treasury == deployer (owner)
    initial_treasury = core.treasury()
    print(f"[*] Начальный адрес казны (deployer): {initial_treasury}")
    assert initial_treasury == owner

    # 1. Атака непривилегированного адреса (Категория 1)
    print("\n[1] Попытка не-owner изменить адрес казны на свой...")
    with boa.env.prank(attacker):
        with boa.reverts("Not owner"):
            core.set_treasury(attacker)
    assert core.treasury() == owner
    print("    [✓] REVERT: Атака отклонена, только owner имеет доступ.")

    # 2. Передача нулевого адреса (Категория 7)
    print("\n[2] Попытка передать address(0)...")
    with boa.env.prank(owner):
        with boa.reverts("Invalid treasury address"):
            core.set_treasury("0x0000000000000000000000000000000000000000")
    print("    [✓] REVERT: Защита от нулевого адреса сработала.")

    # 3. Попытка установить тот же самый адрес повторно (Категория 7)
    print("\n[3] Попытка повторной установки текущего адреса...")
    with boa.env.prank(owner):
        with boa.reverts("Already set to this address"):
            core.set_treasury(owner)
    print("    [✓] REVERT: Избыточный вызов отклонен.")

    # 4. Легитимное обновление на адрес Safe
    print(f"\n[4] Установка легитимного адреса казны: {treasury_safe}...")
    with boa.env.prank(owner):
        core.set_treasury(treasury_safe)

    assert core.treasury() == treasury_safe
    print("    [✓] Казна успешно переключена на отдельный адрес Safe!")
    print("=" * 70)


# ──────────────────────────────────────────────────────────────
# 2. Изоляция потока средств: withdraw() отправляет ETH на treasury, а не на owner
# ──────────────────────────────────────────────────────────────

def test_withdraw_routes_funds_to_treasury_not_owner(core, owner, alice, attacker, treasury_safe):
    print("\n" + "=" * 70)
    print(" 💰 ТЕСТ 2: Изоляция потока средств при выводе (Role Separation)")
    print("=" * 70)

    # Устанавливаем отдельный адрес казны
    with boa.env.prank(owner):
        core.set_treasury(treasury_safe)

    # 1. Пользователь Alice генерирует выручку протокола
    donation_amount = 2 * 10**18  # 2 ETH
    with boa.env.prank(alice):
        core.create_memorial(PET_NAME, ARWEAVE_URI, True, value=CREATION_FEE)
        core.donate_and_light(1, value=donation_amount)

    contract_bal = boa.env.get_balance(core.address)
    expected_pool = CREATION_FEE + donation_amount
    assert contract_bal == expected_pool
    print(f"[*] Баланс контракта после действий Alice: {contract_bal / 1e18:.4f} ETH")

    # 2. Проверка защиты withdraw: attacker не может вызвать
    print("\n[1] Попытка не-owner вызвать withdraw()...")
    with boa.env.prank(attacker):
        with boa.reverts("Not owner"):
            core.withdraw()
    print("    [✓] REVERT: Доступ к функции вывода закрыт для посторонних.")

    # 3. Фиксация балансов перед выводом
    owner_bal_before = boa.env.get_balance(owner)
    treasury_bal_before = boa.env.get_balance(treasury_safe)
    assert treasury_bal_before == 0

    # 4. Owner инициирует вывод средств
    print(f"\n[2] Owner инициирует withdraw()...")
    with boa.env.prank(owner):
        core.withdraw()

    # 5. Проверка инвариантов распределения средств (Категория 3)
    owner_bal_after = boa.env.get_balance(owner)
    treasury_bal_after = boa.env.get_balance(treasury_safe)
    contract_bal_after = boa.env.get_balance(core.address)

    print(f"    └── Баланс контракта после вывода: {contract_bal_after} wei")
    print(f"    └── Баланс owner (Governance):     {owner_bal_after / 1e18:.4f} ETH (дельта: {owner_bal_after - owner_bal_before})")
    print(f"    └── Баланс treasury (Safe/Vault):  {treasury_bal_after / 1e18:.4f} ETH (дельта: +{treasury_bal_after / 1e18:.4f} ETH)")

    # Контракт полностью опустошен
    assert contract_bal_after == 0, "Контракт обязан обнулиться"

    # Баланс owner не увеличился ни на 1 wei (защита от присвоения)
    assert owner_bal_after == owner_bal_before, "Owner не должен получать средства при разделении ролей!"

    # Ровно 100% средств ушло в treasury
    assert treasury_bal_after == contract_bal, "Казна обязана получить 100% баланса"

    print("\n[✓] ИНВАРИАНТ СОБЛЮДЕН: Средства направлены строго в казну без участия кошелька администратора.")
    print("=" * 70)


# ──────────────────────────────────────────────────────────────
# 3. Граничный случай: withdraw при пустом балансе
# ──────────────────────────────────────────────────────────────

def test_withdraw_empty_balance_reverts(core, owner):
    print("\n" + "=" * 70)
    print(" 🛑 ТЕСТ 3: Проверка вывода при нулевом балансе")
    print("=" * 70)

    assert boa.env.get_balance(core.address) == 0

    with boa.env.prank(owner):
        with boa.reverts("No balance"):
            core.withdraw()

    print("[✓] REVERT: Транзакция отклонена с 'No balance'. Холостой расход газа предотвращен.")
    print("=" * 70 + "\n")