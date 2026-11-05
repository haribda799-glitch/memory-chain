"""
script/propose_safe.py — Post-deployment verification, Treasury handover & Safe ownership proposal.
Connects to deployed MemoryChainCore, audits state variables via view calls,
sets treasury to Safe (if not already set), and executes Step 1 of 2-Step Ownership Transfer.
"""
import os
import time
from moccasin.config import get_active_network
from src import MemoryChainCore

DEFAULT_MAINNET_SAFE = "0x4C28A82cAafdaD1B8AfbC9d7aBF3a411fE2a768c"
DEFAULT_SEPOLIA_SAFE = "0x7D29Ae44D5041b59012e784818446088774305F5"
DEFAULT_SEPOLIA_CORE = "0x5de836cf6fc88d88eec93309663372ad723baf8f"
DEFAULT_SEPOLIA_MOD = "0x7120f05831bab3742b58a0a17e7a9b64789f30f3"


def _exec_live_safe(fn, *args, label: str = "tx"):
    try:
        return fn(*args)
    except TypeError as e:
        if "'NoneType' object is not subscriptable" in str(e):
            print(f"[!] Внимание ({label}): Boa столкнулся с задержкой ноды при обновлении форка.")
            print("[*] Транзакция была отправлена в сеть. Проверяем фактический результат...")
            time.sleep(3)
            return None
        raise e


def main():
    network = get_active_network()
    deployer = network.get_default_account()
    is_mainnet = network.chain_id == 8453 or network.name == "base"

    core_address = os.getenv(
        "CORE_ADDRESS",
        os.getenv("VITE_CONTRACT_ADDRESS", "" if is_mainnet else DEFAULT_SEPOLIA_CORE),
    ).strip()
    safe_address = os.getenv(
        "SAFE_MULTISIG_ADDRESS",
        DEFAULT_MAINNET_SAFE if is_mainnet else DEFAULT_SEPOLIA_SAFE,
    ).strip()
    expected_mod = os.getenv(
        "MODERATION_MODULE_ADDRESS",
        os.getenv("VITE_MODERATION_MODULE_ADDRESS", "" if is_mainnet else DEFAULT_SEPOLIA_MOD),
    ).strip()

    assert core_address, "Укажите CORE_ADDRESS или VITE_CONTRACT_ADDRESS в окружении!"

    print(f"\n[*] Сеть: {network.name} (Chain ID: {network.chain_id})")
    print(f"[*] Аккаунт деплойера: {deployer.address}")
    print(f"[*] Контракт MemoryChainCore: {core_address}")
    print(f"[*] Целевой Safe Multisig:    {safe_address}")

    # 1. Подключение к задеплоенному ядру
    core = MemoryChainCore.at(core_address)

    # 2. Аудит инвариантов инициализации
    print("\n[1/3] Проверка параметров инициализации контракта...")
    mod_module = core.moderation_module()
    owner = core.owner()
    treasury = core.treasury()
    candle_price = core.candle_price()
    creation_fee = core.creation_fee()

    print(f" - Модуль модерации: {mod_module}")
    print(f" - Владелец (Owner): {owner}")
    print(f" - Казна (Treasury): {treasury}")
    print(f" - Цена свечи:       {candle_price} wei")
    print(f" - Комиссия создания:{creation_fee} wei")

    if expected_mod:
        assert mod_module.lower() == expected_mod.lower(), "Неверный адрес модуля модерации!"
    assert owner.lower() == deployer.address.lower(), "Деплойер не является владельцем!"

    # 3. Перевод казны (Treasury) на Safe Multisig
    if treasury.lower() == safe_address.lower():
        print(f"\n[✓] Казна (Treasury) уже указывает на Safe ({safe_address}).")
    else:
        print(f"\n[2/3] Перевод Казны (set_treasury) на Safe ({safe_address})...")
        _exec_live_safe(core.set_treasury, safe_address, label="set_treasury")
        updated_treasury = core.treasury()
        print(f"[*] Текущий treasury: {updated_treasury}")
        assert updated_treasury.lower() == safe_address.lower(), "Казна не обновилась!"
        print("[✓] УСПЕХ: Казна переведена на Safe!")

    # 4. Инициирование передачи владения (2-Step Ownership Transfer)
    current_pending = core.pending_owner()
    if current_pending.lower() == safe_address.lower():
        print(f"\n[✓] Safe ({safe_address}) уже назначен в качестве pending_owner.")
        return

    print(f"\n[3/3] Назначение Safe ({safe_address}) в качестве pending_owner...")
    _exec_live_safe(core.propose_owner, safe_address, label="propose_owner")

    # 5. Финальная верификация назначения
    updated_pending = core.pending_owner()
    print(f"\n[*] Текущий pending_owner: {updated_pending}")
    if updated_pending.lower() == safe_address.lower():
        print("[✓] УСПЕХ: Safe назначен как pending_owner!")
        print("[*] СЛЕДУЮЩИЙ ШАГ: Совет Хранителей вызывает accept_ownership() из Safe.")
    else:
        print("[!] pending_owner пока не обновился. Проверьте статус транзакции через несколько секунд.")


def moccasin_main():
    return main()
