import boa
import pytest

def test_eoa_moderation_module_blocked_at_proposal(core, owner, alice, moderation_module):
    print("\n" + "=" * 65)
    print(" 🛡️  REGRESSION ТЕСТ: Smoke-тест модуля модерации при propose/apply")
    print("=" * 65)

    # 1. Попытка предложить некорректный адрес (EOA)
    fake_module = boa.env.generate_address()
    print(f"[1] Owner пытается предложить EOA: {fake_module}")
    
    with boa.env.prank(owner):
        with boa.reverts():
            core.propose_moderation_module(fake_module)
    print("    [✓] ОШИБКА ПЕРЕХВАЧЕНА: propose_moderation_module отклонён сразу!")

    # Убеждаемся, что таймлок не был взведён
    assert core.proposed_moderation_module() == "0x0000000000000000000000000000000000000000"
    assert core.moderation_module_timelock() == 0
    print("    [✓] Инвариант: proposed_moderation_module остался нулевым")

    # 2. Попытка предложить легитимный контракт ModerationModule
    import src.ModerationModule as ModerationModule
    with boa.env.prank(owner):
        new_valid_module = ModerationModule.deploy()
    print(f"\n[2] Задеплоен валидный модуль: {new_valid_module.address}")

    with boa.env.prank(owner):
        core.propose_moderation_module(new_valid_module.address)
    print("    [✓] propose_moderation_module успешно принят!")

    # 3. Перематываем время на 48 часов + 1 сек
    timelock_delay = 172800
    boa.env.time_travel(seconds=timelock_delay + 1)
    print("[3] ⏳ Прошло 48 часов...")

    # 4. Применяем модуль
    with boa.env.prank(owner):
        core.apply_moderation_module()
    print("    [✓] apply_moderation_module успешно выполнен!")

    assert core.moderation_module() == new_valid_module.address
    print(f"[4] Активный модуль модерации обновлен: {core.moderation_module()}")

    # 5. Проверяем работоспособность view-функции на созданном мемориале
    fee = core.creation_fee()
    with boa.env.prank(alice):
        core.create_memorial("Buddy", "hash1", True, value=fee)
    assert core.is_memorial_hidden(1) is False
    assert core.is_memorial_visible(1) is True
    print("    [✓] is_memorial_hidden и is_memorial_visible работают корректно без ревертов!")

    print("=" * 65 + "\n")