# ArNS Domain Setup — Пошаговая инструкция

Регистрация постоянного (permabuy) домена для MemoryChain через ArNS (Arweave Name System).

> **Все платежи разовые.** Никаких подписок, продлений, рекуррентных платежей.

---

## Что такое ArNS?

ArNS — это децентрализованная система имён на Arweave (аналог ENS для Ethereum). Купленное имя (`yourname.ar.io`) привязывается к Arweave TX ID вашего сайта.

- **Permabuy** = покупка навсегда, без продления
- **ANT** (Arweave Name Token) = токен владения именем, позволяет обновлять запись

---

## Шаг 1: Установите ArConnect

[ArConnect](https://www.arconnect.io/) — расширение-кошелёк для Arweave (аналог MetaMask для AR).

1. Установите расширение из [Chrome Web Store](https://chromewebstore.google.com/detail/arconnect/einnioafmpimabjcddiinlhmijaionap)
2. Создайте новый кошелёк или импортируйте существующий (JWK файл)
3. Запишите seed-фразу в безопасное место

---

## Шаг 2: Получите ARIO токены

Для покупки ArNS имени нужны **ARIO** (ранее IO) токены.

Способы получения:
- **Централизованные биржи**: проверьте листинги на [CoinGecko](https://www.coingecko.com/en/coins/ar-io)
- **DEX на Arweave**: через Permaswap или другие Arweave DEX
- **Fiat на ArNS портале**: на arns.ar.io можно оплатить Turbo Credits (через карту), которые конвертируются в ARIO при покупке

---

## Шаг 3: Зарегистрируйте ArNS имя (Permabuy)

1. Перейдите на **[arns.ar.io](https://arns.ar.io)**
2. Подключите ArConnect кошелёк
3. Введите желаемое имя (например: `memorychain`, `petmemorial`)
4. **Выберите "Permabuy"** — НЕ lease!
5. Проверьте стоимость (зависит от длины имени и текущего спроса)
6. Подтвердите транзакцию в ArConnect

После покупки вы получите **ANT (Arweave Name Token)** — это ваш токен управления именем.

> **Ценообразование**: Имена 10+ символов стоят ~10-50 ARIO. Короткие имена значительно дороже. Актуальные цены видны на портале.

---

## Шаг 4: Задеплойте фронтенд на Arweave

```bash
# 1. Соберите фронтенд
cd frontend && npm run build

# 2. Убедитесь, что arweave-wallet.json на месте
# (JWK файл из ArConnect — экспорт через Settings → Export)

# 3. Установите зависимости деплой-скрипта
cd ../deploy && npm init -y && npm install @ardrive/turbo-sdk

# 4. Запустите деплой
ARWEAVE_WALLET_PATH=../arweave-wallet.json node deploy_site.mjs
```

Скрипт выведет **Manifest ID** — это TX ID вашего сайта на Arweave.

```
✅ Deployed to Arweave!
   Manifest ID: dE0rmDfl9_OWjkDznNEXHaSO_JohJkRolvMzaCroUdw
   Live at:     https://arweave.net/dE0rmDfl9_OWjkDznNEXHaSO_JohJkRolvMzaCroUdw
```

> **Стоимость**: Зависит от размера бандла. Для ~150 KB gzipped сайта — несколько центов в Turbo Credits.

---

## Шаг 5: Привяжите ArNS имя к Manifest ID

### Через портал (GUI)
1. Перейдите на [arns.ar.io](https://arns.ar.io)
2. Откройте своё имя в разделе "My Names"
3. Нажмите "Update Record"
4. Вставьте Manifest ID из шага 4
5. Подтвердите в ArConnect

### Программно (через @ar.io/sdk)
```javascript
import { ANT } from '@ar.io/sdk';

const ant = await ANT.init({
  processId: 'YOUR_ANT_PROCESS_ID', // из покупки на arns.ar.io
  signer: yourWalletSigner,
});

const { id: txId } = await ant.setBaseNameRecord({
  transactionId: 'YOUR_MANIFEST_TX_ID', // из deploy_site.mjs
  ttlSeconds: 3600,
});

console.log(`Record updated! TX: ${txId}`);
// Сайт доступен по: https://yourname.ar.io
```

---

## Шаг 6: Обновление сайта (редеплой)

При обновлении фронтенда:

1. Пересоберите: `cd frontend && npm run build`
2. Задеплойте: `node deploy/deploy_site.mjs` → получите новый Manifest ID
3. Обновите ANT запись (шаг 5) на новый Manifest ID

ArNS имя остаётся прежним. Обновляется только указатель.

> **Стоимость редеплоя**: только оплата за загрузку нового бандла (Turbo Credits). Обновление ANT записи — бесплатно (газ Arweave минимален).

---

## Итого: разовые платежи

| Компонент | Тип оплаты | Подписка |
|-----------|-----------|----------|
| ArNS имя (permabuy) | Разовый (ARIO) | ❌ Навсегда |
| Загрузка сайта (Turbo) | Разовый (Turbo Credits) | ❌ Per-upload |
| Обновление ANT записи | Бесплатно | ❌ |
| ArConnect кошелёк | Бесплатно | ❌ |

**Никаких подписок. Никаких серверов. Навсегда.**
