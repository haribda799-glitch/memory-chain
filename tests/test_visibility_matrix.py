import boa
import pytest

def test_memorial_visibility_truth_table(core, owner, alice):
    print("\n" + "=" * 70)
    print(" 📊 ТЕСТ МАТРИЦЫ СОСТОЯНИЙ: is_memorial_visible & is_banned")
    print("=" * 70)

    fee = core.creation_fee()

    # -----------------------------------------------------------------
    # Сценарий 1: Базовое состояние (Public=True, Hidden=False, Banned=False)
    # -----------------------------------------------------------------
    print("\n[1] Создание чистого публичного мемориала #1...")
    with boa.env.prank(alice):
        core.create_memorial("Rex", "arweave-hash-rex", True, value=fee)
    mem_id = 1

    mem = core.memorials(mem_id)
    print(f"    └── Flags: is_public={mem[4]}, is_hidden={mem[5]}, is_banned={mem[6]}")
    print(f"    └── is_memorial_visible: {core.is_memorial_visible(mem_id)}")
    print(f"    └── is_memorial_hidden:  {core.is_memorial_hidden(mem_id)}")

    assert core.is_memorial_visible(mem_id) is True
    assert core.is_memorial_hidden(mem_id) is False

    # -----------------------------------------------------------------
    # Сценарий 2: Приватность автора (Public=False, Hidden=False, Banned=False)
    # -----------------------------------------------------------------
    print("\n[2] Автор переключает видимость в приватный режим (toggle_public)...")
    with boa.env.prank(alice):
        core.toggle_public(mem_id)

    mem = core.memorials(mem_id)
    print(f"    └── Flags: is_public={mem[4]}, is_hidden={mem[5]}, is_banned={mem[6]}")
    print(f"    └── is_memorial_visible: {core.is_memorial_visible(mem_id)} (Должен быть False)")

    assert mem[4] is False
    assert core.is_memorial_visible(mem_id) is False
    assert core.is_memorial_hidden(mem_id) is False  # Сообщество не скрывало

    # Возвращаем в публичный режим перед тестом бана
    with boa.env.prank(alice):
        core.toggle_public(mem_id)

    # -----------------------------------------------------------------
    # Сценарий 3: Административный бан (Public=True, Hidden=False, Banned=True)
    # -----------------------------------------------------------------
    print("\n[3] 🔨 Owner накладывает force_ban...")
    with boa.env.prank(owner):
        core.force_ban(mem_id)

    mem = core.memorials(mem_id)
    print(f"    └── Flags: is_public={mem[4]}, is_hidden={mem[5]}, is_banned={mem[6]}")
    print(f"    └── is_memorial_visible: {core.is_memorial_visible(mem_id)}")
    print(f"    └── is_memorial_hidden:  {core.is_memorial_hidden(mem_id)}")

    assert mem[6] is True
    assert core.is_memorial_visible(mem_id) is False
    assert core.is_memorial_hidden(mem_id) is True  # Для совместимости со старыми вызовами

    # -----------------------------------------------------------------
    # Сценарий 4: Защита от случайного разбана через dismiss_reports (Категория 1 & 3)
    # -----------------------------------------------------------------
    print("\n[4] 🛑 Попытка вызвать dismiss_reports на забаненный мемориал...")
    with boa.env.prank(owner):
        with boa.reverts():
            core.dismiss_reports(mem_id)
    print("    [✓] REVERT: dismiss_reports заблокирован для забаненного мемориала!")

    # -----------------------------------------------------------------
    # Сценарий 5: Явный разбан через unban_memorial
    # -----------------------------------------------------------------
    print("\n[5] 🔓 Owner выполняет явный unban_memorial...")
    with boa.env.prank(owner):
        core.unban_memorial(mem_id)

    mem = core.memorials(mem_id)
    print(f"    └── Flags: is_public={mem[4]}, is_hidden={mem[5]}, is_banned={mem[6]}")
    print(f"    └── is_memorial_visible: {core.is_memorial_visible(mem_id)}")

    assert mem[6] is False
    assert core.is_memorial_visible(mem_id) is True
    # -----------------------------------------------------------------
    # Сценарий 6: Соборное скрытие сообществом (Public=True, Hidden=True, Banned=False)
    # -----------------------------------------------------------------
    print("\n[6] 👥 Набираем кворум и жалобы сообщества до порога скрытия...")
    # Набираем кворум сообщества (MIN_COMMUNITY_QUORUM = 20), создаем 24 пользователя (всего 25 с Alice)
    reporters = []
    for i in range(24):
        user = boa.env.generate_address()
        boa.env.set_balance(user, 10 * 10**18)
        with boa.env.prank(user):
            core.create_memorial(f"ReporterPet_{i}", f"arweave-uri-{i}", True, value=fee)
        if i < 5:
            reporters.append(user)

    for rep in reporters:
        with boa.env.prank(rep):
            core.report_memorial(mem_id)

    mem = core.memorials(mem_id)
    print(f"    └── Flags: is_public={mem[4]}, is_hidden={mem[5]}, is_banned={mem[6]}")
    print(f"    └── report_weight: {core.report_weight(mem_id)}")
    print(f"    └── is_memorial_visible: {core.is_memorial_visible(mem_id)} (Должен быть False)")
    print(f"    └── is_memorial_hidden:  {core.is_memorial_hidden(mem_id)} (Должен быть True)")

    # Проверяем, что защелка сработала в Storage
    assert mem[5] is True, "Флаг is_hidden обязан стать True в структуре Memorial!"
    assert mem[6] is False, "Мемориал НЕ забанен Советом"
    assert core.is_memorial_visible(mem_id) is False
    assert core.is_memorial_hidden(mem_id) is True

    # -----------------------------------------------------------------
    # Сценарий 7: Сброс жалоб сообщества через dismiss_reports
    # -----------------------------------------------------------------
    print("\n[7] 🔄 Owner снимает ложные жалобы через dismiss_reports...")
    with boa.env.prank(owner):
        core.dismiss_reports(mem_id)

    mem = core.memorials(mem_id)
    print(f"    └── Flags: is_public={mem[4]}, is_hidden={mem[5]}, is_banned={mem[6]}")
    print(f"    └── report_weight сброшен в: {core.report_weight(mem_id)}")
    print(f"    └── is_memorial_visible: {core.is_memorial_visible(mem_id)} (Снова True!)")

    assert mem[5] is False, "Флаг is_hidden обязан сброситься в False"
    assert core.is_memorial_visible(mem_id) is True
    assert core.is_memorial_hidden(mem_id) is False

    print("\n" + "=" * 70)
    print(" ✅ МАТРИЦА СОСТОЯНИЙ ПОДТВЕРЖДЕНА: Логика видимости консистентна!")
    print("=" * 70 + "\n")