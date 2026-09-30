// AI agent: turns one plain-English instruction into calls on the same services the dashboard uses.
// Safety design: no delete tools, price changes capped at +/-50%, every action is written to the audit log.
const Anthropic = require('@anthropic-ai/sdk');
const S = require('./services');

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const tools = [
  { name: 'get_menu', description: 'List all categories and menu items with ids, prices and availability. Call this before changing anything.', input_schema: obj({}) },
  { name: 'add_menu_item', description: 'Add a menu item. The category is created if it does not exist.', input_schema: obj({ name: { type: 'string' }, price: { type: 'number' }, category: { type: 'string' }, description: { type: 'string' } }, ['name', 'price', 'category']) },
  { name: 'update_menu_item', description: 'Change an item (by id or exact name): name, price, description, category or availability.', input_schema: obj({ item: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, description: { type: 'string' }, category: { type: 'string' }, available: { type: 'boolean' } }, ['item']) },
  { name: 'set_category_availability', description: 'Mark every item in a category available or unavailable.', input_schema: obj({ category: { type: 'string' }, available: { type: 'boolean' } }, ['category', 'available']) },
  { name: 'adjust_prices', description: 'Raise or lower prices by a percentage (-50 to 50), for one category or the whole menu.', input_schema: obj({ percent: { type: 'number' }, category: { type: 'string' } }, ['percent']) },
  { name: 'add_category', description: 'Create a menu category.', input_schema: obj({ name: { type: 'string' } }, ['name']) },
  { name: 'list_tables', description: 'List dining tables.', input_schema: obj({}) },
  { name: 'add_table', description: 'Add a dining table.', input_schema: obj({ label: { type: 'string' }, seats: { type: 'integer' } }, ['label']) },
  { name: 'list_orders', description: 'List recent orders, optionally filtered by status (new, preparing, ready, completed, cancelled).', input_schema: obj({ status: { type: 'string' } }) },
  { name: 'update_order_status', description: 'Move an order forward (new>preparing>ready>completed) or cancel it (only while new or preparing).', input_schema: obj({ id: { type: 'integer' }, status: { type: 'string', enum: ['preparing', 'ready', 'completed', 'cancelled'] } }, ['id', 'status']) },
  { name: 'sales_report', description: 'Revenue, order counts and top items for a date range (YYYY-MM-DD, UTC).', input_schema: obj({ from: { type: 'string' }, to: { type: 'string' } }) },
  { name: 'get_settings', description: 'Restaurant name, currency and tax rate.', input_schema: obj({}) },
  { name: 'update_settings', description: 'Change restaurant name, currency code or tax rate (percent).', input_schema: obj({ name: { type: 'string' }, currency: { type: 'string' }, tax_rate: { type: 'number' } }) },
];

const handlers = {
  get_menu: (c) => S.getMenu(c),
  add_menu_item: (c, i) => S.addItem(c, i),
  update_menu_item: (c, i) => S.updateItem(c, i),
  set_category_availability: (c, i) => S.setCategoryAvailability(c, i),
  adjust_prices: (c, i) => S.adjustPrices(c, i),
  add_category: (c, i) => S.addCategory(c, i),
  list_tables: (c) => S.listTables(c),
  add_table: (c, i) => S.addTable(c, i),
  list_orders: (c, i) => S.listOrders(c, { status: i.status, limit: 30 }),
  update_order_status: (c, i) => S.setOrderStatus(c, i),
  sales_report: (c, i) => S.salesReport(c, i),
  get_settings: (c) => S.getSettings(c),
  update_settings: (c, i) => S.updateSettings(c, i),
};

async function runAgent(ctx, prompt) {
  if (!process.env.ANTHROPIC_API_KEY) throw new S.HttpError(503, 'The assistant is not configured: set ANTHROPIC_API_KEY on the server');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new S.HttpError(400, 'Write an instruction (up to 4000 characters)');
  const client = new Anthropic();
  const restaurant = S.getSettings(ctx);
  const system = `You manage the restaurant "${restaurant.name}" (currency ${restaurant.currency}) through tools. Today is ${new Date().toISOString().slice(0, 10)}.
- Call get_menu (or the relevant list tool) before changing anything, so you use real names and ids.
- Do exactly what was asked. If the request is ambiguous or could affect many items in a way the owner may not intend, do not guess: ask one short clarifying question and make no changes.
- You cannot delete anything. If asked to, explain that deletion must be done in the dashboard, and offer to mark items unavailable instead.
- After acting, reply briefly with what changed (old and new values where relevant) and anything you could not do.`;
  const messages = [{ role: 'user', content: prompt.trim() }];
  const actions = [];
  for (let step = 0; step < 10; step++) {
    const res = await client.messages.create({ model: process.env.AGENT_MODEL || 'claude-sonnet-5-5', max_tokens: 2000, system, tools, messages });
    messages.push({ role: 'assistant', content: res.content });
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) {
      return { reply: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), actions };
    }
    const results = calls.map((b) => {
      try {
        const out = handlers[b.name](ctx, b.input || {});
        if (!b.name.startsWith('get_') && !b.name.startsWith('list_') && b.name !== 'sales_report') actions.push({ tool: b.name, input: b.input });
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out ?? { ok: true }) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify({ error: e.message }), is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'I stopped after too many steps. Check the menu to see what was applied, then try a smaller request.', actions };
}

module.exports = { runAgent, tools, handlers };
