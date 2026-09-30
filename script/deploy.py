"""
script/deploy.py — Production-grade deployment script for Base L2.
Executes pre-flight bytecode verification, contract deployment,
smoke tests, and initiates 2-step ownership transfer to Gnosis Safe.
"""
import boa
from moccasin.config import get_active_network
from src import ModerationModule, MemoryChainCore

# Начальные экономические параметры (Base L2)
INITIAL_CANDLE_PRICE = 100_000_000_000_000  # 0.0001 ETH
INITIAL_CREATION_FEE = 100_000_000_000_000  # 0.0001 ETH


def verify_target_contract(target_address: str, label: str):
    """Категория 4: Защита от передачи прав или связывания с пустым адресом."""
    code = boa.env.get_code(str(target_address))
    assert len(code) > 0, (
        f"FATAL: {label} по адресу {target_address} не имеет байткода в текущей сети!"
    )
    print(f"[✓] Pre-flight: {label} подтверждён ({len(code)} байт)")


def deploy():
    network = get_active_network()
    deployer = network.get_default_account()

    print(f"\n[*] Старт развертывания MemoryChain в сети: {network.name} (Chain ID: {network.chain_id})")
    print(f"[*] Аккаунт деплойера: {deployer.address}")

    if network.name == "pyevm" or network.chain_id is None:
        safe_multisig = boa.loads(
            "@external\n@payable\ndef __default__():\n    pass"
        ).address
        print("\n[1/4] Локальный деплой ModerationModule...")
        mod_module_address = ModerationModule.deploy().address
    else:
        # Наш подтверждённый Safe в Base Sepolia
        safe_multisig = "0x7D29Ae44D5041b59012e784818446088774305F5"
        # Наш уже задеплоенный ModerationModule
        mod_module_address = "0x7120f05831bab3742b58a0a17e7a9b64789f30f3"

    # 1. Pre-flight аудит Safe и Модуля модерации
    verify_target_contract(safe_multisig, "Совет Хранителей (Safe Multisig)")
    verify_target_contract(mod_module_address, "Модуль модерации (ModerationModule)")

    # 2. Деплой Ядра с передачей адреса модуля
    print(f"\n[2/4] Развертывание MemoryChainCore (связка с {mod_module_address})...")
    core = MemoryChainCore.deploy(
        mod_module_address,
        INITIAL_CANDLE_PRICE,
        INITIAL_CREATION_FEE,
    )
    print(f"[✓] MemoryChainCore развернут: {core.address}")

    # 3. Post-deploy Smoke Checks (Категория 3: Инварианты состояния)
    print("\n[3/4] Проверка корректности инициализации состояния...")
    assert core.moderation_module() == mod_module_address, "Линковка модуля нарушена!"
    assert core.candle_price() == INITIAL_CANDLE_PRICE, "Неверная цена свечи!"
    assert core.creation_fee() == INITIAL_CREATION_FEE, "Неверная комиссия создания!"
    assert core.owner() == deployer.address, "Деплойер не является владельцем!"
    assert core.treasury() == deployer.address, "Казна не инициализирована на деплойера!"
    print("[✓] Все smoke-проверки успешно пройдены")

    # 4. Инициализация передачи управления мультисигу (Категория 1 & 6)
    print(f"\n[4/4] Инициирование передачи прав на Safe: {safe_multisig}...")
    core.propose_owner(safe_multisig)
    assert core.pending_owner() == safe_multisig, "pending_owner не зафиксирован!"
    print(f"[✓] Шаг 1 завершен: Safe назначен как pending_owner.")
    print(f"[*] СЛЕДУЮЩИЙ ШАГ: Совет Хранителей должен вызвать accept_ownership() и set_treasury().")

    return core


def moccasin_main():
    return deploy()