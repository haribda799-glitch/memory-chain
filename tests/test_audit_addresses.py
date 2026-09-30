import boa

def test_print_contract_addresses():
    # 1. Деплоим модуль без аргументов
    mod = boa.load("src/ModerationModule.vy")
    
    # 2. Деплоим ядро, передавая адрес модуля mod.address
    core = boa.load("src/MemoryChainCore.vy", 
        mod.address, 
        100_000_000_000_000, 
        100_000_000_000_000
    )

    # 3. Печатаем адреса в консоль
    print(f"\n[+] Адрес ModerationModule: {mod.address}")
    print(f"[+] Адрес MemoryChainCore:   {core.address}")
    print(f"[+] Записанный адрес модуля внутри Core: {core.moderation_module()}")

    # Проверяем, что Core действительно запомнил адрес ModerationModule
    assert core.moderation_module() == mod.address