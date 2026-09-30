import boa
import pytest

# Имитируем новый модуль V2 с более мягким порогом (порог поднят до 10)
V2_MODULE_CODE = """
# pragma version ~=0.4.3
# pragma evm-version cancun

@external
@pure
def is_hidden(report_weight: uint256, total_users: uint256) -> bool:
    # Мягкие правила: скрывать только при наборе 10 весовых очков
    return report_weight >= 10

@external
@pure
def is_flagged(report_weight: uint256, total_users: uint256) -> bool:
    return report_weight >= 5
"""

def test_lazarus_effect_resurrects_hidden_memorial(core, owner, alice):
    print("\n" + "=" * 68)
    print(" 🧟 PoC ТЕСТ: Воскрешение скрытого спама при смене модуля (Lazarus)")
    print("=" * 68)

    fee = core.creation_fee()

    # 1. Alice создает мемориал #1 (потенциальный спам/оскорбление)
    with boa.env.prank(alice):
        core.create_memorial("Toxic Post", "arweave-hash-bad", True, value=fee)
    target_id = 1
    print(f"[1] Создан мемориал #{target_id} от Alice.")

    # 2. Создаем сообщество до достижения кворума (24 пользователя, всего 25 с Alice)
    print("[2] Создаем сообщество (24 пользователя, всего 25 с Alice)...")
    reporters = []
    for i in range(24):
        user = boa.env.generate_address()
        boa.env.set_balance(user, 10 * 10**18)
        with boa.env.prank(user):
            core.create_memorial(f"Pet {i}", f"arweave-hash-{i}", True, value=fee)
        if i < 5:
            reporters.append(user)

    for rep in reporters:
        with boa.env.prank(rep):
            core.report_memorial(target_id)

    # 3. Проверяем состояние под модулем V1:
    # total_owners = 25 (Alice + 24 репортера).
    # Порог V1: ceil(25 * 20%) = (25 * 20 + 99) // 100 = 5.
    weight_v1 = core.report_weight(target_id)
    hidden_under_v1 = core.is_memorial_hidden(target_id)
    
    print(f"\n[3] Состояние модерации (Модуль V1):")
    print(f"    └── Накопленный report_weight: {weight_v1}")
    print(f"    └── Всего пользователей в системе: {core.total_memorial_owners()}")
    print(f"    └── Статус is_memorial_hidden: {hidden_under_v1}")
    assert hidden_under_v1 is True, "Мемориал должен быть скрыт модулем V1"
    print("    [✓] Мемориал успешно заблокирован сообществом под правилами V1!")

    # 4. Хранители развертывают ModerationModuleV2 со смягченными правилами (порог = 10)
    v2_contract = boa.loads(V2_MODULE_CODE)
    print(f"\n[4] Задеплоен ModerationModuleV2 (порог скрытия = 10): {v2_contract.address}")

    with boa.env.prank(owner):
        core.propose_moderation_module(v2_contract.address)

    # Перематываем Timelock на 48 часов
    timelock_delay = 172800
    boa.env.time_travel(seconds=timelock_delay + 1)

    with boa.env.prank(owner):
        core.apply_moderation_module()
    print("    [✓] Модуль V2 успешно применен через Timelock.")

    # 5. Проверяем статус мемориала под модулем V2
    hidden_under_v2 = core.is_memorial_hidden(target_id)
    print(f"\n[5] Статус модерации после апгрейда на V2:")
    print(f"    └── Накопленный вес жалоб (не менялся): {core.report_weight(target_id)}")
    print(f"    └── Статус is_memorial_hidden: {hidden_under_v2}")

    # 6. Фиксация защиты от дефекта инварианта
    if hidden_under_v2:
        print("\n    ✅ ИНВАРИАНТ ЗАЩИЩЕН: ХРАПОВИК СООБЩЕСТВА СРАБОТАЛ!")
        print("        Токсичный контент ОСТАЛСЯ СКРЫТЫМ благодаря флагу is_hidden в структуре Memorial,")
        print("        даже при смягчении порога в новом модуле модерации!")

    assert hidden_under_v2 is True, "Мемориал должен остаться скрытым благодаря храповику сообщества"
    assert core.is_memorial_visible(target_id) is False, "Мемориал не должен быть виден в галерее"
    print("=" * 68 + "\n")