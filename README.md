# Restaurant OS

A multi-restaurant management system. Each restaurant that buys it signs up, adds its own menu and gets:

- **Orders board** for the kitchen (New → Preparing → Ready → Completed), live-refreshing
- **Customer ordering page** at `/r/<restaurant-slug>` (pickup, delivery, or dine-in via per-table links `?table=<id>`), with order tracking
- **Menu, tables, sales reports, team roles** (owner, manager, staff) and settings (currency, tax)
- **AI Assistant**: one plain-English prompt changes the system ("Raise pizza prices by 5%", "Mark all desserts unavailable")
- **Audit log** of every change, whether made by a person or by the assistant

Every restaurant's data is isolated: each query is scoped to the signed-in restaurant.

## Install and run

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env      # then edit .env (see below)
npm start                 # http://localhost:3000
npm test                  # optional: end-to-end smoke test
```

Open `http://localhost:3000`, choose **Create restaurant**, then add categories and dishes in **Menu**.

## Configuration (.env)

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Long random string that signs logins. Generate with `openssl rand -hex 32`. Required in production. |
| `DB_PATH` | SQLite file location (default `./data/app.db`). Back this file up. |
| `ANTHROPIC_API_KEY` | Needed only for the Assistant tab. |
| `AGENT_MODEL` | Model the assistant uses (default `claude-sonnet-5-5`). |
| `PORT` | Server port (default 3000). |

## Deploying

Run it on a VPS (or any Node host) behind HTTPS, for example with a reverse proxy such as Caddy or nginx, and keep it alive with `pm2` or systemd. Put the `data/` folder on persistent storage. If you sit behind a proxy, add `app.set('trust proxy', 1)` in `src/server.js` so rate limiting sees real client IPs.

## How the assistant works

`src/agent.js` gives Claude a fixed set of tools (view menu, add/update items, change availability, adjust prices, tables, orders, reports, settings). Each tool calls the same functions in `src/services.js` that the dashboard uses, so the same validation and audit logging apply. Deliberate limits: it cannot delete anything, price changes are capped at ±50%, it is available to owners and managers only, and it asks a question instead of guessing when a request is ambiguous.

Add a new capability by adding a service function, then a tool definition and handler in `src/agent.js`.

## Project layout

```
src/db.js        database schema
src/services.js  all business rules (used by API and agent)
src/agent.js     AI agent and its tools
src/server.js    REST API, auth, rate limits, pages
public/          dashboard (admin.html/js) and customer page (order.html)
test/smoke.js    end-to-end test
```

## Known limits (good next steps)

Payments are not built in (orders are paid at the restaurant or on delivery); reports use UTC dates; SQLite suits one server, so move to PostgreSQL if you need several. Email/SMS notifications and password reset are not included yet.
