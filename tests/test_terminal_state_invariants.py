import boa
import pytest

def test_banned_memorial_rejects_all_interactions(core, owner, alice, bob):
    print("\n" + "=" * 70)
    print(" 🛑 ТЕСТ ИНВАРИАНТОВ: Полная блокировка действий над забаненным объектом")
    print("=" * 70)

    fee = core.creation_fee()
    candle_price = core.candle_price()

    # 1. Alice и Bob создают свои мемориалы
    with boa.env.prank(alice):
        core.create_memorial("Rex", "arweave-hash-rex", True, value=fee)
    mem_id = 1

    with boa.env.prank(bob):
        core.create_memorial("Buddy", "arweave-hash-buddy", True, value=fee)

    # 2. Проверяем штатное взаимодействие до бана: зажжение свечи
    with boa.env.prank(bob):
        core.light_candle(mem_id, 1, value=candle_price)
    assert core.total_candles_lit(mem_id) == 1
    print("[1] До бана: свеча успешно зажжена (total_candles = 1)")

    # 3. Совет накладывает терминальный бан
    with boa.env.prank(owner):
        core.force_ban(mem_id)
    assert core.memorials(mem_id)[6] is True
    print("[2] Совет наложил force_ban. Мемориал переведен в терминальное состояние.")

    # 4. Проверка инварианта 1: light_candle ОБЯЗАН ревертиться (защита ETH пользователя)
    print("\n[3] Попытка зажечь свечу на забаненном объекте...")
    bob_bal_before = boa.env.get_balance(bob)
    with boa.env.prank(bob):
        with boa.reverts("Memorial is banned"):
            core.light_candle(mem_id, 1, value=candle_price)
    # Баланс Bob не должен уменьшиться
    assert boa.env.get_balance(bob) == bob_bal_before
    print("    [✓] REVERT: Покупка свечи отклонена, ETH пользователя сохранен!")

    # 5. Проверка инварианта 2: report_memorial ОБЯЗАН ревертиться
    print("\n[4] Попытка отправить жалобу на уже забаненный объект...")
    with boa.env.prank(bob):
        with boa.reverts("Memorial already banned"):
            core.report_memorial(mem_id)
    assert core.report_weight(mem_id) == 0
    print("    [✓] REVERT: Жалоба отклонена, фантомный стейт не начислен!")

    # 6. Проверка инварианта 3: dismiss_reports ОБЯЗАН ревертиться
    print("\n[5] Попытка администратора вызвать dismiss_reports...")
    with boa.env.prank(owner):
        with boa.reverts("Memorial is banned; use unban"):
            core.dismiss_reports(mem_id)
    print("    [✓] REVERT: Случайный разбан через dismiss_reports предотвращен!")

    # 7. Явный unban восстанавливает штатный доступ
    print("\n[6] Owner выполняет осознанный unban_memorial...")
    with boa.env.prank(owner):
        core.unban_memorial(mem_id)

    with boa.env.prank(bob):
        core.light_candle(mem_id, 1, value=candle_price)
    assert core.total_candles_lit(mem_id) == 2
    print("    [✓] После снятия бана взаимодействие снова доступно (total_candles = 2)")

    print("\n" + "=" * 70)
    print(" ✅ ВСЕ ИНВАРИАНТЫ ТЕРМИНАЛЬНОГО СОСТОЯНИЯ СОБЛЮДЕНЫ!")
    print("=" * 70 + "\n")