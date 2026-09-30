import boa

# Методы модуля boa.env
print(dir(boa.env))

# Создать тестовую среду и посмотреть методы объекта env
env = boa.env
print([n for n in dir(env) if not n.startswith('_')])