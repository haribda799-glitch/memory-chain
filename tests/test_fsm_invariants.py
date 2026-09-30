import boa
import pytest

def test_fsm_invariants(core, owner, alice):
    print("\n" + "=" * 70)
    print(" 🛡️  REGRESSION ТЕСТ: Защита FSM от мутаций забаненного мемориала")
    print("=" * 70)

    fee = core.creation_fee()

    # 1. Alice создает мемориал
    with boa.env.prank(alice):
        core.create_memorial("Rexix", "arweave-hash-rex", True, value=fee)
    memorial_id = 1

    # 2. Council накладывает терминальный бан
    with boa.env.prank(owner):
        core.force_ban(memorial_id)

    assert core.memorials(memorial_id).is_banned is True

    # 3. Регрессионная проверка: toggle_public ОБЯЗАН ревертиться
    print("\n[1] Проверка вызова toggle_public на забаненном мемориале...")
    with boa.env.prank(alice):
        with boa.reverts("Memorial is banned"):
            core.toggle_public(memorial_id)

    # 4. Проверяем неизменность стейта
    memorial_after = core.memorials(memorial_id)
    assert memorial_after.is_public is True, "is_public не должен был измениться!"
    assert memorial_after.is_banned is True

    print("    [✓] REVERT: toggle_public отклонен с ошибкой 'Memorial is banned'!")
    print("=" * 70 + "\n")