import boa
import pytest

CREATION_FEE = 10**14
BASE_CANDLE_PRICE = 10**14        # 0.0001 ETH
MIN_CANDLE_PRICE = 10**14         # Равно MIN_CANDLE_PRICE из контракта
NEW_MARKET_PRICE = 50 * 10**14    # 0.005 ETH (в 50 раз выше)


@pytest.fixture
def owner():
    return boa.env.generate_address("owner")


@pytest.fixture
def alice():
    addr = boa.env.generate_address("alice")
    boa.env.set_balance(addr, 10**19)
    return addr


@pytest.fixture
def bob():
    addr = boa.env.generate_address("bob")
    boa.env.set_balance(addr, 10**19)
    return addr


@pytest.fixture
def mod_module():
    return boa.load("src/ModerationModule.vy")


@pytest.fixture
def core(owner, mod_module):
    with boa.env.prank(owner):
        return boa.load(
            "src/MemoryChainCore.vy",
            mod_module.address,
            BASE_CANDLE_PRICE,
            CREATION_FEE,
        )


def test_donate_and_light_economic_arbitrage_prevented(core, owner, alice, bob):
    print("\n" + "=" * 72)
    print(" 🛡️  DEFENSE: Предотвращение арбитража стоимости свечи через donate_and_light")
    print("=" * 72)

    # 1. Alice создает мемориал
    with boa.env.prank(alice):
        core.create_memorial("Rex", "hash-rex", True, value=CREATION_FEE)
    mem_id = 1

    # 2. Совет поднимает цену свечи до 0.005 ETH из-за роста популярности
    with boa.env.prank(owner):
        core.set_candle_price(NEW_MARKET_PRICE)
    print(f"[*] Совет установил новую цену candle_price: {NEW_MARKET_PRICE / 1e18} ETH")

    # 3. Честный пользователь Alice покупает 1 час горения через light_candle(Tier 1)
    with boa.env.prank(alice):
        core.light_candle(mem_id, 1, value=NEW_MARKET_PRICE)
    print(f"[*] Alice заплатила: {NEW_MARKET_PRICE / 1e18} ETH за 1 час горения.")

    # 4. Попытка обхода Bob: вызывает donate_and_light со старой минималкой 0.0001 ETH -> Revert!
    boa.env.time_travel(seconds=3600)  # ждём, пока свеча Alice догорит

    expires_before_attempt = core.candle_expires_at(mem_id)
    lit_before_attempt = core.total_candles_lit(mem_id)

    with boa.env.prank(bob):
        with boa.reverts("Donation below candle price"):
            core.donate_and_light(mem_id, value=MIN_CANDLE_PRICE)

    # Регрессионная защита: после revert state НЕ должен измениться -
    # ни продления свечи, ни увеличения счётчика не произошло.
    assert core.candle_expires_at(mem_id) == expires_before_attempt
    assert core.total_candles_lit(mem_id) == lit_before_attempt

    print(f"[✓] Арбитраж заблокирован: платёж ниже актуального candle_price ")
    print(f"({MIN_CANDLE_PRICE} < {NEW_MARKET_PRICE}) отклонён.")

    # 5. Bob отправляет актуальную цену candle_price
    ts_before = boa.env.timestamp
    with boa.env.prank(bob):
        core.donate_and_light(mem_id, value=NEW_MARKET_PRICE)

    expiry_bob = core.candle_expires_at(mem_id)
    added_duration_bob = expiry_bob - ts_before

    print(f"[*] Bob заплатил:   {NEW_MARKET_PRICE / 1e18} ETH")
    print(f"[*] Bob получил:    {added_duration_bob} сек ({added_duration_bob // 3600} ч) горения.")

    assert added_duration_bob == 3600
    print("[✓] ЗАЩИТА ПОДТВЕРЖДЕНА: Стоимость часа горения в donate_and_light строго синхронизирована с candle_price!")
    print("=" * 72 + "\n")