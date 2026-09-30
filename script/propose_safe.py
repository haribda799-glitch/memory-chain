"""
script/propose_safe.py — Post-deployment verification & Safe ownership proposal.
Connects to deployed MemoryChainCore, audits state variables via view calls,
and executes Step 1 of 2-Step Ownership Transfer.
"""
from moccasin.config import get_active_network
from src import MemoryChainCore

CORE_ADDRESS = "0x5de836cf6fc88d88eec93309663372ad723baf8f"
SAFE_ADDRESS = "0x7D29Ae44D5041b59012e784818446088774305F5"
EXPECTED_MOD_MODULE = "0x7120f05831bab3742b58a0a17e7a9b64789f30f3"


def main():
    network = get_active_network()
    deployer = network.get_default_account()

    print(f"\n[*] Сеть: {network.name} (Chain ID: {network.chain_id})")
    print(f"[*] Аккаунт деплойера: {deployer.address}")

    # 1. Подключение к задеплоенному ядру
    core = MemoryChainCore.at(CORE_ADDRESS)

    # 2. Аудит инвариантов инициализации (Категория 3 & 4)
    print("\n[1/2] Проверка параметров инициализации контракта...")
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

    assert mod_module.lower() == EXPECTED_MOD_MODULE.lower(), "Неверный адрес модуля модерации!"
    assert owner.lower() == deployer.address.lower(), "Деплойер не является владельцем!"
    assert treasury.lower() == deployer.address.lower(), "Казна не указывает на деплойера!"
    print("[✓] Все переменные состояния инициализированы корректно.")

    # 3. Инициирование передачи владения (Категория 1 & 6)
    current_pending = core.pending_owner()
    if current_pending.lower() == SAFE_ADDRESS.lower():
        print(f"\n[✓] Safe ({SAFE_ADDRESS}) уже назначен в качестве pending_owner.")
        return

    print(f"\n[2/2] Назначение Safe ({SAFE_ADDRESS}) в качестве pending_owner...")
    try:
        core.propose_owner(SAFE_ADDRESS)
    except TypeError as e:
        # Перехватываем лаг синхронизации _reset_fork публичной ноды
        if "'NoneType' object is not subscriptable" in str(e):
            print("[!] Внимание: Boa столкнулся с задержкой ноды при обновлении форка.")
            print("[*] Транзакция была отправлена в сеть. Проверяем фактический результат...")
        else:
            raise e

    # 4. Финальная верификация назначения
    updated_pending = core.pending_owner()
    print(f"\n[*] Текущий pending_owner: {updated_pending}")
    if updated_pending.lower() == SAFE_ADDRESS.lower():
        print("[✓] УСПЕХ: Safe назначен как pending_owner!")
        print(f"[*] СЛЕДУЮЩИЙ ШАГ: Совет Хранителей должен вызвать accept_ownership() из Safe.")
    else:
        print("[!] pending_owner пока не обновился. Проверь статус транзакции через несколько секунд.")


def moccasin_main():
    return main()