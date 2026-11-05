"""
script/deploy.py — Production-grade idempotent deployment script for Base L2 (Mainnet 8453 & Sepolia 84532).
Includes a live-network _reset_fork guard against RPC load-balancer block lag,
automatic recovery of already-deployed contracts (including ModerationModule from tx 0x70ec...b440),
smoke tests, Treasury transfer to Safe Multisig, and 2-step ownership transfer proposal.
"""
import json
import os
import time
from pathlib import Path
import boa
from moccasin.config import get_active_network
from src import ModerationModule, MemoryChainCore

# Начальные экономические параметры (Base L2)
INITIAL_CANDLE_PRICE = 100_000_000_000_000  # 0.0001 ETH
INITIAL_CREATION_FEE = 100_000_000_000_000  # 0.0001 ETH

EXPECTED_DEPLOYER_ADDRESS = "0x8395183D4188946c63199E01b9bDA19D774937C8"
MAINNET_SAFE_MULTISIG = "0x4C28A82cAafdaD1B8AfbC9d7aBF3a411fE2a768c"
SEPOLIA_SAFE_MULTISIG = "0x7D29Ae44D5041b59012e784818446088774305F5"
DEFAULT_SAFE_MULTISIG = MAINNET_SAFE_MULTISIG

# Уже развёрнутый ModerationModule в Base Mainnet (Chain ID: 8453)
MAINNET_MOD_DEPLOY_TX = "0x70ecb89328ba98d5a41cee748c0395bc60f31f04225b71be12c96b8b3343b440"
MAINNET_MODERATION_MODULE = "0xC25E0A5d32DED38ae39EbdAE9323287460Bf7426"
SEPOLIA_MODERATION_MODULE = "0x7120f05831bab3742b58a0a17e7a9b64789f30f3"

STATE_FILE_PATH = Path(__file__).resolve().parent.parent / ".mainnet_deploy_state.json"


def _load_deploy_state(chain_id) -> dict:
    if not STATE_FILE_PATH.exists():
        return {}
    try:
        data = json.loads(STATE_FILE_PATH.read_text(encoding="utf-8"))
        return data.get(str(chain_id), {})
    except Exception:
        return {}


def _save_deploy_state(chain_id, **updates) -> None:
    if chain_id is None:
        return
    try:
        all_data = {}
        if STATE_FILE_PATH.exists():
            all_data = json.loads(STATE_FILE_PATH.read_text(encoding="utf-8"))
        chain_key = str(chain_id)
        chain_state = all_data.get(chain_key, {})
        chain_state.update({k: v for k, v in updates.items() if v is not None})
        all_data[chain_key] = chain_state
        STATE_FILE_PATH.write_text(json.dumps(all_data, indent=2), encoding="utf-8")
    except Exception as err:
        print(f"[!] Не удалось сохранить локальный чекпоинт деплоя: {err}")


def patch_boa_live_env(chain_id=None, known_mod_Ref: list = None):
    """
    Защищает boa.env (NetworkEnv) на живой сети от падения в _reset_fork,
    когда сразу после майнинга блока запрос eth_getBlockByNumber(receipt['blockNumber'])
    попадает на отстающую ноду публичного RPC и возвращает None
    (TypeError: 'NoneType' object is not subscriptable).
    Также сразу логирует и сохраняет tx_hash и contractAddress до вызова _reset_fork.
    """
    env = boa.env
    if getattr(env, "is_fork_mode", False) or not hasattr(env, "_reset_fork"):
        return
    if getattr(env, "_mc_live_patched", False):
        return

    if hasattr(env, "suppress_debug_tt"):
        env.suppress_debug_tt(True)

    # 1. Мгновенное логирование и чекпоинт сразу после получения receipt (ДО _debug_tt и ДО _reset_fork)
    if hasattr(env, "_rpc") and hasattr(env._rpc, "wait_for_tx_receipt"):
        orig_wait_receipt = env._rpc.wait_for_tx_receipt

        def safe_wait_for_tx_receipt(tx_hash, timeout):
            receipt = orig_wait_receipt(tx_hash, timeout)
            if isinstance(receipt, dict) and receipt.get("status") == "0x1":
                r_hash = receipt.get("transactionHash") or tx_hash
                contract_addr = receipt.get("contractAddress")
                block_num = receipt.get("blockNumber")
                if contract_addr:
                    print(f"\n[✓] [TX MINED] Hash: {r_hash} | ContractAddress: {contract_addr} | Block: {block_num}")
                    mod_addr = known_mod_Ref[0] if known_mod_Ref else ""
                    if not mod_addr:
                        _save_deploy_state(
                            chain_id,
                            moderation_module_address=contract_addr,
                            moderation_deploy_tx=r_hash,
                        )
                    elif contract_addr.lower() != mod_addr.lower():
                        _save_deploy_state(
                            chain_id,
                            core_address=contract_addr,
                            core_deploy_tx=r_hash,
                        )
                else:
                    print(f"\n[✓] [TX MINED] Hash: {r_hash} | Block: {block_num}")
            return receipt

        env._rpc.wait_for_tx_receipt = safe_wait_for_tx_receipt

    # 2. Защищаем _rpc.fetch_uncached для eth_getBlockByNumber (чтобы AccountDBFork не получал None)
    if hasattr(env, "_rpc") and hasattr(env._rpc, "fetch_uncached"):
        orig_fetch_uncached = env._rpc.fetch_uncached

        def safe_fetch_uncached(method, params):
            res = orig_fetch_uncached(method, params)
            if method == "eth_getBlockByNumber" and res is None:
                for _ in range(5):
                    time.sleep(2)
                    res = orig_fetch_uncached(method, params)
                    if res is not None:
                        return res
                # Фоллбэк на 'latest' или 'safe', если конкретный номер блока ещё не индексирован нодой
                is_full_tx = params[1] if isinstance(params, list) and len(params) > 1 else False
                res = orig_fetch_uncached(method, ["latest", is_full_tx])
                if res is None:
                    time.sleep(2)
                    res = orig_fetch_uncached(method, ["safe", is_full_tx])
            return res

        env._rpc.fetch_uncached = safe_fetch_uncached

    # 2. Защищаем boa.env._reset_fork паузой 2 сек и перехватом TypeError с фоллбэком на 'latest' / 'safe'
    orig_reset_fork = env._reset_fork

    def safe_reset_fork(block_identifier="latest"):
        time.sleep(2)
        try:
            return orig_reset_fork(block_identifier=block_identifier)
        except TypeError as err:
            print(
                f"[!] [Boa Patch] _reset_fork({block_identifier}) столкнулся с задержкой ноды ({err}). "
                "Ожидание 2 сек и повтор со значением 'latest'..."
            )
            time.sleep(2)
            try:
                return orig_reset_fork(block_identifier="latest")
            except TypeError:
                time.sleep(2)
                try:
                    return orig_reset_fork(block_identifier="safe")
                except Exception as final_err:
                    print(f"[!] [Boa Patch] Пропуск сброса локального форка (не влияет на бродкаст): {final_err}")
                    return None

    env._reset_fork = safe_reset_fork

    # 3. Оборачиваем _send_txn, чтобы выводить и сохранять tx_hash / contractAddress мгновенно
    if hasattr(env, "_send_txn"):
        orig_send_txn = env._send_txn

        def safe_send_txn(*args, **kwargs):
            tx_data, receipt, trace = orig_send_txn(*args, **kwargs)
            tx_hash = receipt.get("transactionHash")
            contract_addr = receipt.get("contractAddress")
            block_num = receipt.get("blockNumber")
            if contract_addr:
                print(f"[✓] [TX MINED] Hash: {tx_hash} | ContractAddress: {contract_addr} | Block: {block_num}")
                mod_addr = known_mod_Ref[0] if known_mod_Ref else ""
                if not mod_addr:
                    _save_deploy_state(
                        chain_id,
                        moderation_module_address=contract_addr,
                        moderation_deploy_tx=tx_hash,
                    )
                elif contract_addr.lower() != mod_addr.lower():
                    _save_deploy_state(
                        chain_id,
                        core_address=contract_addr,
                        core_deploy_tx=tx_hash,
                    )
            else:
                print(f"[✓] [TX MINED] Hash: {tx_hash} | Block: {block_num}")
            return tx_data, receipt, trace

        env._send_txn = safe_send_txn

    env._mc_live_patched = True


def _get_code_with_retry(address: str, retries: int = 5) -> bytes:
    """Читает байткод контракта с повторами (защита от отставания ноды после деплоя)."""
    if not address:
        return b""
    for attempt in range(retries):
        try:
            if hasattr(boa.env, "_rpc"):
                raw_hex = boa.env._rpc.fetch("eth_getCode", [str(address), "latest"])
                if isinstance(raw_hex, str) and len(raw_hex) > 2:
                    return bytes.fromhex(raw_hex[2:])
            code = boa.env.get_code(str(address))
            if len(code) > 0:
                return code
        except Exception:
            pass
        if attempt < retries - 1:
            time.sleep(2)
    return b""


def _resolve_existing_mainnet_moderation_module(saved_state: dict) -> tuple[str, str]:
    """
    Проверяет наличие уже развёрнутого ModerationModule в Base Mainnet:
    1) Переменные окружения EXISTING_MODERATION_MODULE / MODERATION_MODULE_ADDRESS
    2) Сохранённый чекпоинт .mainnet_deploy_state.json
    3) Транзакция 0x70ecb89328ba98d5a41cee748c0395bc60f31f04225b71be12c96b8b3343b440 через RPC receipt
    4) Известный адрес MAINNET_MODERATION_MODULE (0xC25E0A5d32DED38ae39EbdAE9323287460Bf7426)
    Возвращает (address, source_description) или ("", "").
    """
    env_mod = (
        os.getenv("EXISTING_MODERATION_MODULE", "").strip()
        or os.getenv("MODERATION_MODULE_ADDRESS", "").strip()
    )
    if env_mod and len(_get_code_with_retry(env_mod, retries=2)) > 0:
        return env_mod, "env (EXISTING_MODERATION_MODULE / MODERATION_MODULE_ADDRESS)"

    state_mod = str(saved_state.get("moderation_module_address", "")).strip()
    if state_mod and len(_get_code_with_retry(state_mod, retries=2)) > 0:
        return state_mod, f"checkpoint ({ saved_state.get('moderation_deploy_tx', 'local') })"

    if hasattr(boa.env, "_rpc"):
        try:
            receipt = boa.env._rpc.fetch("eth_getTransactionReceipt", [MAINNET_MOD_DEPLOY_TX])
            if isinstance(receipt, dict) and receipt.get("status") == "0x1":
                tx_contract_addr = receipt.get("contractAddress")
                if tx_contract_addr and len(_get_code_with_retry(tx_contract_addr, retries=2)) > 0:
                    return tx_contract_addr, f"tx receipt {MAINNET_MOD_DEPLOY_TX}"
        except Exception as err:
            print(f"[!] Предупреждение при проверке receipt {MAINNET_MOD_DEPLOY_TX}: {err}")

    if len(_get_code_with_retry(MAINNET_MODERATION_MODULE, retries=2)) > 0:
        return MAINNET_MODERATION_MODULE, f"known mainnet address ({MAINNET_MOD_DEPLOY_TX})"

    return "", ""


def verify_target_contract(target_address: str, label: str):
    """Категория 4: Защита от передачи прав или связывания с пустым адресом."""
    code = _get_code_with_retry(target_address, retries=5)
    assert len(code) > 0, (
        f"FATAL: {label} по адресу {target_address} не имеет байткода в текущей сети!"
    )
    print(f"[✓] Pre-flight: {label} подтверждён ({len(code)} байт)")


def _exec_live_safe(fn, *args, label: str = "tx"):
    """Выполняет транзакцию с перехватом лага синхронизации _reset_fork публичной RPC-ноды."""
    try:
        return fn(*args)
    except TypeError as e:
        if "'NoneType' object is not subscriptable" in str(e):
            print(f"[!] Внимание ({label}): Boa столкнулся с задержкой RPC-ноды при обновлении форка.")
            print("[*] Транзакция была отправлена в сеть. Ожидаем синхронизацию (3 сек)...")
            time.sleep(3)
            return None
        raise e


def deploy():
    network = get_active_network()
    deployer = network.get_default_account()
    known_mod_ref = [""]

    # Активируем защиту boa.env._reset_fork для live-сети
    if network.name != "pyevm" and network.chain_id is not None:
        patch_boa_live_env(chain_id=network.chain_id, known_mod_Ref=known_mod_ref)

    saved_state = _load_deploy_state(network.chain_id)

    print(f"\n[*] Старт развертывания MemoryChain в сети: {network.name} (Chain ID: {network.chain_id})")
    print(f"[*] Аккаунт деплойера: {deployer.address}")

    if network.name == "pyevm" or network.chain_id is None:
        safe_multisig = boa.loads(
            "@external\n@payable\ndef __default__():\n    pass"
        ).address
        print("\n[1/5] Локальный деплой ModerationModule...")
        mod_module_address = ModerationModule.deploy().address
        known_mod_ref[0] = mod_module_address
    elif network.chain_id == 8453 or network.name == "base":
        # Base Mainnet (Chain ID: 8453)
        if deployer.address.lower() != EXPECTED_DEPLOYER_ADDRESS.lower():
            print(
                f"[!] Внимание: активный деплойер ({deployer.address}) отличается от "
                f"ожидаемого ({EXPECTED_DEPLOYER_ADDRESS})."
            )
        safe_multisig = os.getenv("SAFE_MULTISIG_ADDRESS", MAINNET_SAFE_MULTISIG).strip()
        mod_module_address, mod_source = _resolve_existing_mainnet_moderation_module(saved_state)
        if mod_module_address:
            print(f"\n[1/5] Подхвачен уже развёрнутый ModerationModule ({mod_source}):")
            print(f"[✓] ModerationModule (Base Mainnet): {mod_module_address}")
        else:
            print("\n[1/5] Деплой ModerationModule в Base Mainnet (8453)...")
            mod_module_address = ModerationModule.deploy().address
            print(f"[✓] ModerationModule развернут в Base Mainnet: {mod_module_address}")
        known_mod_ref[0] = mod_module_address
        _save_deploy_state(network.chain_id, moderation_module_address=mod_module_address)
    else:
        # Base Sepolia (Chain ID: 84532)
        safe_multisig = os.getenv("SAFE_MULTISIG_ADDRESS", SEPOLIA_SAFE_MULTISIG).strip()
        mod_module_address = (
            os.getenv("EXISTING_MODERATION_MODULE", "").strip()
            or os.getenv("MODERATION_MODULE_ADDRESS", SEPOLIA_MODERATION_MODULE).strip()
        )
        if len(_get_code_with_retry(mod_module_address, retries=2)) == 0:
            print("\n[1/5] Деплой ModerationModule в Base Sepolia...")
            mod_module_address = ModerationModule.deploy().address
            print(f"[✓] ModerationModule развернут: {mod_module_address}")
        else:
            print(f"\n[1/5] Подхвачен существующий ModerationModule: {mod_module_address}")
        known_mod_ref[0] = mod_module_address

    # 1. Pre-flight аудит Safe и Модуля модерации
    verify_target_contract(safe_multisig, "Совет Хранителей (Safe Multisig)")
    verify_target_contract(mod_module_address, "Модуль модерации (ModerationModule)")

    # 2. Деплой (или идемпотентный подхват) Ядра с передачей адреса модуля
    existing_core_addr = (
        os.getenv("EXISTING_CORE_ADDRESS", "").strip()
        or os.getenv("CORE_ADDRESS", "").strip()
        or str(saved_state.get("core_address", "")).strip()
    )
    if (
        network.name != "pyevm"
        and network.chain_id is not None
        and existing_core_addr
        and len(_get_code_with_retry(existing_core_addr, retries=2)) > 0
    ):
        print(f"\n[2/5] Подхвачен уже развёрнутый MemoryChainCore: {existing_core_addr}")
        if hasattr(boa.env, "_reset_fork"):
            boa.env._reset_fork("latest")
        core = MemoryChainCore.at(existing_core_addr)
    else:
        print(f"\n[2/5] Развертывание MemoryChainCore (связка с {mod_module_address})...")
        if hasattr(boa.env, "_reset_fork") and network.name != "pyevm":
            boa.env._reset_fork("latest")
        core = MemoryChainCore.deploy(
            mod_module_address,
            INITIAL_CANDLE_PRICE,
            INITIAL_CREATION_FEE,
        )
        _save_deploy_state(network.chain_id, core_address=core.address)
        print(f"[✓] MemoryChainCore развернут: {core.address}")

    # 3. Post-deploy Smoke Checks (Категория 3: Инварианты состояния)
    print("\n[3/5] Проверка корректности инициализации состояния...")
    assert core.moderation_module().lower() == mod_module_address.lower(), "Линковка модуля нарушена!"
    assert core.candle_price() == INITIAL_CANDLE_PRICE, "Неверная цена свечи!"
    assert core.creation_fee() == INITIAL_CREATION_FEE, "Неверная комиссия создания!"
    current_owner = core.owner()
    current_treasury = core.treasury()
    assert current_owner.lower() in (
        deployer.address.lower(),
        safe_multisig.lower(),
    ), f"Неожиданный владелец: {current_owner}"
    assert current_treasury.lower() in (
        deployer.address.lower(),
        safe_multisig.lower(),
    ), f"Неожиданная казна: {current_treasury}"
    print("[✓] Все smoke-проверки успешно пройдены")

    # 4. Передача Казны (Treasury) на адрес Safe Multisig (идемпотентно)
    if current_treasury.lower() == safe_multisig.lower():
        print(f"\n[4/5] Казна (treasury) уже установлена на Safe: {current_treasury}")
    else:
        print(f"\n[4/5] Установка адреса Казны (Treasury) на Safe: {safe_multisig}...")
        _exec_live_safe(core.set_treasury, safe_multisig, label="set_treasury")
        assert core.treasury().lower() == safe_multisig.lower(), "Казна не переведена на Safe!"
        print(f"[✓] Казна (treasury) успешно переведена на Safe: {core.treasury()}")

    # 5. Инициализация передачи прав владения (Owner) мультисигу (2-Step Ownership Transfer, идемпотентно)
    current_pending = core.pending_owner()
    if current_owner.lower() == safe_multisig.lower():
        print(f"\n[5/5] Safe уже является полноправным владельцем (owner): {current_owner}")
    elif current_pending.lower() == safe_multisig.lower():
        print(f"\n[5/5] Safe уже назначен как pending_owner: {current_pending}")
    else:
        print(f"\n[5/5] Инициирование передачи прав владения (propose_owner) на Safe: {safe_multisig}...")
        _exec_live_safe(core.propose_owner, safe_multisig, label="propose_owner")
        assert core.pending_owner().lower() == safe_multisig.lower(), "pending_owner не зафиксирован!"
        print(f"[✓] Safe назначен как pending_owner: {core.pending_owner()}")

    print("\n" + "=" * 72)
    print("  MEMORY CHAIN — ИТОГОВАЯ СВОДКА РАЗВЕРТЫВАНИЯ")
    print("=" * 72)
    print(f"  Сеть (Network):          {network.name} (Chain ID: {network.chain_id})")
    print(f"  Деплойер (EOA):          {deployer.address}")
    print(f"  ModerationModule:        {mod_module_address}")
    print(f"  MemoryChainCore:         {core.address}")
    print(f"  Казна (Treasury):        {core.treasury()} (АКТИВНА — Safe)")
    print(f"  Текущий Owner:           {core.owner()}")
    print(f"  Ожидающий Owner (Safe):  {core.pending_owner()}")
    print("-" * 72)
    print("  Конфигурация для frontend/.env:")
    print("  VITE_NETWORK=mainnet")
    print(f"  VITE_CONTRACT_ADDRESS={core.address}")
    print(f"  VITE_MODERATION_MODULE_ADDRESS={mod_module_address}")
    print("  VITE_COUNCIL_SAFE_ADDRESS=" + safe_multisig)
    print("-" * 72)
    print("  Примечание: Казна (treasury) УЖЕ переведена на Safe Multisig.")
    print("  Для завершения приёмки прав администратора Совет Хранителей (Safe)")
    print("  вызывает функцию accept_ownership() на контракте MemoryChainCore.")
    print("=" * 72 + "\n")

    return core


def moccasin_main():
    return deploy()
