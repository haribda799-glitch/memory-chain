import boa

# Загружаем контракт из корня проекта
mod_module = boa.load("/home/ericozz/Works/memory-chain/src/ModerationModule.vy")

print("\n" + "=" * 40)
print(f"Контракт успешно развернут по адресу: {mod_module.address}")

# Вызываем чистую функцию модерации
is_hidden_result = mod_module.is_hidden(10, 20)
print(f"Результат работы is_hidden(10, 20): {is_hidden_result}")
print("=" * 40 + "\n")