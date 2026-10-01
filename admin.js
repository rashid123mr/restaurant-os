const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = localStorage.getItem('token'), me = null, view = 'orders', biz = null, poll = null, authMode = 'login';
const money = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: (biz && biz.currency) || 'PKR' }).format(n);

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { logout(); throw new Error('Please sign in again'); }
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
const run = async (fn) => { try { await fn(); } catch (e) { toast(e.message, true); } };
const form = (f) => Object.fromEntries(new FormData(f));

function logout() { token = null; localStorage.removeItem('token'); clearInterval(poll); renderAuth(); }

/* ---------- auth ---------- */
function renderAuth() {
  const reg = authMode === 'register';
  $('#app').innerHTML = `<div class="auth"><div class="panel">
    <h1>Restaurant OS</h1><p class="muted">${reg ? 'Set up your restaurant. You will add your menu next.' : 'Sign in to manage your restaurant.'}</p>
    <div class="tabs"><button class="${reg ? '' : 'on'}" data-mode="login">Sign in</button><button class="${reg ? 'on' : ''}" data-mode="register">Create restaurant</button></div>
    <form id="authform">
      ${reg ? '<label>Restaurant name</label><input name="restaurant_name" required><label>Your name</label><input name="name" required>' : ''}
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Password ${reg ? '(8+ characters)' : ''}</label><input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}">
      <p><button class="go" style="width:100%">${reg ? 'Create restaurant' : 'Sign in'}</button></p>
    </form></div></div>`;
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { authMode = b.dataset.mode; renderAuth(); }));
  $('#authform').onsubmit = (e) => { e.preventDefault(); run(async () => { const d = await api(reg ? '/register' : '/login', 'POST', form(e.target)); token = d.token; localStorage.setItem('token', token); view = reg ? 'menu' : 'orders'; await boot(); }); };
}

/* ---------- shell ---------- */
const NAV = [['orders', 'Orders', 'staff'], ['menu', 'Menu', 'staff'], ['tables', 'Tables', 'staff'], ['reports', 'Reports', 'manager'], ['assistant', 'Assistant', 'manager'], ['settings', 'Team & settings', 'manager']];
const allowed = (min) => min === 'staff' || me.role !== 'staff';

async function boot() {
  try { me = await api('/me'); biz = me; } catch { return renderAuth(); }
  $('#app').innerHTML = `<div class="shell"><nav><div class="brand">${esc(me.name)}</div>
    ${NAV.filter((n) => allowed(n[2])).map((n) => `<button data-v="${n[0]}">${n[1]}</button>`).join('')}
    <div class="sp"></div><button id="out">Sign out</button></nav><main id="main"></main></div>`;
  document.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => go(b.dataset.v)));
  $('#out').onclick = logout;
  go(view);
}
function go(v) {
  view = v; clearInterval(poll);
  document.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  run(VIEWS[v]);
  if (v === 'orders') poll = setInterval(() => run(VIEWS.orders), 8000);
}

/* ---------- print receipt ---------- */
function printReceipt(o) {
  const w = window.open('', '_blank', 'width=400,height=600');
  const itemRows = o.items.map((i) => `<tr><td>${esc(i.name)}</td><td style="text-align:right">${i.qty} x ${money(i.price)}</td><td style="text-align:right">${money(i.qty * i.price)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><title>Receipt #${o.id}</title>
  <style>body{font-family:monospace;max-width:320px;margin:0 auto;padding:1rem;font-size:13px}
  h2,p{margin:4px 0}table{width:100%;border-collapse:collapse}td{padding:3px 0}
  .line{border-top:1px dashed #000;margin:8px 0}.total{font-weight:bold;font-size:15px}
  @media print{button{display:none}}</style></head>
  <body>
  <h2 style="text-align:center">${esc(o.restaurant ? o.restaurant.name : biz.name)}</h2>
  <p style="text-align:center">Receipt #${o.id}</p>
  <p style="text-align:center">${o.created_at ? o.created_at.slice(0,16).replace('T',' ') : ''}</p>
  <div class="line"></div>
  <p>Customer: ${esc(o.customer_name)}</p>
  <p>Type: ${o.type}${o.table_label ? ' · Table ' + esc(o.table_label) : ''}</p>
  ${o.phone ? `<p>Phone: ${esc(o.phone)}</p>` : ''}
  <div class="line"></div>
  <table><tr><th style="text-align:left">Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Amount</th></tr>
  ${itemRows}</table>
  <div class="line"></div>
  <table>
  <tr><td>Subtotal</td><td style="text-align:right">${money(o.subtotal)}</td></tr>
  <tr><td>Tax</td><td style="text-align:right">${money(o.tax)}</td></tr>
  <tr class="total"><td>Total</td><td style="text-align:right">${money(o.total)}</td></tr>
  </table>
  <div class="line"></div>
  <p style="text-align:center">Payment: <b>${o.payment_status || 'unpaid'}</b></p>
  <p style="text-align:center" class="muted">Thank you!</p>
  <p style="text-align:center"><button onclick="window.print()">🖨 Print</button></p>
  </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 500);
}

/* ---------- views ---------- */
const NEXT = { new: ['preparing', 'Start cooking'], preparing: ['ready', 'Mark ready'], ready: ['completed', 'Complete'] };
const VIEWS = {
  async orders() {
    const list = await api('/orders?limit=150');
    const col = (st, title) => {
      const xs = list.filter((o) => o.status === st).reverse();
      return `<div class="col"><h3>${title}<span class="pill">${xs.length}</span></h3>${xs.map((o) => `
        <div class="ticket st-${st}">
          <header><span>#${o.id} ${o.type === 'dine_in' ? 'Table ' + esc(o.table_label || '-') : o.type === 'pickup' ? 'Pickup' : 'Delivery'}</span><span>${money(o.total)}</span></header>
          <div class="muted">${esc(o.customer_name)}${o.phone ? ' · ' + esc(o.phone) : ''}${o.address ? '<br>' + esc(o.address) : ''}</div>
          <ul>${o.items.map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join('')}</ul>
          ${o.note ? `<div class="muted">Note: ${esc(o.note)}</div>` : ''}
          <div class="acts">
            <button class="go" data-status="${NEXT[st][0]}" data-id="${o.id}">${NEXT[st][1]}</button>
            ${st !== 'ready' ? `<button class="warn" data-status="cancelled" data-id="${o.id}">Cancel</button>` : ''}
          </div>
        </div>`).join('') || '<p class="muted">Nothing here.</p>'}</div>`;
    };
    const done = list.filter((o) => ['completed', 'cancelled'].includes(o.status)).slice(0, 20);
    $('#main').innerHTML = `<h1>Orders</h1><p class="muted">The board refreshes every few seconds.</p>
      <div class="board">${col('new', 'New')}${col('preparing', 'Preparing')}${col('ready', 'Ready')}</div>
      <h2 style="margin-top:1.5rem">Recently closed</h2>
      <div class="panel"><table>
        <tr><th>#</th><th>Customer</th><th>Total</th><th>Payment</th><th>Status</th><th></th></tr>
        ${done.map((o) => `<tr>
          <td>#${o.id}</td>
          <td>${esc(o.customer_name)}</td>
          <td>${money(o.total)}</td>
          <td><span class="pill ${o.payment_status === 'paid' ? 'paid' : 'unpaid'}">${o.payment_status || 'unpaid'}</span>
            ${o.status === 'completed' ? `<button class="ghost" style="margin-left:4px;padding:2px 8px;font-size:12px" data-pay="${o.id}" data-cur="${o.payment_status || 'unpaid'}">${o.payment_status === 'paid' ? 'Mark unpaid' : 'Mark paid'}</button>` : ''}
          </td>
          <td><span class="pill">${o.status}</span></td>
          <td><button class="ghost" style="padding:2px 8px;font-size:12px" data-receipt="${o.id}">🖨 Receipt</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">No closed orders yet.</td></tr>'}
      </table></div>`;
    $('#main').onclick = (e) => {
      const b = e.target.closest('[data-status]');
      if (b) run(async () => { await api('/orders/' + b.dataset.id, 'PATCH', { status: b.dataset.status }); VIEWS.orders(); });
      const p = e.target.closest('[data-pay]');
      if (p) run(async () => {
        const newStatus = p.dataset.cur === 'paid' ? 'unpaid' : 'paid';
        await api('/orders/' + p.dataset.pay + '/payment', 'PATCH', { payment_status: newStatus });
        toast(newStatus === 'paid' ? 'Marked as paid' : 'Marked as unpaid');
        VIEWS.orders();
      });
      const r = e.target.closest('[data-receipt]');
      if (r) run(async () => {
        const receipt = await api('/orders/' + r.dataset.receipt + '/receipt');
        printReceipt(receipt);
      });
    };
  },

  async menu() {
    const menu = await api('/menu'); const canEdit = me.role !== 'staff';
    $('#main').innerHTML = `<h1>Menu</h1>
      ${menu.length ? '' : '<div class="panel"><h2>Start your menu</h2><p class="muted">Add a category first, then add dishes.</p></div>'}
      ${canEdit ? `<div class="panel"><h3>Add a dish</h3><form id="itemform" class="row">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Price</label><input name="price" type="number" step="0.01" min="0" required></div>
        <div><label>Category</label><input name="category" list="cats" required placeholder="e.g. Mains"><datalist id="cats">${menu.map((c) => `<option>${esc(c.name)}</option>`).join('')}</datalist></div>
        <div style="flex:2 1 220px"><label>Description</label><input name="description"></div>
        <div style="flex:2 1 220px"><label>Image</label><input type="file" id="imgfile" accept="image/*" style="font-size:13px"><span id="imgstatus" class="muted" style="font-size:12px"></span><input type="hidden" name="image_url" id="imgurl"></div>
        <button class="go">Add dish</button></form></div>
        <div class="panel"><h3>Change all prices</h3><form id="priceform" class="row">
          <div><label>Percent (e.g. 5 or -10)</label><input name="percent" type="number" step="0.1" required></div>
          <div><label>Category (optional)</label><select name="category"><option value="">Whole menu</option>${menu.map((c) => `<option>${esc(c.name)}</option>`).join('')}</select></div>
          <button class="ghost">Apply</button>
        </form></div>` : ''}
      ${menu.map((c) => `<div class="panel"><h2>${esc(c.name)} ${canEdit && !c.items.length ? `<button class="warn" data-delcat="${c.id}" style="float:right">Delete category</button>` : ''}</h2>
        <table><tr><th>Image</th><th>Dish</th><th style="width:110px">Price</th><th>Available</th>${canEdit ? '<th></th>' : ''}</tr>
        ${c.items.map((i) => `<tr>
          <td style="width:60px">${i.image_url ? `<img src="${esc(i.image_url)}" style="width:50px;height:50px;object-fit:cover;border-radius:6px" alt="${esc(i.name)}">` : `<div style="width:50px;height:50px;background:var(--line);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--mute);font-size:20px">🍽</div>`}</td>
          <td>${esc(i.name)}<div class="muted">${esc(i.description)}</div>
            ${canEdit ? `<div style="margin-top:4px"><label style="font-size:12px;color:var(--mute)">Change image: <input type="file" accept="image/*" data-imgfor="${i.id}" style="font-size:11px"></label></div>` : ''}
          </td>
          <td>${canEdit ? `<input data-price="${i.id}" type="number" step="0.01" min="0" value="${i.price}">` : money(i.price)}</td>
          <td><input type="checkbox" data-avail="${i.id}" ${i.available ? 'checked' : ''} style="width:auto" aria-label="Available"></td>
          ${canEdit ? `<td><button class="warn" data-del="${i.id}">Delete</button></td>` : ''}
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No dishes yet.</td></tr>'}</table></div>`).join('')}`;

    // Image upload helper
    async function uploadImage(file, statusEl) {
      statusEl.textContent = 'Uploading…';
      try {
        const params = await api('/upload', 'POST', {});
        const fd = new FormData();
        fd.append('file', file);
        fd.append('api_key', params.apiKey);
        fd.append('timestamp', params.timestamp);
        fd.append('folder', params.folder);
        fd.append('signature', params.signature);
        const r = await fetch(`https://api.cloudinary.com/v1_1/${params.cloudName}/image/upload`, { method: 'POST', body: fd });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || 'Upload failed');
        statusEl.textContent = '✓ Uploaded';
        return j.secure_url;
      } catch (e) { statusEl.textContent = '✗ ' + e.message; throw e; }
    }

    const m = $('#main');
    if (canEdit) {
      // Image file picker for new item form
      $('#imgfile').onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const url = await uploadImage(file, $('#imgstatus')).catch(() => null);
        if (url) $('#imgurl').value = url;
      };
      $('#itemform').onsubmit = (e) => { e.preventDefault(); run(async () => { await api('/items', 'POST', form(e.target)); toast('Dish added'); VIEWS.menu(); }); };
      $('#priceform').onsubmit = (e) => { e.preventDefault(); if (confirm('Change prices as entered?')) run(async () => { const d = form(e.target); const r = await api('/prices/adjust', 'POST', d); toast(r.items_changed + ' prices updated'); VIEWS.menu(); }); };
    }
    m.onchange = async (e) => {
      const t = e.target;
      if (t.dataset.avail) run(async () => { await api('/items/' + t.dataset.avail, 'PATCH', { available: t.checked }); toast(t.checked ? 'Back on the menu' : 'Marked unavailable'); });
      if (t.dataset.price) run(async () => { await api('/items/' + t.dataset.price, 'PATCH', { price: t.value }); toast('Price saved'); });
      if (t.dataset.imgfor) {
        const file = t.files[0]; if (!file) return;
        const statusSpan = document.createElement('span');
        t.parentNode.appendChild(statusSpan);
        const url = await uploadImage(file, statusSpan).catch(() => null);
        if (url) { await api('/items/' + t.dataset.imgfor, 'PATCH', { image_url: url }); toast('Image updated'); VIEWS.menu(); }
      }
    };
    m.onclick = (e) => {
      const d = e.target.closest('[data-del]'), c = e.target.closest('[data-delcat]');
      if (d && confirm('Delete this dish? Past orders keep their record.')) run(async () => { await api('/items/' + d.dataset.del, 'DELETE'); VIEWS.menu(); });
      if (c) run(async () => { await api('/categories/' + c.dataset.delcat, 'DELETE'); VIEWS.menu(); });
    };
  },

  async tables() {
    const t = await api('/tables'); const canEdit = me.role !== 'staff';
    const base = location.origin + '/r/' + me.slug;
    $('#main').innerHTML = `<h1>Tables & ordering links</h1>
      <div class="panel"><h3>Your customer ordering page</h3><p><a href="${base}" target="_blank" rel="noopener">${base}</a></p><p class="muted">Put this link on your website or social pages. Each table has its own link below.</p></div>
      ${canEdit ? `<div class="panel"><form id="tform" class="row"><div><label>Table name</label><input name="label" required placeholder="e.g. T1"></div><div><label>Seats</label><input name="seats" type="number" min="1" value="2"></div><button class="go">Add table</button></form></div>` : ''}
      <div class="panel"><table><tr><th>Table</th><th>Seats</th><th>Link for this table</th><th></th></tr>${t.map((x) => `<tr><td>${esc(x.label)}</td><td>${x.seats}</td><td><a href="${base}?table=${x.id}" target="_blank" rel="noopener">${base}?table=${x.id}</a></td>${canEdit ? `<td><button class="warn" data-deltable="${x.id}">Delete</button></td>` : '<td></td>'}</tr>`).join('') || '<tr><td class="muted">No tables yet.</td></tr>'}</table></div>`;
    if (canEdit) $('#tform').onsubmit = (e) => { e.preventDefault(); run(async () => { await api('/tables', 'POST', form(e.target)); VIEWS.tables(); }); };
    $('#main').onclick = (e) => { const b = e.target.closest('[data-deltable]'); if (b) run(async () => { await api('/tables/' + b.dataset.deltable, 'DELETE'); VIEWS.tables(); }); };
  },

  async reports(range = 7) {
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - (range - 1) * 864e5).toISOString().slice(0, 10);
    const r = await api(`/reports/sales?from=${from}&to=${to}`);
    $('#main').innerHTML = `<h1>Sales report</h1><div class="row" style="max-width:360px"><select id="rng"><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></div>
      <p class="muted">${r.from} to ${r.to} (UTC). Cancelled orders excluded.</p>
      <div class="panel stat"><div><b>${money(r.revenue)}</b>Revenue</div><div><b>${r.orders}</b>Orders</div><div><b>${money(r.average_order)}</b>Average order</div></div>
      <div class="panel"><h3>Best sellers</h3><table><tr><th>Dish</th><th>Sold</th><th>Revenue</th></tr>${r.top_items.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${money(i.revenue)}</td></tr>`).join('') || '<tr><td class="muted">No sales in this period.</td></tr>'}</table></div>
      <div class="panel"><h3>By day</h3><table><tr><th>Day</th><th>Orders</th><th>Revenue</th></tr>${r.by_day.map((d) => `<tr><td>${d.day}</td><td>${d.orders}</td><td>${money(d.revenue)}</td></tr>`).join('') || '<tr><td class="muted">No data.</td></tr>'}</table></div>`;
    $('#rng').value = String(range); $('#rng').onchange = (e) => run(() => VIEWS.reports(Number(e.target.value)));
  },

  async assistant() {
    $('#main').innerHTML = `<h1>Assistant</h1><p class="muted">Describe a change in plain words. Examples: "Mark all desserts unavailable", "Raise pizza prices by 5%"</p>
      <div class="panel"><form id="aform"><textarea name="prompt" required maxlength="4000" placeholder="What should I change?"></textarea><p><button class="go" id="abtn">Run</button></p></form><div id="aout"></div></div>
      <div class="panel"><h3>Recent changes</h3><div id="log" class="muted">Loading…</div></div>`;
    const log = async () => { const l = await api('/audit'); $('#log').innerHTML = `<table>${l.slice(0, 12).map((x) => `<tr><td>${esc(x.created_at.slice(0, 16).replace('T', ' '))}</td><td><span class="pill">${esc(x.source)}</span></td><td>${esc(x.action)}</td></tr>`).join('')}</table>`; };
    $('#aform').onsubmit = (e) => { e.preventDefault(); const b = $('#abtn'); b.disabled = true; b.textContent = 'Working…'; run(async () => { try { const r = await api('/agent', 'POST', form(e.target)); $('#aout').innerHTML = `<div class="reply">${esc(r.reply)}</div>${r.actions.length ? `<p class="muted">${r.actions.length} change(s) applied.</p>` : ''}`; await log(); } finally { b.disabled = false; b.textContent = 'Run'; } }); };
    run(log);
  },

  async settings() {
    const s = await api('/me'); const isOwner = me.role === 'owner'; const staff = await api('/staff');
    const sheet = isOwner ? await api('/sheets').catch(() => null) : null;
    $('#main').innerHTML = `<h1>Team & settings</h1>
      <div class="panel"><h3>Restaurant</h3><form id="sform" class="row">
        <div><label>Name</label><input name="name" value="${esc(s.name)}" ${isOwner ? '' : 'disabled'}></div>
        <div><label>Currency code</label><input name="currency" value="${esc(s.currency)}" maxlength="5" ${isOwner ? '' : 'disabled'}></div>
        <div><label>Tax rate (%)</label><input name="tax_rate" type="number" step="0.01" min="0" value="${s.tax_rate}" ${isOwner ? '' : 'disabled'}></div>
        ${isOwner ? '<button class="go">Save changes</button>' : ''}
      </form></div>
      <div class="panel"><h3>Team</h3><table>${staff.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><span class="pill">${u.role}</span></td><td>${isOwner && u.role !== 'owner' ? `<button class="warn" data-rm="${u.id}">Remove</button>` : ''}</td></tr>`).join('')}</table></div>
      ${isOwner ? `<div class="panel"><h3>Add a team member</h3><form id="stform" class="row">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Email</label><input name="email" type="email" required></div>
        <div><label>Password (8+)</label><input name="password" type="password" minlength="8" required></div>
        <div><label>Role</label><select name="role"><option value="staff">Staff (orders, sold-out)</option><option value="manager">Manager (menu, reports, assistant)</option></select></div>
        <button class="go">Add</button></form></div>` : ''}
      ${isOwner ? `<div class="panel"><h3>Google Sheets Integration</h3>
        <p class="muted">Automatically log new and completed orders to a Google Sheet. You need a Google Service Account JSON key.</p>
        <form id="sheetform">
          <label>Google Sheet ID <span class="muted">(from the URL: spreadsheets/d/<b>THIS_PART</b>/edit)</span></label>
          <input name="sheet_id" required placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms" value="${sheet ? esc(sheet.sheet_id) : ''}">
          <label>Service Account JSON key</label>
          <textarea name="credentials" required placeholder='{"type":"service_account","project_id":"..."}' style="font-size:12px;height:120px">${sheet ? '(already saved — paste new key to update)' : ''}</textarea>
          <p class="row">
            <button class="go">Save & connect</button>
            ${sheet ? '<button type="button" class="warn" id="disconnectSheet">Disconnect</button>' : ''}
          </p>
        </form>
        ${sheet ? `<p class="muted" style="color:green">✓ Connected to sheet: ${esc(sheet.sheet_id)}</p>` : '<p class="muted">Not connected.</p>'}
      </div>` : ''}`;

    if (isOwner) {
      $('#sform').onsubmit = (e) => { e.preventDefault(); run(async () => { biz = await api('/settings', 'PUT', form(e.target)); toast('Saved'); }); };
      $('#stform').onsubmit = (e) => { e.preventDefault(); run(async () => { await api('/staff', 'POST', form(e.target)); VIEWS.settings(); }); };
      $('#sheetform').onsubmit = (e) => { e.preventDefault(); run(async () => {
        const d = form(e.target);
        if (d.credentials.startsWith('(already')) { toast('Paste a new JSON key to update, or leave as is', true); return; }
        await api('/sheets', 'POST', d); toast('Google Sheets connected!'); VIEWS.settings();
      }); };
      const disc = $('#disconnectSheet');
      if (disc) disc.onclick = () => { if (confirm('Disconnect Google Sheets?')) run(async () => { await api('/sheets', 'DELETE'); toast('Disconnected'); VIEWS.settings(); }); };
    }
    $('#main').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b && confirm('Remove this team member?')) run(async () => { await api('/staff/' + b.dataset.rm, 'DELETE'); VIEWS.settings(); }); };
  },
};

/* ---------- CSS for paid/unpaid pills ---------- */
const style = document.createElement('style');
style.textContent = `.pill.paid{background:#d1fae5;color:#065f46}.pill.unpaid{background:#fee2e2;color:#991b1b}`;
document.head.appendChild(style);

token ? boot() : renderAuth();
