# proxy-kiro

Релей на чистом Node.js (Node 18+, **без зависимостей в runtime**) для Kiro / AWS CodeWhisperer.

Что он делает: локальный OmniRoute-клиент шлёт Kiro-запросы на этот релей, а релей
ретранслирует их на `https://codewhisperer.us-east-1.amazonaws.com/<path>` — то есть трафик
исходящего Kiro-запроса уходит с VPS, а не с вашего домашнего IP. Ответы
(включая SSE `text/event-stream`) стримятся без буферизации.

Маршруты:

| Маршрут | Поведение |
|---|---|
| `GET /health` | `{"ok":true}`, без авторизации, без upstream — для чек-попсов VPS |
| `/` | краткая JSON-сводка по использованию |
| `/kiro/<path>` | ретрансляция на `UPSTREAM/<path>`; обязателен заголовок `x-relay-key`, равный server-переменной `RELAY_KEY` |

Безопасность: сравнение ключа — timing-safe (`crypto.timingSafeEqual`), заголовок
`x-relay-key` **никогда не передаётся upstream** и **никогда не пишется в логи**.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | порт прослушивания |
| `HOST` | `0.0.0.0` | адрес привязки |
| `RELAY_KEY` | — | hex-секрет (64 символа); если не задан, `/kiro/*` отключён (403), `/health` работает |
| `UPSTREAM` | `https://codewhisperer.us-east-1.amazonaws.com` | база upstream |

## Деплой на VPS (Linux)

Нужен Node.js >= 18 (`node --version` проверить; на Debian/Ubuntu:
`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`).

```bash
sudo useradd -r -s /usr/sbin/nologin proxykiro   # выделенный пользователь (или используйте www-data)
sudo mkdir -p /opt/proxy-kiro
sudo git clone https://github.com/NikiTea/proxy-kiro /opt/proxy-kiro
cd /opt/proxy-kiro
sudo cp .env.example .env
sudo openssl rand -hex 32        # -> скопируйте вывод в RELAY_KEY в .env
sudo nano .env                   # RELAY_KEY=<сгенерированный hex>
sudo chown -R proxykiro: /opt/proxy-kiro && sudo chmod 600 /opt/proxy-kiro/.env
```

### Запуск через systemd (рекомендуется)

```bash
sudo cp relay.service /etc/systemd/system/proxy-kiro.service
# при необходимости смените User=www-data на User=proxykiro в unit-файле
sudo systemctl daemon-reload
sudo systemctl enable --now proxy-kiro
systemctl status proxy-kiro
journalctl -u proxy-kiro -f
```

### Альтернатива: pm2

```bash
npm i -g pm2
cd /opt/proxy-kiro
export $(grep -v '^#' .env | xargs)    # или: set -a; . ./.env; set +a
pm2 start server.js --name proxy-kiro
pm2 save && pm2 startup
```

Проверка после деплоя:

```bash
curl -s http://127.0.0.1:3000/health          # -> {"ok":true}
./smoke-test.sh                                # полный smoke-тест (нужен RELAY_KEY: set -a; . ./.env; set +a)
```

## Подключение OmniRoute

1. Постоянная переменная окружения на стороне клиента (OmniRoute):

   ```
   KIRO_RELAY_BASE_URL=http://<vps-ip>:<порт>/kiro
   ```

2. В соединении провайдера Kiro задайте кастомные заголовки нативно, без патчей кода:

   ```json
   "provider_specific_data": { "customHeaders": { "x-relay-key": "<RELAY_KEY>" } }
   ```

   То есть в JSON-конфиге OmniRoute поле `customHeaders` провайдера содержит ровно один
   заголовок `x-relay-key` со значением вашего `RELAY_KEY` (значение не печатать в отчётах).

3. Хост-оверрайд в `open-sse/executors/kiro.ts` (чтобы SWE-исполнители ходили через
   `KIRO_RELAY_BASE_URL`) — это отдельный патч клиентского кода и **не является частью
   этого репозитория**; он обрабатывается отдельно.

## Безопасность

- **Ротация ключа**: сгенерируйте новый (`openssl rand -hex 32`), обновите `RELAY_KEY`
  в `.env`, перезапустите сервис (`sudo systemctl restart proxy-kiro`), а затем поменяйте
  значение в `customHeaders` OmniRoute. Старый ключ перестаёт работать мгновенно.
- Заголовок `x-relay-key` не уходит upstream и не логируется.
- Открывайте в firewall только нужный порт (напр. `sudo ufw allow 3000/tcp`); при желании
  ограничьте доступ по IP или используйте Tailscale/VPN, чтобы порт вообще не был публичен.
- `.env` — секреты: `chmod 600`, владелец — сервисный пользователь; файл в `.gitignore`.
- Если порт публичный, держите обновлённый Node (релей тривиален, но база всё-таки).
