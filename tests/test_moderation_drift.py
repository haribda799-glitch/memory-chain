import boa
import pytest

def test_organic_growth_resurrects_hidden_memorial(core, alice):
    print("\n" + "=" * 68)
    print(" 📉 PoC ТЕСТ: Воскрешение мемориала из-за роста total_owners (V1)")
    print("=" * 68)

    fee = core.creation_fee()

    # 1. Alice создает токсичный мемориал #1
    with boa.env.prank(alice):
        core.create_memorial("Toxic Post", "arweave-hash-bad", True, value=fee)
    target_id = 1
    print(f"[1] Создан мемориал #{target_id} от Alice.")

    # 2. Наполняем базу до 25 владельцев (чтобы порог 20% стал ровно 5)
    # Формула: (25 * 20) // 100 = 5
    print("[2] Создаем базу из 24 дополнительных владельцев мемориалов...")
    reporters = []
    for i in range(24):
        user = boa.env.generate_address()
        boa.env.set_balance(user, 10 * 10**18)
        with boa.env.prank(user):
            core.create_memorial(f"Pet {i}", f"arweave-hash-{i}", True, value=fee)
        if i < 5:
            reporters.append(user)

    total_owners_initial = core.total_memorial_owners()
    print(f"    └── Всего владельцев: {total_owners_initial}")
    assert total_owners_initial == 25

    # 3. Первые 5 пользователей репортят мемориал Alice (вес каждого = 1)
    print("\n[3] 5 пользователей отправляют жалобы...")
    for reporter in reporters:
        with boa.env.prank(reporter):
            core.report_memorial(target_id)

    weight = core.report_weight(target_id)
    hidden_status_initial = core.is_memorial_hidden(target_id)

    print(f"    └── Накопленный report_weight: {weight}")
    print(f"    └── Порог скрытия при 25 юзерах: max((25 * 20)//100, 5) = 5")
    print(f"    └── Статус is_memorial_hidden: {hidden_status_initial}")
    assert hidden_status_initial is True, "Мемориал обязан быть скрыт!"
    print("    [✓] Мемориал успешно заблокирован сообществом!")

    # 4. Протокол растет: регистрируются еще 5 новых пользователей (с 25 до 30)
    # Порог скрытия теперь: (30 * 20) // 100 = 6
    print("\n[4] 📈 Органический рост: регистрируются еще 5 новых пользователей...")
    for i in range(25, 30):
        new_user = boa.env.generate_address()
        boa.env.set_balance(new_user, 10 * 10**18)
        with boa.env.prank(new_user):
            core.create_memorial(f"Pet {i}", f"arweave-hash-{i}", True, value=fee)

    total_owners_after = core.total_memorial_owners()
    print(f"    └── Новое число владельцев: {total_owners_after}")
    assert total_owners_after == 30

    # 5. Проверяем статус скрытия мемориала при неизменном модуле V1
    hidden_status_after = core.is_memorial_hidden(target_id)
    print(f"\n[5] Проверка статуса токсичного мемориала под модулем V1:")
    print(f"    └── Вес жалоб остался прежним: {core.report_weight(target_id)}")
    print(f"    └── Новый порог скрытия: max((30 * 20)//100, 5) = 6")
    print(f"    └── Статус is_memorial_hidden: {hidden_status_after}")

    # 6. Фиксация защиты
    if hidden_status_after:
        print("\n    ✅ ИНВАРИАНТ ЗАЩИЩЕН: ХРАПОВИК СООБЩЕСТВА НЕ ДАЛ СПАМУ ВОСКРЕСНУТЬ!")
        print("        Контент остался скрытым в публичной галерее несмотря на рост числа пользователей.")

    assert hidden_status_after is True, "Мемориал должен остаться скрытым благодаря храповику"
    assert core.is_memorial_visible(target_id) is False, "Мемориал не должен быть виден в галерее"
    print("=" * 68 + "\n")