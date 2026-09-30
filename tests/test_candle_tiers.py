import boa
import pytest

CANDLE_PRICE = 10**15        # 0.001 ETH
CREATION_FEE = 10**14        # 0.0001 ETH
PET_NAME = "Rex"
ARWEAVE_URI = "arweave-tx-id-0001"

MIN_CANDLE_PRICE = 100_000_000_000_000
MAX_EXPIRY_HORIZON = 31_536_000  # 1 год

TIER_MULTIPLIERS = {1: 1, 2: 3, 3: 6, 4: 10}
TIER_DURATIONS = {1: 3600, 2: 18000, 3: 43200, 4: 86400}
TEN_ETH = 10**19


# ──────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────

@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def alice():
    addr = boa.env.generate_address("alice")
    boa.env.set_balance(addr, 10**20)
    return addr


@pytest.fixture
def bob():
    addr = boa.env.generate_address("bob")
    boa.env.set_balance(addr, 10**20)
    return addr


@pytest.fixture
def moderation_module():
    return boa.load("src/ModerationModule.vy")


@pytest.fixture
def core(owner, moderation_module):
    with boa.env.prank(owner):
        return boa.load(
            "src/MemoryChainCore.vy",
            moderation_module.address,
            CANDLE_PRICE,
            CREATION_FEE,
        )


@pytest.fixture
def memorial_id(core, alice):
    with boa.env.prank(alice):
        core.create_memorial(PET_NAME, ARWEAVE_URI, True, value=CREATION_FEE)
    return core.memorial_count()


# ──────────────────────────────────────────────────────────────
# 1. light_candle(): строгое msg.value == tier.price для всех 4 тиров
# ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("tier_id", [1, 2, 3, 4])
def test_light_candle_exact_price_succeeds_and_extends_expiry(
    core, bob, memorial_id, tier_id
):
    multiplier = TIER_MULTIPLIERS[tier_id]
    duration = TIER_DURATIONS[tier_id]
    required_price = CANDLE_PRICE * multiplier
    ts_before = boa.env.timestamp

    with boa.env.prank(bob):
        core.light_candle(memorial_id, tier_id, value=required_price)

    expires_at = core.candle_expires_at(memorial_id)
    total_lit = core.total_candles_lit(memorial_id)

    print(f"\n[+] Tier {tier_id} OK | Paid: {required_price / 1e18:.4f} ETH ({multiplier}x) | "
          f"+{duration}s ({duration // 3600}h) | Exp: {expires_at} | Total Lit: {total_lit}")

    assert expires_at == ts_before + duration
    assert total_lit == 1


@pytest.mark.parametrize("tier_id", [1, 2, 3, 4])
def test_light_candle_reverts_on_underpayment(core, bob, memorial_id, tier_id):
    multiplier = TIER_MULTIPLIERS[tier_id]
    required_price = CANDLE_PRICE * multiplier
    underpayment = required_price - 1

    expires_before = core.candle_expires_at(memorial_id)
    lit_before = core.total_candles_lit(memorial_id)

    with boa.env.prank(bob):
        with boa.reverts("Incorrect payment for tier"):
            core.light_candle(memorial_id, tier_id, value=underpayment)

    print(f"\n[✓] Revert Underpayment Tier {tier_id} | Sent: {underpayment} wei (-1) | Revert: 'Incorrect payment for tier'")

    assert core.candle_expires_at(memorial_id) == expires_before
    assert core.total_candles_lit(memorial_id) == lit_before


@pytest.mark.parametrize("tier_id", [1, 2, 3, 4])
def test_light_candle_reverts_on_overpayment(core, bob, memorial_id, tier_id):
    multiplier = TIER_MULTIPLIERS[tier_id]
    required_price = CANDLE_PRICE * multiplier
    overpayment = required_price + 1

    expires_before = core.candle_expires_at(memorial_id)
    lit_before = core.total_candles_lit(memorial_id)

    with boa.env.prank(bob):
        with boa.reverts("Incorrect payment for tier"):
            core.light_candle(memorial_id, tier_id, value=overpayment)

    print(f"\n[✓] Revert Overpayment Tier {tier_id} | Sent: {overpayment} wei (+1) | Revert: 'Incorrect payment for tier'")

    assert core.candle_expires_at(memorial_id) == expires_before
    assert core.total_candles_lit(memorial_id) == lit_before


@pytest.mark.parametrize("tier_id", [1, 2, 3, 4])
def test_light_candle_reverts_on_zero_payment(core, bob, memorial_id, tier_id):
    with boa.env.prank(bob):
        with boa.reverts("Incorrect payment for tier"):
            core.light_candle(memorial_id, tier_id, value=0)

    print(f"\n[✓] Revert Zero Payment Tier {tier_id} | Sent: 0 wei | Revert: 'Incorrect payment for tier'")


# ──────────────────────────────────────────────────────────────
# 2. donate_and_light(): блокировка ниже candle_price
# ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value", [0, CANDLE_PRICE - 1])
def test_donate_and_light_reverts_below_candle_price(
    core, bob, memorial_id, value
):
    expires_before = core.candle_expires_at(memorial_id)
    lit_before = core.total_candles_lit(memorial_id)

    with boa.env.prank(bob):
        with boa.reverts("Donation below candle price"):
            core.donate_and_light(memorial_id, value=value)

    print(f"\n[✓] Revert Min Donation Guard | Sent: {value} wei (Min: {CANDLE_PRICE}) | Revert: 'Donation below candle price'")

    assert core.candle_expires_at(memorial_id) == expires_before
    assert core.total_candles_lit(memorial_id) == lit_before


def test_donate_and_light_at_exact_candle_price_succeeds_with_one_hour(
    core, bob, memorial_id
):
    ts_before = boa.env.timestamp

    print("\n" + "=" * 68)
    print(" 🕯️  DONATE: Проверка нижнего порога (ровно candle_price -> 1 час)")
    print("=" * 68)
    print(f"[*] Отправка ровно candle_price:     {CANDLE_PRICE} wei ({CANDLE_PRICE / 1e18:.6f} ETH)")
    print(f"[*] Базовая цена (candle_price):     {CANDLE_PRICE} wei")
    print(f"[*] Расчёт: {CANDLE_PRICE} // {CANDLE_PRICE} == 1 -> 1 час")

    with boa.env.prank(bob):
        core.donate_and_light(memorial_id, value=CANDLE_PRICE)

    expires_at = core.candle_expires_at(memorial_id)
    print(f"[✓] Candle expiry установлен на: {expires_at} (+{expires_at - ts_before}s)")
    print("=" * 68)

    assert expires_at == ts_before + 3600
    assert core.total_candles_lit(memorial_id) == 1


# ──────────────────────────────────────────────────────────────
# 3. donate_and_light(): ограничение горизонта в 1 год
# ──────────────────────────────────────────────────────────────

def test_donate_and_light_caps_expiry_at_one_year_horizon(core, bob, memorial_id):
    raw_added_hours = TEN_ETH // CANDLE_PRICE
    raw_duration = raw_added_hours * 3600
    ts_before = boa.env.timestamp

    print("\n" + "=" * 68)
    print(" ⏳ CAP ТЕСТ: Ограничение горизонта до 1 года при крупном донате")
    print("=" * 68)
    print(f"[*] Входящий донат:           {TEN_ETH / 1e18:.1f} ETH")
    print(f"[*] Сырая длительность:       {raw_duration}s (~{raw_duration // 86400} дней)")
    print(f"[*] Максимальный горизонт:    {MAX_EXPIRY_HORIZON}s (~{MAX_EXPIRY_HORIZON // 86400} дней / 1 год)")

    with boa.env.prank(bob):
        core.donate_and_light(memorial_id, value=TEN_ETH)

    ts_after = boa.env.timestamp
    expires_at = core.candle_expires_at(memorial_id)

    lower_bound = ts_before + MAX_EXPIRY_HORIZON
    upper_bound = ts_after + MAX_EXPIRY_HORIZON

    print(f"[✓] Фактический expires_at:   {expires_at}")
    print(f"[✓] Отрезанный излишек:       {raw_duration - (expires_at - ts_before)}s")
    print("=" * 68)

    assert lower_bound <= expires_at <= upper_bound
    assert expires_at < ts_before + raw_duration
    assert core.total_candles_lit(memorial_id) == 1


def test_donate_and_light_horizon_cap_reanchors_on_repeated_large_donations(
    core, bob, memorial_id
):
    print("\n" + "=" * 68)
    print(" 🔄 RE-ANCHOR ТЕСТ: Перепривязка горизонта при повторных донатах")
    print("=" * 68)

    # Первый донат 10 ETH
    with boa.env.prank(bob):
        core.donate_and_light(memorial_id, value=TEN_ETH)
    first_expiry = core.candle_expires_at(memorial_id)
    print(f"[*] Донат #1 (10 ETH): Expiry зафиксирован на {first_expiry}")

    # Перематываем время на 30 дней вперед
    boa.env.time_travel(seconds=30 * 86400)
    current_ts = boa.env.timestamp
    print(f"[*] Прошло 30 дней. Текущий timestamp: {current_ts}")

    # Второй донат 10 ETH
    with boa.env.prank(bob):
        core.donate_and_light(memorial_id, value=TEN_ETH)
    second_expiry = core.candle_expires_at(memorial_id)

    expected_expiry = current_ts + MAX_EXPIRY_HORIZON

    print(f"[*] Донат #2 (10 ETH): Новый expiry зафиксирован на {second_expiry}")
    print(f"[*] Дельта сдвига горизонта: +{second_expiry - first_expiry}s (~{(second_expiry - first_expiry) // 86400} дней)")
    print(f"[✓] Горизонт перепривязан строго к current_ts + 1 год: {expected_expiry}")
    print("=" * 68)

    assert second_expiry == expected_expiry
    assert core.total_candles_lit(memorial_id) == 2