# Base Mainnet (Chain ID: 8453) — Верификация смарт-контрактов Memory Chain

## 1. Статус верификации (Sourcify v2 & Blockscout `eth-bytecode-db`)

Оба боевых контракта верифицированы с полным совпадением байткода (`exact_match` / `FULL`):

| Контракт | Адрес (Base Mainnet, 8453) | Компилятор | EVM Version | Статус Sourcify v2 | Статус Blockscout DB |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`ModerationModule`** | `0xc25e0a5d32ded38ae39ebdae9323287460bf7426` | `vyper:0.4.3+commit.bff19ea2` | `cancun` | `exact_match` (`matchId: 58661235`) | `SUCCESS` (`FULL`) |
| **`MemoryChainCore`** | `0xB5467c3189907428a7feD5F7cb6C084AE8d743B2` | `vyper:0.4.3+commit.bff19ea2` | `cancun` | `exact_match` (`matchId: 58661246`) | `SUCCESS` (`FULL`) |

---

## 2. Готовые артефакты для мгновенной верификации на Basescan (`basescan.org`)

В этой директории находятся готовые файлы для верификации на `basescan.org` (или через Etherscan API V2 `https://api.etherscan.io/v2/api?chainid=8453`):

- `ModerationModule.standard-input.json` — Standard JSON Input для `ModerationModule`.
- `MemoryChainCore.standard-input.json` — Standard JSON Input для `MemoryChainCore`.
- `MemoryChainCore.constructor-args.txt` — ABI-кодированные аргументы конструктора `MemoryChainCore` (без префикса `0x`).

### Параметры для веб-формы `https://basescan.org/verifyContract`

1. **Compiler Type:** `Vyper (Standard-Json-Input)`
2. **Compiler Version:** `v0.4.3+commit.bff19ea2` *(в Moccasin v0.4.4 используется компилятор Vyper `0.4.3+commit.bff19ea2`, `evm_version: cancun`)*
3. **Open Source License Type:** `MIT License (MIT)` (`3`)
4. **Contract Name / Identifier:**
   - Для `ModerationModule`: `src/ModerationModule.vy:ModerationModule`
   - Для `MemoryChainCore`: `src/MemoryChainCore.vy:MemoryChainCore`
5. **Constructor Arguments ABI-encoded:**
   - Для `ModerationModule` (`0xc25e0a5d32ded38ae39ebdae9323287460bf7426`): *(оставить пустым — конструктор без аргументов)*
   - Для `MemoryChainCore` (`0xB5467c3189907428a7feD5F7cb6C084AE8d743B2`):
     ```text
     000000000000000000000000c25e0a5d32ded38ae39ebdae9323287460bf742600000000000000000000000000000000000000000000000000005af3107a400000000000000000000000000000000000000000000000000000005af3107a4000
     ```
     **Расшифровка аргументов конструктора `__init__(_moderation_module, _initial_candle_price, _initial_creation_fee)` (96 байт):**
     - `_moderation_module` (`address`): `0x000000000000000000000000c25e0a5d32ded38ae39ebdae9323287460bf7426` (`0xc25e0a5d32ded38ae39ebdae9323287460bf7426`)
     - `_initial_candle_price` (`uint256`): `0x00000000000000000000000000000000000000000000000000005af3107a4000` (`100000000000000` wei = `0.0001 ETH`)
     - `_initial_creation_fee` (`uint256`): `0x00000000000000000000000000000000000000000000000000005af3107a4000` (`100000000000000` wei = `0.0001 ETH`)

---

## 3. Автоматическая отправка на Basescan / Etherscan V2 через скрипт

Если добавить бесплатный ключ Etherscan API V2 в `.env`:

```env
BASESCAN_API_KEY=ваш_ключ_etherscan_v2
```

и выполнить:

```bash
./.venv/bin/python script/verify_mainnet.py
```

скрипт автоматически отправит оба контракта в `https://api.etherscan.io/v2/api?chainid=8453`.
