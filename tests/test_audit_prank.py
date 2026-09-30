import boa

def test_only_owner_can_toggle_pause():
    mod = boa.load("src/ModerationModule.vy")
    owner = boa.env.generate_address()
    hacker = boa.env.generate_address()

    # Деплоим от имени owner
    with boa.env.prank(owner):
        core = boa.load("src/MemoryChainCore.vy", mod.address, 100_000_000_000_000, 100_000_000_000_000)

    # Хакер пытается включить паузу — вызов должен упасть
    with boa.reverts("Not owner"):
        with boa.env.prank(hacker):
            core.toggle_pause(True, False)