import boa
import pytest

def test_creation_fee_exact_amount_invariant(core, alice):
    print("\n" + "=" * 70)
    print(" 🛡️  REGRESSION: Инвариант строгого соответствия creation_fee")
    print("=" * 70)

    fee = core.creation_fee()

    # 1. Попытка переплатить (x1.5) — обязана ревертиться
    overpayment = int(fee * 1.5)
    print(f"[1] Проверка отсечения переплаты ({overpayment} wei при fee {fee} wei)...")
    with boa.env.prank(alice):
        with boa.reverts("Exact creation fee required"):
            core.create_memorial("Rex", "arweave-hash-rex", True, value=overpayment)
    print("    [✓] REVERT: Переплата успешно заблокирована!")

    # 2. Попытка недоплатить (fee - 1 wei) — обязана ревертиться
    print("\n[2] Проверка отсечения недоплаты...")
    with boa.env.prank(alice):
        with boa.reverts("Exact creation fee required"):
            core.create_memorial("Rex", "arweave-hash-rex", True, value=fee - 1)
    print("    [✓] REVERT: Недоплата отклонена!")

    # 3. Отправка точной суммы — должна пройти штатно
    print("\n[3] Отправка ровно creation_fee...")
    alice_bal_before = boa.env.get_balance(alice)
    with boa.env.prank(alice):
        core.create_memorial("Rex", "arweave-hash-rex", True, value=fee)
    
    alice_bal_after = boa.env.get_balance(alice)
    assert alice_bal_before - alice_bal_after == fee, "Списана сумма строго по тарифу"
    assert core.memorial_count() == 1
    assert boa.env.get_balance(core.address) == fee
    print("    [✓] Мемориал успешно создан, баланс контракта строго равен тарифу.")
    print("=" * 70 + "\n")