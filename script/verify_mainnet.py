"""
script/verify_mainnet.py — Верификация боевых смарт-контрактов Memory Chain в Base Mainnet (Chain ID: 8453).

Поддерживает:
1. Генерацию эталонных Standard JSON Input файлов и ABI-кодированных аргументов конструктора
   в директории deployments/base-mainnet-verification/.
2. Верификацию через Sourcify API v2 (https://sourcify.dev/server/v2/verify/8453/<address>) — без API-ключа.
3. Верификацию через центральный сервис верификации Blockscout (https://eth-bytecode-db.services.blockscout.com) — без API-ключа.
4. Верификацию через Etherscan API V2 / Basescan (https://api.etherscan.io/v2/api?chainid=8453),
   если в окружении (.env) задан BASESCAN_API_KEY или ETHERSCAN_API_KEY.
"""

import json
import os
import time
import urllib.request
from pathlib import Path

import boa
import requests

CHAIN_ID = 8453
BASE_MAINNET_RPC = os.getenv("BASE_MAINNET_RPC", "https://mainnet.base.org")

CONTRACTS = [
    {
        "name": "ModerationModule",
        "path": "src/ModerationModule.vy",
        "address": "0xc25e0a5d32ded38ae39ebdae9323287460bf7426",
        "creation_tx": "0x70ecb89328ba98d5a41cee748c0395bc60f31f04225b71be12c96b8b3343b440",
        "constructor_args_hex": "",
    },
    {
        "name": "MemoryChainCore",
        "path": "src/MemoryChainCore.vy",
        "address": "0xB5467c3189907428a7feD5F7cb6C084AE8d743B2",
        "creation_tx": "0x0c73151c3ed66eb4c180ba5fa7299e1b8653451949a8180c7574b0dbaa8c044c",
        # __init__(_moderation_module=0xc25e0a5d32ded38ae39ebdae9323287460bf7426,
        #          _initial_candle_price=100000000000000,
        #          _initial_creation_fee=100000000000000)
        "constructor_args_hex": (
            "000000000000000000000000c25e0a5d32ded38ae39ebdae9323287460bf7426"
            "00000000000000000000000000000000000000000000000000005af3107a4000"
            "00000000000000000000000000000000000000000000000000005af3107a4000"
        ),
    },
]

OUT_DIR = Path(__file__).resolve().parent.parent / "deployments" / "base-mainnet-verification"

HEADERS = {
    "User-Agent": "memory-chain-verifier/1.0 (https://github.com/haribda799-glitch/memory-chain)",
    "Content-Type": "application/json",
}


def rpc_call(method: str, params: list):
    req = urllib.request.Request(
        BASE_MAINNET_RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers=HEADERS,
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())["result"]


def export_standard_json_bundles() -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bundles = {}

    for c in CONTRACTS:
        deployer = boa.load_partial(c["path"])
        solc_json = deployer.solc_json
        bundles[c["name"]] = solc_json

        std_input_path = OUT_DIR / f"{c['name']}.standard-input.json"
        std_input_path.write_text(
            json.dumps(solc_json, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"[✓] Сохранён Standard JSON Input: {std_input_path}")

        if c["constructor_args_hex"]:
            ctor_path = OUT_DIR / f"{c['name']}.constructor-args.txt"
            ctor_path.write_text(c["constructor_args_hex"] + "\n", encoding="utf-8")
            print(f"[✓] Сохранены ABI-аргументы конструктора: {ctor_path}")

    return bundles


def verify_sourcify(bundles: dict):
    print("\n--- [1/3] Верификация через Sourcify API v2 (Chain ID: 8453) ---")
    for c in CONTRACTS:
        name = c["name"]
        addr = c["address"]
        raw_json = bundles[name]
        std_json = {
            "language": raw_json["language"],
            "sources": raw_json["sources"],
            "settings": raw_json["settings"],
        }
        compiler_ver = raw_json["compiler_version"].lstrip("v")
        payload = {
            "stdJsonInput": std_json,
            "compilerVersion": compiler_ver,
            "contractIdentifier": f"{c['path']}:{name}",
            "creationTransactionHash": c["creation_tx"],
        }

        post_url = f"https://sourcify.dev/server/v2/verify/{CHAIN_ID}/{addr}"
        r = requests.post(post_url, headers=HEADERS, json=payload, timeout=30)
        if r.status_code in (200, 202):
            vid = r.json().get("verificationId")
            if vid:
                for _ in range(15):
                    time.sleep(2)
                    sr = requests.get(
                        f"https://sourcify.dev/server/v2/verify/{vid}",
                        headers=HEADERS,
                        timeout=15,
                    )
                    sdata = sr.json()
                    if sdata.get("isJobCompleted"):
                        break
        elif r.status_code == 409:
            pass  # Already verified

        check = requests.get(
            f"https://sourcify.dev/server/v2/contract/{CHAIN_ID}/{addr}",
            headers=HEADERS,
            timeout=15,
        ).json()
        print(
            f"[✓] Sourcify {name} ({addr}): match={check.get('match')} "
            f"(creationMatch={check.get('creationMatch')}, runtimeMatch={check.get('runtimeMatch')}, "
            f"verifiedAt={check.get('verifiedAt')})"
        )


def verify_blockscout_bytecode_db(bundles: dict):
    print("\n--- [2/3] Верификация через Blockscout eth-bytecode-db (Chain ID: 8453) ---")
    for c in CONTRACTS:
        name = c["name"]
        addr = c["address"]
        raw_json = bundles[name]
        tx_data = rpc_call("eth_getTransactionByHash", [c["creation_tx"]])
        creation_input = tx_data["input"]

        std_json = {
            "language": raw_json["language"],
            "sources": raw_json["sources"],
            "settings": raw_json["settings"],
        }
        payload = {
            "bytecode": creation_input,
            "bytecodeType": "CREATION_INPUT",
            "compilerVersion": raw_json["compiler_version"],
            "input": json.dumps(std_json),
            "metadata": {
                "chainId": str(CHAIN_ID),
                "contractAddress": addr,
            },
        }
        r = requests.post(
            "https://eth-bytecode-db.services.blockscout.com/api/v2/verifier/vyper/sources:verify-standard-json",
            json=payload,
            timeout=30,
        )
        data = r.json()
        src = data.get("source") or {}
        print(
            f"[✓] Blockscout eth-bytecode-db {name} ({addr}): "
            f"status={data.get('status')}, matchType={src.get('matchType')}, "
            f"compilerVersion={src.get('compilerVersion')}"
        )


def verify_etherscan_v2(bundles: dict):
    print("\n--- [3/3] Верификация через Etherscan API V2 / Basescan (Chain ID: 8453) ---")
    api_key = (
        os.getenv("BASESCAN_API_KEY", "").strip()
        or os.getenv("ETHERSCAN_API_KEY", "").strip()
    )
    if not api_key:
        print(
            "[i] BASESCAN_API_KEY / ETHERSCAN_API_KEY не задан в .env — "
            "готовые файлы Standard JSON Input и конструктор-аргументы для мгновенной загрузки "
            "сохранены в deployments/base-mainnet-verification/."
        )
        return

    api_url = f"https://api.etherscan.io/v2/api?chainid={CHAIN_ID}"
    for c in CONTRACTS:
        name = c["name"]
        addr = c["address"]
        raw_json = bundles[name]
        compiler_short = raw_json["compiler_version"].lstrip("v").split("+")[0]

        form_data = {
            "module": "contract",
            "action": "verifysourcecode",
            "apikey": api_key,
            "chainid": str(CHAIN_ID),
            "codeformat": "vyper-json",
            "sourceCode": json.dumps(raw_json),
            "constructorArguments": c["constructor_args_hex"],
            "contractaddress": addr,
            "contractname": f"{c['path']}:{name}",
            "compilerversion": f"vyper:{compiler_short}",
            "optimizationUsed": "1",
            "licenseType": "3",  # MIT License
        }
        r = requests.post(api_url, data=form_data, timeout=30)
        res = r.json()
        print(f"[*] Basescan / Etherscan V2 {name}: {res}")


def main():
    bundles = export_standard_json_bundles()
    verify_sourcify(bundles)
    verify_blockscout_bytecode_db(bundles)
    verify_etherscan_v2(bundles)


def moccasin_main():
    main()


if __name__ == "__main__":
    main()
