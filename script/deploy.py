"""
script/deploy.py — Production-grade deployment script for Base L2 (Mainnet 8453 & Sepolia 84532).
Executes pre-flight bytecode verification, contract deployment, smoke tests,
sets Treasury to the Council Safe Multisig, and initiates 2-step ownership transfer to Safe.
"""
import os
import time
import boa
from moccasin.config import get_active_network
from src import ModerationModule, MemoryChainCore

# Начальные экономические параметры (Base L2)
INITIAL_CANDLE_PRICE = 100_000_000_000_000  # 0.0001 ETH
INITIAL_CREATION_FEE = 100_000_000_000_000  # 0.0001 ETH

EXPECTED_DEPLOYER_ADDRESS = "0x8395183D4188946c63199E01b9bDA19D774937C8"
MAINNET_SAFE_MULTISIG = "0x4C28A82cAafdaD1B8AfbC9d7aBF3a411fE2a768c"
SEPOLIA_SAFE_MULTISIG = "0x7D29Ae44D5041b59012e784818446088774305F5"
DEFAULT_SAFE_MULTISIG = MAINNET_SAFE_MULTISIG
SEPOLIA_MODERATION_MODULE = "0x7120f05831bab3742b58a0a17e7a9b64789f30f3"


def verify_target_contract(target_address: str, label: str):
    """Категория 4: Защита от передачи прав или связывания с пустым адресом."""
    code = b""
    for attempt in range(5):
        code = boa.env.get_code(str(target_address))
        if len(code) > 0:
            break
        if attempt < 4:
            time.sleep(2)
    assert len(code) > 0, (
        f"FATAL: {label} по адресу {target_address} не имеет байткода в текущей сети!"
    )
    print(f"[✓] Pre-flight: {label} подтверждён ({len(code)} байт)")


def _exec_live_safe(fn, *args, label: str = "tx"):
    """Выполняет транзакцию с перехватом лага синхронизации _reset_fork публичной RPC-ноды."""
    try:
        return fn(*args)
    except TypeError as e:
        if "'NoneType' object is not subscriptable" in str(e):
            print(f"[!] Внимание ({label}): Boa столкнулся с задержкой RPC-ноды при обновлении форка.")
            print("[*] Транзакция была отправлена в сеть. Ожидаем синхронизацию (3 сек)...")
            time.sleep(3)
            return None
        raise e


def deploy():
    network = get_active_network()
    deployer = network.get_default_account()

    print(f"\n[*] Старт развертывания MemoryChain в сети: {network.name} (Chain ID: {network.chain_id})")
    print(f"[*] Аккаунт деплойера: {deployer.address}")

    if network.name == "pyevm" or network.chain_id is None:
        safe_multisig = boa.loads(
            "@external\n@payable\ndef __default__():\n    pass"
        ).address
        print("\n[1/5] Локальный деплой ModerationModule...")
        mod_module_address = ModerationModule.deploy().address
    elif network.chain_id == 8453 or network.name == "base":
        # Base Mainnet (Chain ID: 8453)
        if deployer.address.lower() != EXPECTED_DEPLOYER_ADDRESS.lower():
            print(
                f"[!] Внимание: активный деплойер ({deployer.address}) отличается от "
                f"ожидаемого ({EXPECTED_DEPLOYER_ADDRESS})."
            )
        safe_multisig = os.getenv("SAFE_MULTISIG_ADDRESS", MAINNET_SAFE_MULTISIG).strip()
        mod_module_address = os.getenv("MODERATION_MODULE_ADDRESS", "").strip()
        if not mod_module_address or len(boa.env.get_code(str(mod_module_address))) == 0:
            print("\n[1/5] Деплой ModerationModule в Base Mainnet (8453)...")
            mod_module_address = ModerationModule.deploy().address
            print(f"[✓] ModerationModule развернут в Base Mainnet: {mod_module_address}")
    else:
        # Base Sepolia (Chain ID: 84532)
        safe_multisig = os.getenv("SAFE_MULTISIG_ADDRESS", SEPOLIA_SAFE_MULTISIG).strip()
        mod_module_address = os.getenv("MODERATION_MODULE_ADDRESS", SEPOLIA_MODERATION_MODULE).strip()
        if len(boa.env.get_code(str(mod_module_address))) == 0:
            print("\n[1/5] Деплой ModerationModule в Base Sepolia...")
            mod_module_address = ModerationModule.deploy().address
            print(f"[✓] ModerationModule развернут: {mod_module_address}")

    # 1. Pre-flight аудит Safe и Модуля модерации
    verify_target_contract(safe_multisig, "Совет Хранителей (Safe Multisig)")
    verify_target_contract(mod_module_address, "Модуль модерации (ModerationModule)")

    # 2. Деплой Ядра с передачей адреса модуля
    print(f"\n[2/5] Развертывание MemoryChainCore (связка с {mod_module_address})...")
    core = MemoryChainCore.deploy(
        mod_module_address,
        INITIAL_CANDLE_PRICE,
        INITIAL_CREATION_FEE,
    )
    print(f"[✓] MemoryChainCore развернут: {core.address}")

    # 3. Post-deploy Smoke Checks (Категория 3: Инварианты состояния)
    print("\n[3/5] Проверка корректности инициализации состояния...")
    assert core.moderation_module().lower() == mod_module_address.lower(), "Линковка модуля нарушена!"
    assert core.candle_price() == INITIAL_CANDLE_PRICE, "Неверная цена свечи!"
    assert core.creation_fee() == INITIAL_CREATION_FEE, "Неверная комиссия создания!"
    assert core.owner().lower() == deployer.address.lower(), "Деплойер не является владельцем!"
    assert core.treasury().lower() == deployer.address.lower(), "Казна не инициализирована на деплойера!"
    print("[✓] Все smoke-проверки успешно пройдены")

    # 4. Передача Казны (Treasury) на адрес Safe Multisig
    print(f"\n[4/5] Установка адреса Казны (Treasury) на Safe: {safe_multisig}...")
    _exec_live_safe(core.set_treasury, safe_multisig, label="set_treasury")
    assert core.treasury().lower() == safe_multisig.lower(), "Казна не переведена на Safe!"
    print(f"[✓] Казна (treasury) успешно переведена на Safe: {core.treasury()}")

    # 5. Инициализация передачи прав владения (Owner) мультисигу (2-Step Ownership Transfer)
    print(f"\n[5/5] Инициирование передачи прав владения (propose_owner) на Safe: {safe_multisig}...")
    _exec_live_safe(core.propose_owner, safe_multisig, label="propose_owner")
    assert core.pending_owner().lower() == safe_multisig.lower(), "pending_owner не зафиксирован!"
    print(f"[✓] Safe назначен как pending_owner: {core.pending_owner()}")

    print("\n" + "=" * 72)
    print("  MEMORY CHAIN — ИТОГОВАЯ СВОДКА РАЗВЕРТЫВАНИЯ")
    print("=" * 72)
    print(f"  Сеть (Network):          {network.name} (Chain ID: {network.chain_id})")
    print(f"  Деплойер (EOA):          {deployer.address}")
    print(f"  ModerationModule:        {mod_module_address}")
    print(f"  MemoryChainCore:         {core.address}")
    print(f"  Казна (Treasury):        {core.treasury()} (АКТИВНА — Safe)")
    print(f"  Текущий Owner:           {core.owner()}")
    print(f"  Ожидающий Owner (Safe):  {core.pending_owner()}")
    print("-" * 72)
    print("  Конфигурация для frontend/.env:")
    print("  VITE_NETWORK=mainnet")
    print(f"  VITE_CONTRACT_ADDRESS={core.address}")
    print(f"  VITE_MODERATION_MODULE_ADDRESS={mod_module_address}")
    print("  VITE_COUNCIL_SAFE_ADDRESS=" + safe_multisig)
    print("-" * 72)
    print("  Примечание: Казна (treasury) УЖЕ переведена на Safe Multisig.")
    print("  Для завершения приёмки прав администратора Совет Хранителей (Safe)")
    print("  вызывает функцию accept_ownership() на контракте MemoryChainCore.")
    print("=" * 72 + "\n")

    return core


def moccasin_main():
    return deploy()
