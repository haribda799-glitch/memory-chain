import boa
import pytest

def test_force_ban_dismiss_regression(core, owner, alice, bob):
    print("\n" + "=" * 65)
    print(" 🛡️  REGRESSION ТЕСТ: Проверка восстановления стейта после фикса")
    print("=" * 65)

    fee = core.creation_fee()

    # ---------------------------------------------------------
    # СЦЕНАРИЙ 1: Публичный мемориал (Alice)
    # ---------------------------------------------------------
    print("\n--- СЦЕНАРИЙ 1: Публичный мемориал ---")
    with boa.env.prank(alice):
        core.create_memorial("Buddy (Public)", "arweave-hash-1", True, value=fee)
    mem_pub_id = 1

    print(f"[1] Создан публичный мемориал #{mem_pub_id}")
    print(f"    └── is_public: {core.memorials(mem_pub_id)[4]}")
    print(f"    └── is_hidden: {core.is_memorial_hidden(mem_pub_id)}")
    print(f"    └── is_visible: {core.is_memorial_visible(mem_pub_id)}")

    assert core.memorials(mem_pub_id)[4] is True
    assert core.memorials(mem_pub_id)[5] is False  # is_hidden
    assert core.memorials(mem_pub_id)[6] is False  # is_banned
    assert core.is_memorial_visible(mem_pub_id) is True

    # Бан публичного мемориала
    print(f"[2] 🔨 Owner вызывает force_ban({mem_pub_id})...")
    with boa.env.prank(owner):
        core.force_ban(mem_pub_id)

    print(f"    └── is_public автора: {core.memorials(mem_pub_id)[4]} (НЕ изменился)")
    print(f"    └── is_banned: {core.memorials(mem_pub_id)[6]} (Забанен)")
    print(f"    └── is_hidden: {core.is_memorial_hidden(mem_pub_id)} (Скрыт)")
    print(f"    └── is_visible: {core.is_memorial_visible(mem_pub_id)} (Не виден)")

    assert core.memorials(mem_pub_id)[4] is True
    assert core.memorials(mem_pub_id)[6] is True
    assert core.is_memorial_hidden(mem_pub_id) is True
    assert core.is_memorial_visible(mem_pub_id) is False

    # Попытка dismiss_reports на забаненном мемориале должна упасть
    with boa.env.prank(owner):
        with boa.reverts("Memorial is banned; use unban"):
            core.dismiss_reports(mem_pub_id)

    # Снятие бана публичного мемориала
    print(f"[3] 🔄 Owner вызывает unban_memorial({mem_pub_id})...")
    with boa.env.prank(owner):
        core.unban_memorial(mem_pub_id)

    print(f"    └── is_public: {core.memorials(mem_pub_id)[4]} (Остался True)")
    print(f"    └── is_banned: {core.memorials(mem_pub_id)[6]} (False)")
    print(f"    └── is_hidden: {core.is_memorial_hidden(mem_pub_id)} (Снова False)")
    print(f"    └── is_visible: {core.is_memorial_visible(mem_pub_id)} (Снова True - виден в галерее!)")

    assert core.memorials(mem_pub_id)[4] is True
    assert core.memorials(mem_pub_id)[6] is False
    assert core.is_memorial_hidden(mem_pub_id) is False
    assert core.is_memorial_visible(mem_pub_id) is True

    # ---------------------------------------------------------
    # СЦЕНАРИЙ 2: Приватный мемориал (Bob)
    # ---------------------------------------------------------
    print("\n--- СЦЕНАРИЙ 2: Приватный мемориал ---")
    with boa.env.prank(bob):
        core.create_memorial("Whiskers (Private)", "arweave-hash-2", False, value=fee)
    mem_priv_id = 2

    print(f"[4] Создан приватный мемориал #{mem_priv_id}")
    print(f"    └── is_public: {core.memorials(mem_priv_id)[4]}")
    print(f"    └── is_visible: {core.is_memorial_visible(mem_priv_id)}")

    assert core.memorials(mem_priv_id)[4] is False
    assert core.is_memorial_visible(mem_priv_id) is False

    # Бан и разбан приватного мемориала
    print(f"[5] 🔨 Бан и 🔄 разбан мемориала #{mem_priv_id}...")
    with boa.env.prank(owner):
        core.force_ban(mem_priv_id)
        assert core.is_memorial_hidden(mem_priv_id) is True
        core.unban_memorial(mem_priv_id)

    print(f"    └── is_public: {core.memorials(mem_priv_id)[4]} (Остался False - приватность не нарушена!)")
    print(f"    └── is_hidden: {core.is_memorial_hidden(mem_priv_id)}")
    print(f"    └── is_visible: {core.is_memorial_visible(mem_priv_id)}")

    assert core.memorials(mem_priv_id)[4] is False
    assert core.is_memorial_hidden(mem_priv_id) is False
    assert core.is_memorial_visible(mem_priv_id) is False

    print("\n" + "=" * 65)
    print(" ✅ РЕГРЕССИОННЫЙ ТЕСТ ПРОЙДЕН: Инварианты стейта сохранены!")
    print("=" * 65 + "\n")