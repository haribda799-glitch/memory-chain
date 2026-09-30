import boa

def test_change_price():
    owner = boa.env.generate_address()
    hacker = boa.env.generate_address()

    print("Owner address:", owner)
    print("Hacker address:", hacker)

    # Деплоим контракт
    with boa.env.prank(owner):
        core = boa.load("/home/ericozz/Works/memory-chain/src/MemoryChainCore.vy", "0x0000000000000000000000000000000000000000", 100_000_000_000_000, 100_000_000_000_000)
    print("Деплоим контракт, адрес деплоя:", core.address)    

    # Меняем цену свечи от лица owner
    
    print("Исходная цена свечи:", core.candle_price())

    with boa.env.prank(owner):
        core.set_candle_price(200_000_000_000_000)
    
    print("Цена свечи изменена на:", core.candle_price())

    # Проверяем, что хакер НЕ может изменить цену (вызов должен упасть с "Not owner")

    price_before = core.candle_price()
    print("Цена свечи перед попыткой хакера изменить:", price_before)


    # Хакер пытается изменить цену
    with boa.reverts("Not owner"):
        with boa.env.prank(hacker):
            core.set_candle_price(200_000_000_000_000)

    if core.candle_price() == price_before:
        print("Хакер не смог изменить цену свечи, как и ожидалось.")

if __name__ == "__main__":
    test_change_price()
    print("Тестирование завершено")
