import boa

def test_create_memorial_paused():
    # 1. ARRANGE (Подготовка)
    # Деплоим модуль модерации
    mod = boa.load("src/ModerationModule.vy")
        
    valid_price = 100_000_000_000_000  # 0.0001 ETH
    valid_fee = 100_000_000_000_000    # 0.0001 ETH

    owner = boa.env.generate_address()
    user = boa.env.generate_address()
    boa.env.set_balance(user, 10**18)  # Даем пользователю 1 ETH

    # Деплоим реестр от имени owner с передачей всех 3 аргументов конструктора
    with boa.env.prank(owner):
        core = boa.load("src/MemoryChainCore.vy", mod.address, valid_price, valid_fee)
        # Владелец ставит создание мемориалов на паузу
        core.toggle_pause(True, False)

    # 2. ACT & 3. ASSERT (Проверка отката)
    # Ожидаем откат с точным текстом ошибки из assert в Vyper
    with boa.reverts("Creation paused"):
        with boa.env.prank(user):
            core.create_memorial(
                "Fluffy",                # _pet_name: String[128]
                "ar://test_arweave_uri", # _arweave_uri: String[64]
                True,                    # _is_public: bool
                value=valid_fee
            )



    