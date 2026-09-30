import boa

def test_successful_ownership_transfer():
    # Генерируем тестовые аккаунты в памяти Titanoboa
    deployer = boa.env.generate_address()
    alice = boa.env.generate_address()

    # Деплоим контракты от имени deployer
    with boa.env.prank(deployer):
        mod = boa.load("/home/ericozz/Works/memory-chain/src/ModerationModule.vy")
        core = boa.load("/home/ericozz/Works/memory-chain/src/MemoryChainCore.vy", mod.address, 100_000_000_000_000, 100_000_000_000_000)

    # 1. Назначаем Alice кандидатом
    with boa.env.prank(deployer):
        core.propose_owner(alice)
        assert core.pending_owner() == alice

    # 2. Alice принимает права
    with boa.env.prank(alice):
        core.accept_ownership()

    # 3. Проверяем смену владельца и сброс pending_owner
    assert core.owner() == alice
    assert core.pending_owner() == "0x0000000000000000000000000000000000000000"

if __name__ == "__main__":
    test_successful_ownership_transfer()
    print("Успешная передача прав протестирована!")