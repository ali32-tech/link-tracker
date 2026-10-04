(() => {
'use strict';

const CFG = window.TRACKER_CONFIG || {};
const app = document.getElementById('app');
const $ = (s, r = document) => r.querySelector(s);

// ---------- constants & helpers ----------
const ST = {
  boss_review: { label: 'Under Review', cls: 'amber' },
  approved: { label: 'Approved', cls: 'blue' },
  rejected: { label: 'Rejected', cls: 'red' },
  link_ready: { label: 'Link Ready', cls: 'violet' },
  sent: { label: 'Sent to Website', cls: 'blue' },
  live: { label: 'Live', cls: 'green' },
  invoice_received: { label: 'Invoice Received', cls: 'amber' },
  paid: { label: 'Paid', cls: 'green' },
};
const LIVE_STATUSES = ['live', 'invoice_received', 'paid'];
const REJECT_REASONS = ['Already has our link', "Don't like it", 'Too expensive', 'Low traffic', 'Other'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normDomain = u => String(u || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#:].*$/, '');
const money = n => (n == null || n === '' ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const num = v => { v = String(v ?? '').trim(); return v === '' || isNaN(+v) ? null : +v; };
const txt = v => { v = String(v ?? '').trim(); return v === '' ? null : v; };
const dealLabel = d => (d === 'paid' ? 'Paid' : 'Exchange');
const pill = w => `<span class="pill ${ST[w.status].cls}">${ST[w.status].label}</span>`;
const href = u => (/^https?:\/\//i.test(u) ? u : 'https://' + u);
const lnk = u => (u ? `<a href="${esc(href(u))}" target="_blank" rel="noopener">${/\/storage\/v1\/object\/public\/invoices\//.test(u) ? 'Invoice PDF' : esc(u.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 60))}</a>` : '—');
const ymNow = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const hist = w => w.link_history || [];
const linkNo = w => hist(w).length + 1;
const roundDone = w => (w.deal_type === 'paid' && w.status === 'paid') || (w.deal_type === 'exchange' && w.status === 'live' && w.their_link_live);
const ownBoss = w => !!S.profile && S.profile.role === 'boss' && w.member_id === S.profile.id;
const nextPossible = w => roundDone(w) && (ownBoss(w) || linkNo(w) < (w.possible_links || 0));
const rateOf = p => (p.rate != null && p.rate !== '' ? +p.rate : p.role === 'manager' ? S.bossRate : S.teamRate);
const liveCount = (w, ym) =>
  (LIVE_STATUSES.includes(w.status) && (w.live_date || '').startsWith(ym) ? 1 : 0) +
  hist(w).filter(h => (h.live_date || '').startsWith(ym)).length;
const errMsg = e => (e && e.code === '23505' ? 'This website is already in the tracker.' : (e && e.message) || 'Something went wrong');

const S = {
  session: null, revOpen: false, wsOpen: false, mineOpen: true, mwOpen: true, profile: null, sites: [], trash: [], people: [], invites: [], teamRate: 7, bossRate: 10,
  nav: 'home', mf: { status: '', member: '', deal: '', q: '' }, mem: { f: 'all', q: '' }, bossQ: '',
  month: ymNow(), preview: null, drawer: null, chan: null,
};
let sb = null, armed = null, refreshTimer = null;

function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copied');
}

// ---------- effective user (supports Manager "Preview as…") ----------
const eff = () => (S.preview ? S.preview : S.profile);
const readOnly = () => !!S.preview;
const visibleSites = () => (eff().role === 'member' ? S.sites.filter(w => w.member_id === eff().id) : S.sites);
const memberName = id => {
  if (S.profile && id === S.profile.id) return S.profile.name || S.profile.email;
  const p = S.people.find(x => x.id === id);
  return p ? p.name || p.email : 'Unknown';
};

// ---------- data ----------
async function loadData() {
  const role = S.profile.role;
  const jobs = [sb.from('websites').select('*').order('updated_at', { ascending: false })];
  jobs.push(sb.from('settings').select('team_rate').maybeSingle());
  if (role !== 'member') jobs.push(sb.from('profiles').select('id,name,email,role,rate'));
  if (role === 'boss') jobs.push(sb.from('private_settings').select('boss_rate').maybeSingle());
  if (role === 'manager') {
    jobs.push(sb.from('private_settings').select('boss_rate').maybeSingle());
    jobs.push(sb.from('invites').select('*').order('created_at', { ascending: false }));
  }
  const res = await Promise.all(jobs);
  const w = res.shift();
  if (w.error) return toast(errMsg(w.error), 'err');
  S.sites = w.data.filter(x => !x.deleted_at);
  S.trash = ['boss', 'member'].includes(S.profile.role) ? w.data.filter(x => x.deleted_at) : [];
  { const s = res.shift(); if (s.data) S.teamRate = +s.data.team_rate; }
  if (role !== 'member') {
    let p = res.shift();
    if (p.error) p = await sb.from('profiles').select('id,name,email,role');
    S.people = p.data || [];
  }
  if (role === 'boss') { const b = res.shift(); if (b.data) S.bossRate = +b.data.boss_rate; }
  if (role === 'manager') {
    const b = res.shift(); if (b.data) S.bossRate = +b.data.boss_rate;
    S.invites = res.shift().data || [];
    const bosses = new Set(S.people.filter(p => p.role === 'boss').map(p => p.id));
    S.sites = S.sites.filter(x => !bosses.has(x.member_id));
  }
}

function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!S.profile) return;
    await loadData();
    render();
    if (S.drawer && S.drawer.kind === 'detail') {
      const w = S.sites.find(x => x.id === S.drawer.id);
      w ? openDetail(w.id) : closeDrawer();
    }
  }, 200);
}

async function upd(id, patch, msg) {
  const { error } = await sb.from('websites').update(patch).eq('id', id);
  if (error) return toast(errMsg(error), 'err'), false;
  toast(msg || 'Saved');
  closeDrawer();
  refreshSoon();
  return true;
}

// ---------- auth flow ----------
function showLogin(message, kind) {
  S.profile = null;
  const m = S.mode || 'in';
  const titles = { in: ['Welcome back', 'Sign in to your workspace.'], up: ['Create your account', 'Use the email your team invited.'], reset: ['Reset password', "We'll email you a reset link."] };
  const pw = (label, ac) => `<label>${label}</label><div class="pwrow"><input type="password" name="password" required minlength="6" autocomplete="${ac}" placeholder="At least 6 characters"><button type="button" class="btn sm" data-act="showpw" tabindex="-1">Show</button></div>`;
  const email = `<label>Email</label><input type="email" name="email" required autocomplete="email" placeholder="you@example.com" autofocus>`;
  const form = {
    in: `<form data-form="login">${email}${pw('Password', 'current-password')}<div class="authlinks"><a href="#" data-act="mode" data-v="reset">Forgot password?</a></div>
      <button class="btn primary big" type="submit">Sign in</button></form>
      <p class="switch">New here? <a href="#" data-act="mode" data-v="up">Create an account</a></p>`,
    up: `<form data-form="signup">${email}${pw('Choose a password', 'new-password')}<button class="btn primary big" type="submit" style="margin-top:14px">Create account</button></form>
      <p class="switch">Already have an account? <a href="#" data-act="mode" data-v="in">Sign in</a></p>`,
    reset: `<form data-form="reset">${email}<button class="btn primary big" type="submit" style="margin-top:14px">Send reset link</button></form>
      <p class="switch"><a href="#" data-act="mode" data-v="in">Back to sign in</a></p>`,
  }[m];
  app.innerHTML = `<div class="auth"><div class="auth-card"><img class="auth-logo" src="flipbite-logo.png" alt="FlipBite">
    <div class="auth-brand">FlipBite</div>
    <h1>${titles[m][0]}</h1><p class="lead">${titles[m][1]}</p>
    ${message ? `<div class="notice ${kind === 'err' ? 'err' : ''}">${esc(message)}</div>` : ''}${form}</div></div>`;
}

function showNewPassword() {
  app.innerHTML = `<div class="center"><div class="panel"><img src="flipbite-logo.png" alt="FlipBite" style="width:56px;height:56px;display:block;margin-bottom:8px"><h1>Set a new password</h1>
    <form data-form="newpw"><label>New password</label><input type="password" name="password" required minlength="6" autocomplete="new-password" autofocus>
    <div style="margin-top:14px"><button class="btn primary big" type="submit">Save password</button></div></form></div></div>`;
}

function showName() {
  app.innerHTML = `<div class="center"><div class="panel"><h1>Welcome</h1><p>What name should we show for you?</p>
    <form data-form="name"><label>Display name</label><input name="name" required maxlength="60" autofocus>
    <div style="margin-top:14px"><button class="btn primary big" type="submit">Continue</button></div></form></div></div>`;
}

async function boot() {
  const getProfile = () => sb.from('profiles').select('*').eq('id', S.session.user.id).maybeSingle();
  let { data: p, error } = await getProfile();
  if (!error && !p) { await sb.rpc('claim_profile'); ({ data: p, error } = await getProfile()); }
  if (error || !p) { app.innerHTML = `<div class="center"><div class="panel"><h1>No access</h1><p>Your account has no profile yet. Ask the Manager to invite ${esc(S.session.user.email)}.</p><button class="btn" data-act="logout">Sign out</button></div></div>`; return; }
  S.profile = p;
  if (p.role === 'boss' && !S.navInit) { S.nav = 'mine'; S.navInit = true; }
  if (p.role === 'manager' && !S.navInit) { S.mineOpen = false; S.navInit = true; }
  if (!p.name) return showName();
  await loadData();
  if (S.chan) sb.removeChannel(S.chan);
  S.chan = sb.channel('websites-live').on('postgres_changes', { event: '*', schema: 'public', table: 'websites' }, refreshSoon).subscribe();
  render();
}

// ---------- shared UI pieces ----------
function header() {
  const e = S.profile;
  let previewSel = '';
  if (e.role === 'manager') {
    const opt = r => S.people.filter(p => p.role === r).map(p => `<option value="${p.id}" ${S.preview && S.preview.id === p.id ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('');
    previewSel = `<select data-change="preview" style="width:auto" aria-label="Preview as"><option value="">Preview as…</option>${opt('boss')}${opt('member')}</select>`;
  }
  return `<div class="top"><a class="brand" href="./" style="text-decoration:none"><img src="flipbite-logo.png" alt="FlipBite">FlipBite</a>
    ${previewSel}${S.preview ? `<span class="tag">${esc(e.name)}</span>` : `<input class="myname" data-change="myname" value="${esc(e.name)}" maxlength="60" aria-label="Your name (click to edit)" title="Click to edit your name">`}
    <button class="btn sm" data-act="logout">Sign out</button></div>
    ${S.preview ? `<div class="banner">Previewing as <b>${esc(S.preview.name || S.preview.email)}</b> Read-only.
      <button class="btn sm" data-act="exitpreview">Exit preview</button></div>` : ''}`;
}

function kvRows(rows) {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function detailHtml(w) {
  const rows = [
    ['Website', lnk(w.url)], ['Member', esc(memberName(w.member_id))], ['Contact', esc(w.contact_email || '—')],
    ['Deal', dealLabel(w.deal_type)], ['Price', money(w.price)], ['DR / Traffic', `${w.da ?? '—'} / ${w.traffic ?? '—'}`],
    ['Status', pill(w)], ...(w.change_request ? [['Change requested', esc(w.change_request)]] : []), ...(queueOf(w).length ? [['Queued links', ['boss', 'manager'].includes(eff().role) ? queueOf(w).map((x, i) => `${i + 1}. ${esc(x.anchor_text)} → ${esc(x.target_url)}`).join('<br>') : queueOf(w).length]] : []), ...(ownBoss(w) ? [['Current link', `${linkNo(w)}`]] : [['Possible links', w.possible_links ?? '—'], ['Current link', `${linkNo(w)} / ${w.possible_links ?? '?'}`]]),
    ['Target URL', lnk(w.target_url)], ['Anchor text', esc(w.anchor_text || '—')],
  ];
  if (w.status === 'rejected') rows.push(['Reject reason', esc(w.reject_reason || '—')]);
  rows.push(['Live URL', lnk(w.live_url)]);
  if (w.deal_type === 'exchange') rows.push(['Their link', `${lnk(w.their_link)}${w.their_link_live ? ' (live)' : ''}`]);
  else rows.push(['Invoice', lnk(w.invoice_url)]);
  rows.push(['Live date', w.live_date || '—'], ['Paid date', w.paid_date || '—'], ['Notes', esc(w.notes || '—')], ['Added', (w.created_at || '').slice(0, 10)]);
  const entry = (n, x, tag) => `<div class="hist"><b>Link ${n}</b> · ${esc(x.anchor_text || '')} ${tag}<br>
    Target: ${lnk(x.target_url)}<br>Live: ${lnk(x.live_url)}${x.live_date ? ' · ' + esc(x.live_date) : ''}
    ${x.price != null ? `<br>Price: ${money(x.price)}` : ''}</div>`;
  const all = hist(w).map((x, i) => entry(i + 1, x, '<span class="pill green">Done</span>'));
  if (w.target_url) all.push(entry(hist(w).length + 1, w, pill(w)));
  const h = all.join('');
  return kvRows(rows) + (h ? `<h2 style="font-size:15px">All links (${all.length})</h2>${h}` : '');
}

function openDrawer(title, body, kind, id) {
  S.drawer = { kind, id };
  $('#drawer-root').innerHTML = `<div class="overlay" data-act="close"></div>
    <aside class="drawer" role="dialog" aria-modal="true"><header><h3>${esc(title)}</h3>
    <button class="x" data-act="close" aria-label="Close">×</button></header><div class="body">${body}</div></aside>`;
}
function closeDrawer() { S.drawer = null; $('#drawer-root').innerHTML = ''; }

function openDetail(id) {
  const w = S.sites.find(x => x.id === id);
  if (!w) return;
  const role = eff().role;
  let extra = '';
  if (role === 'manager') {
    const own = w.member_id === S.profile.id && !S.preview;
    const step = !own ? '' : w.status === 'link_ready' ? `<button class="btn" data-act="copymsg" data-id="${w.id}">Copy message for website</button><button class="btn primary" data-act="sentbtn" data-id="${w.id}">Link sent to website</button>`
      : w.status === 'sent' ? `<button class="btn primary" data-act="livebtn" data-id="${w.id}">Link is live</button><button class="btn" data-act="reqchange" data-id="${w.id}">${w.change_request ? 'Edit request' : 'Request change'}</button>` : '';
    extra = `<div class="btns" style="margin-top:14px">${step}${own ? `<button class="btn" data-act="edit" data-id="${w.id}">Edit</button>` : ''}<button class="btn danger" data-act="del" data-id="${w.id}">Delete</button></div>`;
  }
  openDrawer(w.domain, detailHtml(w) + extra, 'detail', w.id);
}

// ---------- Manager ----------
function managerView() {
  return S.nav === 'commission' ? commissionView() : S.nav === 'settings' ? settingsView() : managerSites();
}

function managerSites() {
  const f = S.mf, all = S.sites.filter(w => w.member_id !== S.profile.id);
  const q = f.q.trim().toLowerCase();
  const rows = all.filter(w => (!f.status || w.status === f.status) && (!f.member || w.member_id === f.member) &&
    (!f.deal || w.deal_type === f.deal) && (!q || w.domain.includes(q) || (w.contact_email || '').toLowerCase().includes(q)));
  const members = S.people.filter(p => p.role === 'member');
  return `<div class="toolbar"><input type="search" id="mq" placeholder="Search website or email" value="${esc(f.q)}" data-input="mq">
      <select data-change="mmember"><option value="">All members</option>${members.map(m => `<option value="${m.id}" ${f.member === m.id ? 'selected' : ''}>${esc(m.name || m.email)}</option>`).join('')}</select>
      <select data-change="mdeal"><option value="">All deals</option><option value="exchange" ${f.deal === 'exchange' ? 'selected' : ''}>Exchange</option><option value="paid" ${f.deal === 'paid' ? 'selected' : ''}>Paid</option></select>
      ${f.status || f.member || f.deal || f.q ? '<button class="btn sm" data-act="clearf">Clear filters</button>' : ''}</div>
    <div class="btns" style="margin-bottom:12px"><button class="btn" data-act="whatsapp">Copy WhatsApp message</button><button class="btn" data-act="export">Export CSV</button></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Website</th><th>Name</th><th>Price</th><th>DR / Traffic</th><th class="num">Links</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>
      ${rows.map(w => `<tr data-act="open" data-id="${w.id}"><td><b>${esc(w.domain)}</b></td><td>${esc(memberName(w.member_id))}</td>
      <td>${w.deal_type === 'paid' ? 'Paid ' + money(w.price) : 'Exchange'}</td><td>${w.da ?? '—'} / ${w.traffic ?? '—'}</td><td class="num">${ownBoss(w) ? hist(w).length + (roundDone(w) ? 1 : 0) : w.possible_links ? `${hist(w).length + (roundDone(w) ? 1 : 0)} / ${w.possible_links}` : '—'}</td>
      <td>${pill(w)}</td><td>${(w.updated_at || '').slice(0, 10)}</td><td class="nowrap"><button class="btn sm" data-act="edit" data-id="${w.id}">Edit</button><button class="btn sm danger" data-act="del" data-id="${w.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">${all.length ? 'No websites match these filters.' : 'No websites yet. Team members add them when a site says yes, or use Import.'}</div>`}`;
}

function commissionView() {
  const ym = S.month;
  const members = S.people.filter(p => p.role === 'member' || p.id === S.profile.id);
  const rows = members.map(m => {
    const own = m.id === S.profile.id;
    const ws = S.sites.filter(w => w.member_id === m.id);
    const live = ws.reduce((a, w) => a + liveCount(w, ym), 0);
    return {
      m, total: ws.length, approved: ws.filter(w => !['boss_review', 'rejected'].includes(w.status)).length,
      rejected: ws.filter(w => w.status === 'rejected').length, live,
      own, team: own ? 0 : live * rateOf(m), boss: own ? live * rateOf(m) : live * S.bossRate, share: own ? live * rateOf(m) : live * (S.bossRate - rateOf(m)),
    };
  });
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const label = new Date(ym + '-01T00:00').toLocaleString(undefined, { month: 'long', year: 'numeric' });
  return `<div class="toolbar"><label style="margin:0">Month</label><input type="month" style="width:auto" value="${ym}" data-change="month"></div>
    <div class="stats"><div class="stat"><b>${money(sum('boss'))}</b><span>Client rate total</span></div><div class="stat"><b>${money(sum('team'))}</b><span>To team</span></div>
    <div class="stat hot"><b>${money(sum('share'))}</b><span>Your total income</span></div><div class="stat"><b>${sum('live')}</b><span>Live links</span></div>
    <div class="stat"><b>${rows.filter(r => r.own).reduce((x, r) => x + r.live, 0)}</b><span>My own live links</span></div><div class="stat"><b>${money(rows.filter(r => r.own).reduce((x, r) => x + r.share, 0))}</b><span>My own income</span></div></div>
    <p class="sub" style="margin-top:12px">${label}: ${money(sum('boss'))} from client rate, ${money(sum('team'))} to team, your total income ${money(sum('share'))}. Your own sites are paid at the full client rate.</p>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th class="num">Websites</th><th class="num">Approved+</th><th class="num">Rejected</th><th class="num">Live links</th><th class="num">Team payout</th><th class="num">Client rate</th><th class="num">My share</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><b>${esc(r.m.name || r.m.email)}</b>${r.own ? ' (you)' : ''}</td><td class="num">${r.total}</td><td class="num">${r.approved}</td><td class="num">${r.rejected}</td><td class="num">${r.live}</td><td class="num">${money(r.team)}</td><td class="num">${money(r.boss)}</td><td class="num">${money(r.share)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${sum('total')}</td><td class="num">${sum('approved')}</td><td class="num">${sum('rejected')}</td><td class="num">${sum('live')}</td><td class="num">${money(sum('team'))}</td><td class="num">${money(sum('boss'))}</td><td class="num">${money(sum('share'))}</td></tr></tfoot></table></div>`
      : '<div class="empty">No team members yet. Invite them in Settings.</div>'}`;
}

function settingsView() {
  return `<h2>Rates (per live link)</h2><form data-form="rates" style="max-width:420px">
    <div class="grid2"><div><label>Team rate ($)</label><input type="number" step="0.01" min="0" name="team_rate" value="${S.teamRate}" required></div>
    <div><label>Client rate ($)</label><input type="number" step="0.01" min="0" name="boss_rate" value="${S.bossRate}" required></div></div>
    <p class="hint">The client rate is visible to you only.</p><button class="btn primary" type="submit">Save rates</button></form>
    <h2>Invite a user</h2><form data-form="invite" style="max-width:520px"><div class="grid2"><div><label>Email</label><input type="email" name="email" required placeholder="name@example.com"></div>
    <div><label>Role</label><select name="role"><option value="member">Team member</option><option value="boss">Director</option></select></div></div>
    <p class="hint">They can then create an account with this email on the sign-in page.</p><button class="btn primary" type="submit">Send invite</button></form>
    <h2>Team</h2>${S.people.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${S.people.map(p => `<tr><td>${esc(p.name || '—')}</td><td>${esc(p.email)}</td><td>${p.role === 'manager' ? 'Manager' : `<select data-change="userrole" data-id="${p.id}" style="width:auto"><option value="member" ${p.role === 'member' ? 'selected' : ''}>Team member</option><option value="boss" ${p.role === 'boss' ? 'selected' : ''}>Director</option></select>`}</td></tr>`).join('')}
      ${S.invites.map(i => `<tr><td><i>Invited</i></td><td>${esc(i.email)}</td><td><button class="btn sm danger" data-act="rminvite" data-v="${esc(i.email)}">Remove</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

function whatsappText() {
  const rev = S.sites.filter(w => w.status === 'boss_review');
  const inv = S.sites.filter(w => w.status === 'invoice_received');
  const total = inv.reduce((a, w) => a + (+w.price || 0), 0);
  const out = [];
  out.push(rev.length ? `*Websites waiting for your review (${rev.length}):*\n` + rev.map((w, i) => `${i + 1}. ${w.domain} - ${dealLabel(w.deal_type)}${w.deal_type === 'paid' ? ' ' + money(w.price) : ''} - DR ${w.da ?? '?'}, traffic ${w.traffic ?? '?'} (${memberName(w.member_id)})`).join('\n') : 'No websites waiting for review.');
  out.push(inv.length ? `*Invoices waiting for payment (${inv.length}, total ${money(total)}):*\n` + inv.map((w, i) => `${i + 1}. ${w.domain} - ${money(w.price)}${w.invoice_url ? ' - ' + w.invoice_url : ''}`).join('\n') : 'No invoices waiting for payment.');
  return out.join('\n\n');
}

function csvExport() {
  const cols = ['Domain', 'URL', 'Member', 'Contact email', 'Deal', 'Price', 'DR', 'Traffic', 'Status', 'Possible links', 'Links placed', 'Target URL', 'Anchor', 'Live URL', 'Their link', 'Invoice', 'Live date', 'Paid date', 'Notes', 'Added'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(q).join(',')].concat(S.sites.map(w => [w.domain, w.url, memberName(w.member_id), w.contact_email, dealLabel(w.deal_type), w.price, w.da, w.traffic,
    ST[w.status].label, w.possible_links, hist(w).length + (LIVE_STATUSES.includes(w.status) ? 1 : 0), w.target_url, w.anchor_text, w.live_url, w.their_link, w.invoice_url, w.live_date, w.paid_date, w.notes, (w.created_at || '').slice(0, 10)].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
  a.download = `link-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------- Boss ----------
const ownStep = w => (w.member_id !== S.profile.id || S.preview ? '' : w.status === 'link_ready'
  ? `<button class="btn" data-act="copymsg" data-id="${w.id}">Copy message for website</button><button class="btn primary" data-act="sentbtn" data-id="${w.id}">Link sent to website</button>`
  : w.status === 'sent' ? `<button class="btn primary" data-act="livebtn" data-id="${w.id}">Link is live</button>` : '');
const B = (act, id, label, primary) => `<button class="btn ${primary ? 'primary' : ''}" data-act="${act}" data-id="${id}">${label}</button>`;

const invBtns = w => (w.status === 'live' ? B('invoice', w.id, 'Invoice received', true) + B('paid', w.id, 'Mark as paid') : B('paid', w.id, 'Mark as paid', true));
const ownActions = w => {
  if (S.preview) return '';
  if (w.status === 'approved') return B('addlink', w.id, 'Add link', true);
  if (w.deal_type === 'paid' && ['live', 'invoice_received'].includes(w.status)) return invBtns(w);
  if (w.deal_type === 'exchange' && w.status === 'live' && !w.their_link_live) return B('theirlive', w.id, 'Their link is live', true);
  if (nextPossible(w)) return B('nextlink', w.id, 'Add next link', true);
  return '';
};

function sectionDefs(allWs) {
  const mineList = allWs.filter(w => w.member_id === S.profile.id), ws = allWs.filter(w => w.member_id !== S.profile.id);
  const act = html => (eff().role === 'boss' ? html : '');
  const linkRowsOf = (base, pred, readyToo) => base.filter(pred).flatMap(w => [...hist(w).map((x, i) => ({ w, x, cur: false, i })), ...((readyToo ? ['link_ready', 'sent', 'live', 'invoice_received', 'paid'] : ['sent', 'live', 'invoice_received', 'paid']).includes(w.status) && w.target_url ? [{ w, x: w, cur: true, i: -1 }] : [])]);
  const siteCell = r => `<b>${esc(r.w.domain)}</b>`;
  const drCell = r => `${r.w.da ?? '—'} / ${r.w.traffic ?? '—'}`;
  const isBoss = eff().role === 'boss';
  const editLink = (r, k) => (S.preview || !isBoss ? '' : `<button class="btn sm" data-act="editlink" data-id="${r.w.id}" data-i="${r.i}" data-k="${k}">Edit</button><button class="btn sm danger" data-act="del" data-id="${r.w.id}">Delete</button>`);
  const editDel = w => (S.preview ? '' : `<button class="btn sm" data-act="edit" data-id="${w.id}">Edit</button><button class="btn sm danger" data-act="del" data-id="${w.id}">Delete</button>`);
  const mk = (base, mine) => {
    const rows = (pred, ready) => linkRowsOf(base, pred, ready);
    const who = mine ? [] : [['Name', r => esc(memberName(r.w.member_id))]];
    const site1 = [['Website', siteCell], ...who];
    const who2 = mine ? 'your own' : 'team';
    return {
      links: { label: 'Website links', sub: `Links sent to ${who2} websites.`, list: rows(() => true, !mine),
        cols: [...site1, ['Target URL', r => lnk(r.x.target_url)], ['Anchor text', r => esc(r.x.anchor_text || '—')], ['Status', r => (r.cur ? pill(r.w) : '<span class="pill green">Done</span>')], ...(mine ? [] : [['Request', r => (r.cur && r.w.change_request ? `<span class="pill amber">Change requested</span><div class="mini">${esc(r.w.change_request)}</div>` : '—')]]), ['DR / Traffic', drCell]], kind: 'links',
        rowAct: r => (!mine && r.cur && ['approved', 'link_ready'].includes(r.w.status) && !S.preview ? act(`<button class="btn" data-act="toreview" data-id="${r.w.id}">Restore</button>`) : '') + (r.cur && r.w.change_request && !S.preview ? `<button class="btn primary" data-act="clearreq" data-id="${r.w.id}">Done</button>` : '') + editLink(r, 'links') },
      exch: { label: 'Exchange links', sub: `Links on ${who2} exchange websites.`, list: rows(w => w.deal_type === 'exchange'),
        cols: [...site1, ['Target URL', r => lnk(r.x.target_url)], ['Anchor text', r => esc(r.x.anchor_text || '—')], ['Our live link', r => lnk(r.x.live_url)],
          ['Their link', r => `${lnk(r.x.their_link)}${r.cur && r.w.their_link_live ? ' (live)' : ''}`], ['Status', r => (r.cur ? pill(r.w) : '<span class="pill green">Done</span>')], ['DR / Traffic', drCell]], kind: 'exch',
        rowAct: r => act(r.cur && r.w.status === 'live' && !r.w.their_link_live ? B('theirlive', r.w.id, 'Their link is live', true) : '') + editLink(r, 'exch') },
      inv: { label: 'Invoices and payments', sub: `Invoices for ${who2} paid websites.`, list: rows(w => w.deal_type === 'paid'),
        cols: [...site1, ['Target URL', r => lnk(r.x.target_url)], ['Invoice', r => (r.x.invoice_url ? lnk(r.x.invoice_url) : 'No invoice link yet')], ['Amount', r => money(r.x.price)],
          ['Status', r => (r.cur ? pill(r.w) : '<span class="pill green">Paid</span>')], ['DR / Traffic', drCell]],
        kind: 'inv', rowAct: r => act(r.cur && ['live', 'invoice_received'].includes(r.w.status) ? invBtns(r.w) : '') + editLink(r, 'inv') },
    };
  };
  const my = mk(mineList, true), team = mk(ws, false);
  return {
    mine: { label: 'My websites', sub: 'Websites you add yourself. They need no approval and nobody else can see them.', list: mineList, add: true, own: true },
    mylinks: my.links,
    myexch: my.exch,
    mynext: { label: 'Next link possible', sub: 'Your own finished websites. Add the next link.', list: mineList.filter(nextPossible),
      cols: [['Website', siteCell], ['Links placed', r => `${linkNo(r.w)}`], ['DR / Traffic', drCell]], rowAct: r => act(ownActions(r.w)) + editDel(r.w), wrap: true },
    myinv: my.inv,
    livel: { label: 'Live links', list: ws.flatMap(w => [...hist(w).map(h => ({ w, x: h, cur: false })), ...(LIVE_STATUSES.includes(w.status) ? [{ w, x: w, cur: true }] : [])]).sort((p, q) => (q.x.live_date || '').localeCompare(p.x.live_date || '')),
      cols: [['Website', siteCell], ['Name', r => esc(memberName(r.w.member_id))], ['Target URL', r => lnk(r.x.target_url)], ['Anchor text', r => esc(r.x.anchor_text || '—')], ['Live URL', r => lnk(r.x.live_url)], ['Live date', r => esc(r.x.live_date || '—')]] },
    needs: { label: 'Needs a link (Approved)', sub: 'Approved websites that are waiting for a target URL and anchor.', list: ws.filter(w => w.status === 'approved'),
      extra: [['Possible links', w => w.possible_links ?? '?']], act: w => act(`${B('addlink', w.id, 'Add link', true)}<button class="btn" data-act="bossedit" data-id="${w.id}">Edit</button><button class="btn" data-act="toreview" data-id="${w.id}">Restore</button><button class="btn danger" data-act="reject" data-id="${w.id}">Reject</button>`) },
    inv: team.inv,
    rlinks: team.links,
    exch: team.exch,
    next: { label: 'Next link possible on the same website', sub: 'Finished websites that can take more links.', list: ws.filter(nextPossible),
      extra: [['Links placed', w => `${linkNo(w)} of ${w.possible_links}`]], act: w => act(B('nextlink', w.id, 'Add next link', true)) },
    rejected: { label: 'Rejected', sub: 'Websites you have rejected.', list: ws.filter(w => w.status === 'rejected'), extra: [['Reason', w => esc(w.reject_reason || '—')], ['Updated', w => (w.updated_at || '').slice(0, 10)]],
      act: w => act(`${B('approve', w.id, 'Approve', true)}${B('approvelink', w.id, 'Approve + add link')}`) },
    trash: { label: 'Trash', sub: 'Websites you deleted. Restore them, or delete them forever.', list: S.trash, extra: [['Deleted', w => (w.deleted_at || '').slice(0, 10)]],
      act: w => act(`<button class="btn" data-act="restore" data-id="${w.id}">Restore</button><button class="btn sm danger" data-act="purge" data-id="${w.id}">Delete forever</button>`) },
    all: { label: 'All websites', sub: '', list: ws.filter(w => !S.bossQ.trim() || w.domain.includes(S.bossQ.trim().toLowerCase())), search: true,
      act: w => act(S.preview ? '' : `<button class="btn sm danger" data-act="del" data-id="${w.id}">Delete</button>`) },
    team: (() => {
      const ym = S.month;
      const people = S.people.filter(p => ['member', 'manager'].includes(p.role));
      const perf = p => {
        const sites = allWs.filter(x => x.member_id === p.id);
        const live = sites.reduce((n, x) => n + liveCount(x, ym), 0);
        const rate = rateOf(p);
        return { sites, live, rate, pay: live * rate, total: sites.reduce((n, x) => n + hist(x).length + (LIVE_STATUSES.includes(x.status) ? 1 : 0), 0),
          review: sites.filter(x => x.status === 'boss_review').length, rejected: sites.filter(x => x.status === 'rejected').length };
      };
      const all = people.map(perf);
      const sum = k => all.reduce((n, r) => n + r[k], 0);
      return { label: 'Team managing', sub: 'How each person is doing, and what each person earns for the live links of the selected month.', list: people, wrap: true,
        toolbar: `<div class="toolbar"><label style="margin:0">Month</label><input type="month" style="width:auto" value="${ym}" data-change="month"></div>`,
        cols: [['Name', r => `<b>${esc(r.w.name || r.w.email)}</b>`], ['Websites', r => perf(r.w).sites.length], ['Under review', r => perf(r.w).review], ['Rejected', r => perf(r.w).rejected],
          ['Live links (all)', r => perf(r.w).total], ['Live this month', r => perf(r.w).live], ['Rate / link', r => `<input type="number" class="rate" step="0.01" min="0" value="${perf(r.w).rate}" data-change="personrate" data-id="${r.w.id}" ${S.preview ? 'disabled' : ''} aria-label="Rate per link">`], ['To pay', r => `<b>${money(perf(r.w).pay)}</b>`]],
        foot: ['Total', all.reduce((n, r) => n + r.sites.length, 0), sum('review'), sum('rejected'), sum('total'), sum('live'), '', `<b>${money(sum('pay'))}</b>`] };
    })(),
  };
}

function mineHeader(list) {
  const prices = w => hist(w).filter(x => w.deal_type === 'paid').map(x => +x.price || 0);
  const liveLinks = list.reduce((n, w) => n + hist(w).length + (LIVE_STATUSES.includes(w.status) ? 1 : 0), 0);
  const dueSites = list.filter(w => w.deal_type === 'paid' && ['live', 'invoice_received'].includes(w.status));
  const dueAmount = dueSites.reduce((x, w) => x + (+w.price || 0), 0);
  const paidList = list.flatMap(w => [...prices(w), ...(w.status === 'paid' ? [+w.price || 0] : [])]);
  const paidAmount = paidList.reduce((x, p) => x + p, 0);
  return `<div class="stats"><div class="stat tint-blue"><b>${list.length}</b><span>Total websites</span></div>
    <div class="stat tint-green"><b>${liveLinks}</b><span>Live links</span></div>
    <div class="stat tint-amber"><b>${dueSites.length} · ${money(dueAmount)}</b><span>Invoices due</span></div>
    <div class="stat tint-purple"><b>${paidList.length} · ${money(paidAmount)}</b><span>Paid (all links)</span></div></div>`;
}

function trashHtml(list, label, withName, actFn) {
  S.sel = new Set([...(S.sel || [])].filter(id => list.some(w => w.id === id)));
  const n = S.sel.size, allOn = list.length && n === list.length;
  return `<h2>${label} <span class="badge">${list.length}</span></h2>
    ${n ? `<div class="toolbar"><span class="hint">${n} selected</span><button class="btn" data-act="bulkrestore">Restore selected</button><button class="btn danger" data-act="bulkpurge">Delete selected forever</button></div>` : ''}
    ${list.length ? `<div class="tablewrap"><table><thead><tr><th><input type="checkbox" data-act="selall" ${allOn ? 'checked' : ''} aria-label="Select all"></th><th>Website</th>${withName ? '<th>Name</th>' : ''}<th>Deal</th><th class="num">Price</th><th>DR / Traffic</th><th>Status</th><th>Deleted</th><th>Action</th></tr></thead><tbody>
    ${list.map(w => `<tr><td><input type="checkbox" data-act="seltoggle" data-id="${w.id}" ${S.sel.has(w.id) ? 'checked' : ''} aria-label="Select"></td><td><b>${esc(w.domain)}</b></td>${withName ? `<td>${esc(memberName(w.member_id))}</td>` : ''}<td>${dealLabel(w.deal_type)}</td>
    <td class="num">${money(w.price)}</td><td>${w.da ?? '—'} / ${w.traffic ?? '—'}</td><td>${pill(w)}</td><td>${(w.deleted_at || '').slice(0, 10)}</td><td class="nowrap">${actFn(w)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Trash is empty.</div>'}`;
}

function sectionView(key) {
  const d = sectionDefs(visibleSites())[key];
  const all = d.list;
  if (key === 'trash') return trashHtml(d.list, d.label, true, w => d.act(w));
  if (d.cols) {
    const rows = d.wrap ? d.list.map(w => ({ w, x: w, cur: true })) : d.list;
    return `<h2>${d.label} <span class="badge">${rows.length}</span></h2>
      ${d.toolbar || ''}
      ${rows.length ? `<div class="tablewrap"><table><thead><tr>${d.cols.map(([l]) => `<th>${l}</th>`).join('')}${d.rowAct && eff().role !== 'manager' ? '<th>Action</th>' : ''}</tr></thead><tbody>
      ${rows.map(r => `<tr ${d.kind ? `data-act="linkdetail" data-id="${r.w.id}" data-i="${r.i ?? -1}" data-k="${d.kind}"` : ''}>${d.cols.map(([, fn]) => `<td>${fn(r)}</td>`).join('')}${d.rowAct && eff().role !== 'manager' ? `<td class="nowrap">${d.rowAct(r)}</td>` : ''}</tr>`).join('')}</tbody>${d.foot ? `<tfoot><tr>${d.foot.map(c => `<td>${c}</td>`).join('')}</tr></tfoot>` : ''}</table></div>` : '<div class="empty">Nothing here right now.</div>'}`;
  }
  const extra = d.extra || [['Updated', w => (w.updated_at || '').slice(0, 10)]];
  const hasAct = d.own || d.act;
  const actCell = w => (d.own ? `${w.status === 'approved' && eff().role === 'boss' ? ownActions(w) : ''}${ownStep(w)}${w.status === 'sent' && eff().role !== 'boss' && !S.preview ? `<button class="btn" data-act="reqchange" data-id="${w.id}">${w.change_request ? 'Edit request' : 'Request change'}</button>` : ''}${S.preview ? '' : `<button class="btn sm" data-act="edit" data-id="${w.id}">Edit</button><button class="btn sm danger" data-act="del" data-id="${w.id}">Delete</button>`}` : d.act(w));
  return `<h2>${d.label} <span class="badge">${all.length}</span></h2>${d.sub ? `` : ''}
    ${d.add ? `<div class="toolbar"><button class="btn primary" data-act="add" ${readOnly() ? 'disabled' : ''}>+ Add website</button>${eff().role === 'manager' ? `<button class="btn" data-act="import" ${readOnly() ? 'disabled' : ''}>Import</button>` : ''}</div>` : ''}${d.own ? mineHeader(all) : ''}
    ${d.search ? `<div class="toolbar"><input type="search" id="bq" placeholder="Search website" value="${esc(S.bossQ)}" data-input="bq"></div>` : ''}
    ${!d.list.length ? '<div class="empty">Nothing here right now.</div>' : `<div class="tablewrap"><table><thead><tr><th>Website</th><th>Name</th><th>Deal</th><th class="num">Price</th><th>DR / Traffic</th><th class="num">Links</th><th>Status</th>${extra.map(([l]) => `<th>${l}</th>`).join('')}${hasAct ? '<th>Action</th>' : ''}</tr></thead><tbody>
      ${d.list.map(w => `<tr data-act="open" data-id="${w.id}"><td><b>${esc(w.domain)}</b></td><td>${esc(memberName(w.member_id))}</td><td>${dealLabel(w.deal_type)}</td>
      <td class="num">${money(w.price)}</td><td>${w.da ?? '—'} / ${w.traffic ?? '—'}</td><td class="num">${ownBoss(w) ? hist(w).length + (roundDone(w) ? 1 : 0) : w.possible_links ? `${hist(w).length + (roundDone(w) ? 1 : 0)} / ${w.possible_links}` : '—'}</td>
      <td>${pill(w)}</td>${extra.map(([, fn]) => `<td>${fn(w)}</td>`).join('')}${hasAct ? `<td class="nowrap">${actCell(w)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`}`;
}

const ICONS = {
  site: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.500 3-6 7-6s7 2.500 7 6M16 4.500a3.500 3.500 0 0 1 0 7M18 14.500c2.500.5 4 2.500 4 5.500"/>',
  wlinks: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7"/>',
  mine: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  review: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  needs: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  inv: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  exch: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
  next: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  rejected: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  all: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  commission: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.600-1.500-3-1.500-1.700 0-3 .8-3 2s1.300 1.700 3 2 3 .8 3 2-1.300 2-3 2c-1.400 0-2.500-.5-3-1.500M12 6v2M12 16v2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  action: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  live: '<path d="M5 12l5 5L20 7"/>',
};
const icon = k => `<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.all}</svg>`;

function sidebar() {
  const role = eff().role, ws = visibleSites();
  const btn = (k, l, n, on, act = 'nav', ic = k) => `<button class="nav c-${ic} ${on ? 'on' : ''}" data-act="${act}" data-v="${k}">${icon(ic)}<span class="lbl">${l}</span>${n != null ? `<span class="count">${n}</span>` : ''}</button>`;
  let items = '';
  if (role === 'boss') {
    const d = sectionDefs(ws);
    const chev = (open, act) => `<span class="chev ${open ? 'open' : ''}" data-act="${act}" role="button" aria-label="Show or hide sections"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>`;
    const row = ([k, l, n, ic], sub) => btn(k, l, n, S.nav === k, 'nav', ic).replace('class="nav ', `class="nav ${sub ? 'sub ' : ''}`);
    const kids = (open, list) => (open ? list.map(r => row(r, true)).join('') : '');
    items = row(['mine', 'My websites', d.mine.list.length, 'mine']).replace(/<\/button>$/, chev(S.mineOpen, 'minetoggle')) +
      kids(S.mineOpen, [['mylinks', 'Website links', d.mylinks.list.length, 'wlinks'], ['myexch', 'Exchange links', d.myexch.list.length, 'exch'], ['mynext', 'Next link possible', d.mynext.list.length, 'next'], ['myinv', 'Invoices & payments', d.myinv.list.length, 'inv']]) +
      row(['home', 'Review', ws.filter(w => w.status === 'boss_review').length, 'review']).replace(/<\/button>$/, chev(S.revOpen, 'revtoggle')) +
      kids(S.revOpen, [['needs', 'Needs a link', d.needs.list.length, 'needs'], ['rlinks', 'Website links' + (ws.some(w => w.change_request) ? ' <span class="dot"></span>' : ''), d.rlinks.list.length, 'wlinks'], ['exch', 'Exchange links', d.exch.list.length, 'exch'], ['next', 'Next link possible', d.next.list.length, 'next']]) +
      row(['inv', 'Invoices & payments', d.inv.list.length, 'inv']) + row(['rejected', 'Rejected', d.rejected.list.length, 'rejected']) + row(['all', 'All websites', d.all.list.length, 'all']) + row(['team', 'Team managing', d.team.list.length, 'team']) +
      row(['trash', 'Trash', d.trash.list.length, 'trash']).replace('class="nav ', 'class="nav trashbtn ');
  } else if (role === 'manager') {
    const d = sectionDefs(ws);
    const chev = (open, act) => `<span class="chev ${open ? 'open' : ''}" data-act="${act}" role="button" aria-label="Show or hide sections"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>`;
    const row = ([k, l, n, ic], sub) => btn(k, l, n, S.nav === k, 'nav', ic).replace('class="nav ', `class="nav ${sub ? 'sub ' : ''}`);
    const kids = S.mineOpen ? [['mylinks', 'Website links', d.mylinks.list.length, 'wlinks'], ['myexch', 'Exchange links', d.myexch.list.length, 'exch']].map(r => row(r, true)).join('') : '';
    const wsKids = S.wsOpen ? [['rejected', 'Rejected', d.rejected.list.length, 'rejected'], ['exch', 'Exchange links', d.exch.list.length, 'exch'], ['livel', 'Live links', d.livel.list.length, 'live']].map(r => row(r, true)).join('') : '';
    items = row(['home', 'Websites', null, 'all']).replace(/<\/button>$/, chev(S.wsOpen, 'wstoggle')) + wsKids + row(['mine', 'My websites', d.mine.list.length, 'mine']).replace(/<\/button>$/, chev(S.mineOpen, 'minetoggle')) + kids + row(['myinv', 'Invoices & payments', d.myinv.list.length, 'inv']) + row(['commission', 'Commission', null, 'commission']) + row(['settings', 'Settings', null, 'settings']);
  } else {
    const cnt = { all: w => !LIVE_STATUSES.includes(w.status) && w.status !== 'rejected', action: needsAction, boss: w => ['boss_review', 'approved'].includes(w.status), live: w => LIVE_STATUSES.includes(w.status), rejected: w => w.status === 'rejected' };
    const mf = (k, l, ic, sub) => btn(k, l, ws.filter(cnt[k]).length, S.mem.f === k && S.nav === 'home', 'mfilter', ic).replace('class="nav ', `class="nav ${sub ? 'sub ' : ''}`);
    const arrow = `<span class="chev ${S.mwOpen ? 'open' : ''}" data-act="mwtoggle" role="button" aria-label="Show or hide sections"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></button>`;
    items = mf('all', 'My Websites', 'mine').replace(/<\/button>$/, arrow) + (S.mwOpen ? mf('live', 'Live sites', 'site', true) : '') + btn('earn', 'Live links', null, S.nav === 'earn', 'nav', 'needs') + btn('mexch', 'Exchange links', null, S.nav === 'mexch', 'nav', 'exch') + btn('minv', 'Invoices', null, S.nav === 'minv', 'nav', 'inv') + mf('rejected', 'Rejected', 'rejected') + btn('trash', 'Trash', S.trash.length, S.nav === 'trash', 'nav', 'trash').replace('class="nav ', 'class="nav trashbtn ');
  }
  return `<nav class="side" aria-label="Sections">${items}</nav>`;
}

function bossView() {
  const review = visibleSites().filter(w => w.status === 'boss_review');
  return `<h2>Review <span class="badge">${review.length}</span></h2>
    ${review.length ? `<div class="tablewrap"><table><thead><tr><th>Website</th><th>Name</th><th>Deal</th><th class="num">Price</th><th>DR / Traffic</th><th>Action</th></tr></thead><tbody>
      ${review.map(w => `<tr data-act="open" data-id="${w.id}"><td><b>${esc(w.domain)}</b></td><td>${esc(memberName(w.member_id))}</td><td>${dealLabel(w.deal_type)}</td>
      <td class="num">${money(w.price)}</td><td>${w.da ?? '—'} / ${w.traffic ?? '—'}</td>
      <td class="nowrap">${B('approve', w.id, 'Approve', true)}${B('approvelink', w.id, 'Approve + add link')}<button class="btn danger" data-act="reject" data-id="${w.id}">Reject</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing here right now.</div>'}`;
}

// ---------- Member ----------
const needsAction = w => ['link_ready', 'sent'].includes(w.status);

function exchangeView() {
  const rows = visibleSites().filter(w => w.deal_type === 'exchange').flatMap(w => [
    ...hist(w).map(h => ({ w, ours: h.live_url, theirs: h.their_link, st: 'done', d: h.live_date })),
    ...(LIVE_STATUSES.includes(w.status) ? [{ w, ours: w.live_url, theirs: w.their_link, st: w.their_link_live ? 'done' : 'wait', d: w.live_date }] : []),
  ]).sort((x, y) => (y.d || '').localeCompare(x.d || ''));
  return `<h2>Exchange links <span class="badge">${rows.length}</span></h2>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Website</th><th>Our link</th><th>Their link</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows.map(r => `<tr data-act="open" data-id="${r.w.id}"><td><b>${esc(r.w.domain)}</b></td><td>${lnk(r.ours)}</td><td>${lnk(r.theirs)}</td>
      <td><span class="pill ${r.st === 'done' ? 'green' : 'amber'}">${r.st === 'done' ? 'Exchange complete' : 'Waiting for their link'}</span></td><td>${esc(r.d || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No exchange links yet.</div>'}`;
}

function invoicesView() {
  const label = { live: 'Invoice sent', invoice_received: 'Received by admin', paid: 'Paid' };
  const rows = visibleSites().filter(w => w.deal_type === 'paid').flatMap(w => [
    ...hist(w).map(h => ({ w, inv: h.invoice_url, st: 'paid', d: h.live_date })),
    ...(LIVE_STATUSES.includes(w.status) ? [{ w, inv: w.invoice_url, st: w.status, d: w.status === 'paid' ? w.paid_date || w.live_date : w.live_date }] : []),
  ]).sort((x, y) => (y.d || '').localeCompare(x.d || ''));
  const shown = rows;
  return `<h2>Invoices <span class="badge">${rows.length}</span></h2>
    ${shown.length ? `<div class="tablewrap"><table><thead><tr><th>Website</th><th>Invoice</th><th>Status</th><th>Date</th></tr></thead><tbody>${shown.map(r => `<tr data-act="open" data-id="${r.w.id}"><td><b>${esc(r.w.domain)}</b></td><td>${r.inv ? lnk(r.inv) : 'No invoice link'}</td>
      <td><span class="pill ${r.st === 'paid' ? 'green' : r.st === 'invoice_received' ? 'violet' : 'amber'}">${r.st === 'paid' ? 'Paid' : label[r.st]}</span></td><td>${esc(r.d || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No invoices here.</div>'}`;
}

function earnView() {
  const ym = S.month, all = !!S.liveAll;
  const rows = visibleSites().flatMap(w => [...hist(w).map(h => ({ w, x: h.live_url, d: h.live_date })), ...(LIVE_STATUSES.includes(w.status) ? [{ w, x: w.live_url, d: w.live_date }] : [])])
    .filter(r => all || (r.d || '').startsWith(ym)).sort((x, y) => (y.d || '').localeCompare(x.d || ''));
  return `<h2>Live links <span class="badge">${rows.length}</span></h2>
    <div class="toolbar"><label style="margin:0">Month</label><input type="month" style="width:auto" value="${ym}" data-change="month" ${all ? 'disabled' : ''}>
      <button class="chip ${all ? 'on' : ''}" data-act="liveall">All time</button></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Website</th><th>Live URL</th><th>Live date</th></tr></thead><tbody>${rows.map(r => `<tr data-act="open" data-id="${r.w.id}"><td><b>${esc(r.w.domain)}</b></td><td>${lnk(r.x)}</td><td>${esc(r.d || '—')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${all ? 'No live links yet.' : 'No live links in this month.'}</div>`}`;
}

function memberView() {
  const ws = visibleSites();
  const f = S.mem.f, q = S.mem.q.trim().toLowerCase();
  const filt = {
    all: w => !LIVE_STATUSES.includes(w.status) && w.status !== 'rejected', action: needsAction, boss: w => ['boss_review', 'approved'].includes(w.status),
    live: w => LIVE_STATUSES.includes(w.status), rejected: w => w.status === 'rejected',
  }[f];
  const list = ws.filter(w => filt(w) && (!q || w.domain.includes(q)));
  const title = { all: 'My Websites', boss: 'Under review', live: 'Live sites', rejected: 'Rejected' }[f];
  return `<h2>${title} <span class="badge">${list.length}</span></h2>
    ${f === 'all' ? `<div class="toolbar"><button class="btn primary" data-act="add" ${readOnly() ? 'disabled' : ''}>+ Add website</button>
      <input type="search" id="memq" placeholder="Search" value="${esc(S.mem.q)}" data-input="memq"></div>` : ''}
    ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Website</th><th>Deal</th><th class="num">Price</th><th>DR / Traffic</th><th>Status</th><th>Note</th><th>Action</th></tr></thead><tbody>${list.map(memberRow).join('')}</tbody></table></div>` :
      `<div class="empty">${ws.length ? 'No websites in this view.' : 'No websites yet. Click + Add website when a site says yes.'}</div>`}`;
}

function memberRow(w) {
  const t = {
    boss_review: 'Under review', approved: 'Waiting for the link', link_ready: 'Send this link to the website', sent: 'Waiting for the website to publish it',
    rejected: 'Rejected: ' + (w.reject_reason || 'no reason given'), invoice_received: 'Invoice received', paid: 'Paid',
    live: w.deal_type === 'exchange' ? (w.their_link_live ? 'Live. Exchange complete' : 'Live. Waiting for the exchange link') : 'Live. Invoice in progress',
  }[w.status];
  const more = queueOf(w).length ? ` ${queueOf(w).length} more link(s) will follow.` : '';
  const step = w.status === 'link_ready' ? `<button class="btn" data-act="copymsg" data-id="${w.id}">Copy message</button><button class="btn primary" data-act="sentbtn" data-id="${w.id}">Link sent</button>`
    : w.status === 'sent' ? `<button class="btn primary" data-act="livebtn" data-id="${w.id}">Link is live</button><button class="btn" data-act="reqchange" data-id="${w.id}">${w.change_request ? 'Edit request' : 'Request change'}</button>` : '';
  const locked = LIVE_STATUSES.includes(w.status);
  return `<tr data-act="open" data-id="${w.id}"><td><b>${esc(w.domain)}</b></td><td>${dealLabel(w.deal_type)}</td><td class="num">${money(w.price)}</td><td>${w.da ?? '—'} / ${w.traffic ?? '—'}</td>
    <td>${pill(w)}</td><td>${esc(t + more)}${w.change_request ? `<div class="mini hint2">Change requested: ${esc(w.change_request)}</div>` : ''}${w.change_done_at ? `<div class="mini ok">Admin updated the link. <button class="btn sm" data-act="ackdone" data-id="${w.id}">Got it</button></div>` : ''}</td>
    <td class="nowrap">${step}${locked ? '' : `${w.status === 'rejected' ? '' : `<button class="btn sm" data-act="edit" data-id="${w.id}">Edit</button>`}<button class="btn sm danger" data-act="del" data-id="${w.id}">Delete</button>`}</td></tr>`;
}

function siteForm(w) {
  w = w || { deal_type: 'exchange' };
  return `<form data-form="site" data-id="${w.id || ''}">
    <label>Website URL</label><input name="url" required placeholder="example.com" value="${esc(w.url || '')}" data-dup="1" autocomplete="off">
    <div id="dup"></div>
    <label>Contact email</label><input type="email" name="contact_email" value="${esc(w.contact_email || '')}">
    <label>Deal type</label><select name="deal_type"><option value="exchange" ${w.deal_type === 'exchange' ? 'selected' : ''}>Exchange</option><option value="paid" ${w.deal_type === 'paid' ? 'selected' : ''}>Paid</option></select>
    <div class="grid2"><div><label>DR</label><input type="number" min="0" max="100" name="da" value="${w.da ?? ''}"></div>
    <div><label>Traffic</label><input name="traffic" maxlength="20" placeholder="e.g. 12K, 1.5M" value="${esc(w.traffic ?? '')}"></div></div>
    <div id="pricewrap" class="${w.deal_type === 'paid' ? '' : 'hidden'}"><label>Price ($)</label><input type="number" min="0" step="0.01" name="price" value="${w.price ?? ''}"></div>
    ${w.id && eff().role === 'boss' ? `<label>Target URL</label><input name="target_url" value="${esc(w.target_url || '')}" placeholder="https://…"><label>Anchor text</label><input name="anchor_text" value="${esc(w.anchor_text || '')}">` : ''}
    <label>Notes</label><textarea name="notes">${esc(w.notes || '')}</textarea>
    <div style="margin-top:14px"><button class="btn primary big" type="submit">${w.id ? 'Save changes' : 'Add website'}</button></div></form>`;
}

function copyMessage(w) {
  return `URL: ${w.target_url}
Anchor text: ${w.anchor_text}`;
}

// ---------- render ----------
function render() {
  if (!S.profile) return;
  const a = document.activeElement, focus = a && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  const role = eff().role;
  if (['commission', 'settings'].includes(S.nav) && role !== 'manager') S.nav = 'home';
  const mySections = ['mine', 'mylinks', 'myexch', 'mynext', 'myinv', 'rejected', 'exch', 'livel'];
  const body = role === 'manager' && mySections.includes(S.nav) ? sectionView(S.nav) : role === 'member' && S.nav === 'mexch' ? exchangeView() : role === 'member' && S.nav === 'minv' ? invoicesView() : role === 'member' && S.nav === 'earn' ? earnView() : role === 'member' && S.nav === 'trash' ? trashHtml(S.trash, 'Trash', false, w => `<button class="btn" data-act="restore" data-id="${w.id}">Restore</button><button class="btn sm danger" data-act="purge" data-id="${w.id}">Delete forever</button>`) : role === 'boss' && S.nav !== 'home' && sectionDefs(visibleSites())[S.nav] ? sectionView(S.nav) : role === 'manager' ? managerView() : role === 'boss' ? bossView() : memberView();
  app.innerHTML = header() + `<div class="layout">${sidebar()}<main>${body}</main></div>`;
  if (focus) { const n = document.getElementById(focus.id); if (n) { n.focus(); try { n.setSelectionRange(focus.s, focus.e); } catch (e) {} } }
}

// ---------- actions ----------
const WRITE = new Set(['approve', 'approvelink', 'reject', 'addlink', 'invoice', 'paid', 'theirlive', 'nextlink', 'add', 'edit', 'del', 'sentbtn', 'livebtn', 'import', 'rminvite', 'bossedit', 'restore', 'purge', 'editlink', 'reqchange', 'clearreq', 'bulkrestore', 'bulkpurge', 'ackdone', 'toreview']);
const need = (id, msg, fields, form, title) => openDrawer(title, `<form data-form="${form}" data-id="${id}">${fields}<div style="margin-top:14px"><button class="btn primary big" type="submit">${msg}</button></div></form>`, 'form', id);
const site = id => S.sites.find(w => w.id === id);
const pairHtml = () => `<div class="pair"><label>Another link: Target URL</label><input name="more_target" placeholder="https://client-site.com/page"><label>Another link: Anchor text</label><input name="more_anchor"></div>`;
const linkFieldsFor = (t, n) => `<label>Target URL</label><input name="target_url" required placeholder="https://client-site.com/page" value="${esc(t || '')}"><label>Anchor text</label><input name="anchor_text" required value="${esc(n || '')}"><div id="morelinks"></div><button type="button" class="btn sm" data-act="morelink" style="margin-top:10px">+ Add another link</button>`;
const linkFields = linkFieldsFor('', '');
const queueOf = w => (Array.isArray(w.queued_links) ? w.queued_links : []);
function moreLinks(d) {
  const t = d.getAll('more_target').map(txt), n = d.getAll('more_anchor').map(txt), out = [];
  for (let k = 0; k < t.length; k++) {
    if (!t[k] && !n[k]) continue;
    if (!t[k] || !n[k]) { toast('Fill both the target URL and the anchor text for each extra link', 'err'); return null; }
    out.push({ target_url: t[k], anchor_text: n[k] });
  }
  return out;
}

const actions = {
  liveall: () => { S.liveAll = !S.liveAll; render(); },
  seltoggle: el => { S.sel = S.sel || new Set(); S.sel.has(el.dataset.id) ? S.sel.delete(el.dataset.id) : S.sel.add(el.dataset.id); render(); },
  selall: () => { const ids = S.trash.map(w => w.id); S.sel = (S.sel && S.sel.size === ids.length) ? new Set() : new Set(ids); render(); },
  async bulkrestore() {
    const ids = [...S.sel];
    const { error } = await sb.from('websites').update({ deleted_at: null }).in('id', ids);
    if (error) return toast(errMsg(error), 'err');
    S.sel = new Set(); toast('Restored'); refreshSoon();
  },
  async bulkpurge(el) {
    if (armed !== 'bulk') {
      armed = 'bulk'; el.textContent = `Confirm (${S.sel.size})`; el.classList.add('armed');
      setTimeout(() => { if (armed === 'bulk') { armed = null; if (el.isConnected) { el.textContent = 'Delete selected forever'; el.classList.remove('armed'); } } }, 4000);
      return;
    }
    armed = null;
    const ids = [...S.sel];
    const { error } = await sb.from('websites').delete().in('id', ids);
    if (error) return toast(errMsg(error), 'err');
    S.sel = new Set(); toast('Deleted forever'); refreshSoon();
  },
  reqchange: el => {
    const w = site(el.dataset.id);
    openDrawer('Request a change', `<form data-form="changereq" data-id="${w.id}"><p class="hint">Tell the admin what the website wants changed (anchor text, URL, or anything else). The link stays as sent until the admin updates it.</p>
      <label>What should change?</label><textarea name="note" rows="4" required maxlength="500">${esc(w.change_request || '')}</textarea>
      <div style="margin-top:14px"><button class="btn primary big" type="submit">Send to admin</button></div>${w.change_request ? `<div style="margin-top:10px"><button type="button" class="btn danger" data-act="clearreq" data-id="${w.id}">Cancel my request</button></div>` : ''}</form>`, 'form', w.id);
  },
  toreview: el => upd(el.dataset.id, { status: 'boss_review' }, 'Moved back to Review'),
  clearreq: el => { const w = site(el.dataset.id); return upd(el.dataset.id, w && w.member_id !== S.profile.id ? { change_request: null, change_done_at: new Date().toISOString() } : { change_request: null }, 'Request cleared'); },
  ackdone: el => upd(el.dataset.id, { change_done_at: null }, 'Okay'),
  linkdetail: el => {
    const w = site(el.dataset.id), i = +el.dataset.i, k = el.dataset.k, x = i >= 0 ? hist(w)[i] : w;
    if (!x) return;
    const cur = i < 0;
    const rows = k === 'links' ? [['Website', esc(w.domain)], ['Target URL', lnk(x.target_url)], ['Anchor text', esc(x.anchor_text || '—')]]
      : k === 'exch' ? [['Website', esc(w.domain)], ['Target URL', lnk(x.target_url)], ['Anchor text', esc(x.anchor_text || '—')], ['Our live link', lnk(x.live_url)], ['Their link', `${lnk(x.their_link)}${cur && w.their_link_live ? ' (live)' : ''}`]]
      : [['Target URL', lnk(x.target_url)], ['Invoice', x.invoice_url ? lnk(x.invoice_url) : 'No invoice link yet'], ['Amount', money(x.price)], ['Status', cur ? pill(w) : '<span class="pill green">Paid</span>']];
    openDrawer(w.domain, kvRows(rows), 'detail-link', w.id);
  },
  editlink: el => {
    const w = site(el.dataset.id), i = +el.dataset.i, k = el.dataset.k, x = i >= 0 ? hist(w)[i] : w;
    if (!x) return;
    const inp = (name, label, v, ph) => `<label>${label}</label><input name="${name}" value="${esc(v || '')}" ${ph ? `placeholder="${ph}"` : ''}>`;
    const fields = inp('target_url', 'Target URL', x.target_url, 'https://client-site.com/page') +
      (k === 'links' ? inp('anchor_text', 'Anchor text', x.anchor_text) + (i < 0 && !ownBoss(w) ? `<label>Possible links</label><input type="number" min="1" name="possible_links" value="${w.possible_links ?? 1}">` : '') : k === 'exch' ? inp('anchor_text', 'Anchor text', x.anchor_text) + inp('live_url', 'Our live link', x.live_url, 'https://') + inp('their_link', 'Their link', x.their_link, 'https://') : inp('invoice_url', 'Invoice', x.invoice_url, 'Link or PDF URL'));
    openDrawer('Edit link ' + (i >= 0 ? i + 1 : hist(w).length + 1) + ' of ' + w.domain, `<form data-form="editlink" data-id="${w.id}" data-i="${i}" data-k="${k}">${fields}<div style="margin-top:14px"><button class="btn primary big" type="submit">Save changes</button></div></form>`, 'form', w.id);
  },
  morelink: () => { const c = $('#morelinks'); if (c) c.insertAdjacentHTML('beforeend', pairHtml()); },
  mode: el => { S.mode = el.dataset.v; showLogin(); },
  showpw: el => { const i = el.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; el.textContent = i.type === 'password' ? 'Show' : 'Hide'; },
  logout: async () => { if (S.chan) sb.removeChannel(S.chan); await sb.auth.signOut(); },
  close: closeDrawer,
  nav: el => { S.nav = el.dataset.v; S.revOpen = ['home', 'needs', 'rlinks', 'exch', 'next'].includes(S.nav); S.mineOpen = (S.profile.role === 'manager' ? ['mine', 'mylinks', 'myexch'] : ['mine', 'mylinks', 'myexch', 'mynext', 'myinv']).includes(S.nav); S.wsOpen = S.profile.role === 'manager' && ['home', 'rejected', 'exch', 'livel'].includes(S.nav); if (S.profile.role === 'member') S.mwOpen = false; render(); window.scrollTo(0, 0); },
  revtoggle: () => { S.revOpen = !S.revOpen; render(); },
  minetoggle: () => { S.mineOpen = !S.mineOpen; render(); },
  wstoggle: () => { S.wsOpen = !S.wsOpen; render(); },
  clearf: () => { S.mf = { status: '', member: '', deal: '', q: '' }; render(); },
  mfilter: el => { S.mem.f = el.dataset.v; S.nav = 'home'; S.mwOpen = ['all', 'live'].includes(S.mem.f); render(); },
  mwtoggle: () => { S.mwOpen = !S.mwOpen; render(); },
  exitpreview: () => { S.preview = null; render(); },
  open: el => openDetail(el.dataset.id),
  whatsapp: () => copy(whatsappText()),
  export: csvExport,
  import: () => openDrawer('Import websites', `<form data-form="import"><p class="hint">Upload a CSV file, or paste one website per line: <b>url, email, exchange/paid, price, member name, DR, traffic</b>. Leave the member blank to add it to yourself. Duplicates are skipped.</p>
    <label>CSV file</label><input type="file" accept=".csv,.txt,text/csv" data-change="csvfile">
    <label>Or paste rows</label><textarea name="rows" rows="10" required placeholder="example.com, info@example.com, paid, 150, Sara, 45, 12K"></textarea>
    <div style="margin-top:14px"><button class="btn primary big" type="submit">Import</button></div><div id="importres"></div></form>`, 'form'),
  rminvite: async el => { const { error } = await sb.from('invites').delete().eq('email', el.dataset.v); error ? toast(errMsg(error), 'err') : (toast('Invite removed'), refreshSoon()); },
  add: () => openDrawer('Add website', siteForm(), 'form'),
  edit: el => openDrawer('Edit website', siteForm(site(el.dataset.id)), 'form', el.dataset.id),
  del: async el => {
    const id = el.dataset.id;
    if (armed !== id) {
      armed = id; el.textContent = 'Confirm'; el.classList.add('armed');
      setTimeout(() => { if (armed === id) { armed = null; if (el.isConnected) { el.textContent = 'Delete'; el.classList.remove('armed'); } } }, 4000);
      return;
    }
    armed = null;
    const w = site(id);
    const soft = ['boss', 'member'].includes(S.profile.role);
    const { error } = soft ? await sb.from('websites').update({ deleted_at: new Date().toISOString() }).eq('id', id) : await sb.from('websites').delete().eq('id', id);
    if (error) return toast(errMsg(error), 'err');
    toast(soft ? 'Moved to Trash' : 'Deleted'); closeDrawer(); refreshSoon();
  },
  async restore(el) {
    const { error } = await sb.from('websites').update({ deleted_at: null }).eq('id', el.dataset.id);
    if (error) return toast(errMsg(error), 'err');
    toast('Restored'); refreshSoon();
  },
  async purge(el) {
    const id = el.dataset.id;
    if (armed !== id) {
      armed = id; el.textContent = 'Confirm'; el.classList.add('armed');
      setTimeout(() => { if (armed === id) { armed = null; if (el.isConnected) { el.textContent = 'Delete forever'; el.classList.remove('armed'); } } }, 4000);
      return;
    }
    armed = null;
    const { error } = await sb.from('websites').delete().eq('id', id);
    if (error) return toast(errMsg(error), 'err');
    toast('Deleted forever'); refreshSoon();
  },
  copymsg: el => copy(copyMessage(site(el.dataset.id))),
  sentbtn: el => upd(el.dataset.id, { status: 'sent' }, 'Status: Sent to Website'),
  livebtn: el => {
    const w = site(el.dataset.id);
    need(w.id, 'Mark as live',
      `<label>Live URL <span class="hint">(page where our link is live)</span></label><input name="live_url" required placeholder="https://…">` +
      (w.deal_type === 'exchange' ? `<label>Their link <span class="hint">(the link they want from us)</span></label><input name="their_link">` : `<label>Invoice link <span class="hint">(link or PDF URL)</span></label><input name="invoice_url"><label>Or upload the invoice PDF <span class="hint">(max 10 MB)</span></label><input type="file" name="invoice_file" accept="application/pdf,.pdf">`),
      'live', 'Link is live');
  },
  approve: el => need(el.dataset.id, 'Approve', `<label>Possible links <span class="hint">(how many links this website can take)</span></label><input type="number" name="possible_links" min="1" required value="1">`, 'approve', 'Approve website'),
  approvelink: el => need(el.dataset.id, 'Approve and send link', `<label>Possible links</label><input type="number" name="possible_links" min="1" required value="1">${linkFields}`, 'approvelink', 'Approve + add link'),
  reject: el => need(el.dataset.id, 'Reject', `<label>Reason</label><select name="reason" required>${REJECT_REASONS.map(r => `<option>${r}</option>`).join('')}</select><div id="otherwrap" class="hidden"><label>Write the reason</label><input name="other_reason" maxlength="200" placeholder="Why is this website rejected?"></div>`, 'reject', 'Reject website'),
  bossedit: el => {
    const w = site(el.dataset.id);
    const sts = ['boss_review', 'approved', 'link_ready', 'rejected'];
    need(w.id, 'Save changes', `<label>Status</label><select name="status">${sts.map(s => `<option value="${s}" ${s === w.status ? 'selected' : ''}>${ST[s].label}</option>`).join('')}</select>
      <div id="rejwrap" class="${w.status === 'rejected' ? '' : 'hidden'}"><label>Reject reason</label><input name="reject_reason" maxlength="200" value="${esc(w.reject_reason || '')}" placeholder="Why is this website rejected?"></div>
      <label>Possible links</label><input type="number" name="possible_links" min="1" required value="${w.possible_links ?? 1}">
      <label>Target URL</label><input name="target_url" value="${esc(w.target_url || '')}" placeholder="https://…">
      <label>Anchor text</label><input name="anchor_text" value="${esc(w.anchor_text || '')}">`, 'bossedit', 'Edit ' + w.domain);
  },
  addlink: el => need(el.dataset.id, 'Save link', linkFields, 'addlink', 'Add link'),
  invoice: el => upd(el.dataset.id, { status: 'invoice_received' }, 'Status: Invoice Received'),
  paid: el => upd(el.dataset.id, { status: 'paid' }, 'Status: Paid'),
  theirlive: el => upd(el.dataset.id, { their_link_live: true }, 'Exchange completed'),
  nextlink: el => {
    const w = site(el.dataset.id);
    const q0 = queueOf(w)[0] || {};
    need(w.id, 'Add next link', (queueOf(w).length ? `<p class="hint">${queueOf(w).length} link(s) waiting in the queue. The first one is filled in below.</p>` : '') + linkFieldsFor(q0.target_url, q0.anchor_text) + (w.deal_type === 'paid' ? `<label>Price for this link ($)</label><input type="number" min="0" step="0.01" name="price" value="${w.price ?? ''}">` : ''), 'nextlink', ownBoss(w) ? `Next link (${linkNo(w) + 1})` : `Next link (${linkNo(w) + 1} / ${w.possible_links})`);
  },
};

function parseRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  const delim = text.includes('\t') && !text.includes(',') ? '\t' : ',';
  const endRow = () => { row.push(cur.trim()); cur = ''; if (row.some(x => x)) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n') endRow();
    else if (ch !== '\r') cur += ch;
  }
  endRow();
  return rows;
}

const forms = {
  async login(f, d) {
    const { error } = await sb.auth.signInWithPassword({ email: txt(d.get('email')), password: d.get('password') });
    if (error) showLogin(/invalid/i.test(error.message) ? 'Wrong email or password.' : error.message, 'err');
  },
  async signup(f, d) {
    const { data, error } = await sb.auth.signUp({ email: txt(d.get('email')), password: d.get('password'), options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return showLogin(/database|not been invited|signups/i.test(error.message) ? "This email hasn't been invited yet. Ask your manager." : error.message, 'err');
    if (!data.session) { S.mode = 'in'; showLogin('Account created. Check your email to confirm it, then sign in.'); }
  },
  async reset(f, d) {
    const { error } = await sb.auth.resetPasswordForEmail(txt(d.get('email')), { redirectTo: location.origin + location.pathname });
    if (error) return showLogin(error.message, 'err');
    S.mode = 'in'; showLogin('If that email has an account, a reset link is on its way.');
  },
  async newpw(f, d) {
    const { error } = await sb.auth.updateUser({ password: d.get('password') });
    if (error) return toast(error.message, 'err');
    S.recovery = false; toast('Password updated'); boot();
  },
  async name(f, d) {
    const { error } = await sb.rpc('set_my_name', { n: d.get('name') });
    if (error) return toast(errMsg(error), 'err');
    boot();
  },
  async site(f, d) {
    const paid = d.get('deal_type') === 'paid';
    const row = { url: txt(d.get('url')), contact_email: txt(d.get('contact_email')), deal_type: d.get('deal_type'), da: num(d.get('da')), traffic: txt(d.get('traffic')), price: paid ? num(d.get('price')) : null, notes: txt(d.get('notes')) };
    if (f.dataset.id && eff().role === 'boss') { row.target_url = txt(d.get('target_url')); row.anchor_text = txt(d.get('anchor_text')); }
    if (!normDomain(row.url).includes('.')) return toast('Enter a valid website URL', 'err');
    const id = f.dataset.id;
    const { error } = id ? await sb.from('websites').update(row).eq('id', id) : await sb.from('websites').insert({ ...row, member_id: S.profile.id });
    if (error) return toast(errMsg(error), 'err');
    toast(id ? 'Saved' : S.profile.role === 'boss' ? 'Website added. It is approved.' : 'Website added. It will be reviewed.'); closeDrawer(); refreshSoon();
  },
  async live(f, d) {
    let invoice = txt(d.get('invoice_url'));
    const file = d.get('invoice_file');
    if (file && file.size) {
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return toast('The invoice must be a PDF file', 'err');
      if (file.size > 10 * 1024 * 1024) return toast('The PDF is larger than 10 MB', 'err');
      const path = `${S.profile.id}/${crypto.randomUUID()}.pdf`;
      const up = await sb.storage.from('invoices').upload(path, file, { contentType: 'application/pdf' });
      if (up.error) return toast(errMsg(up.error), 'err');
      invoice = sb.storage.from('invoices').getPublicUrl(path).data.publicUrl;
    }
    return upd(f.dataset.id, { status: 'live', live_url: txt(d.get('live_url')), their_link: txt(d.get('their_link')), invoice_url: invoice }, 'Status: Live');
  },
  approve: (f, d) => upd(f.dataset.id, { status: 'approved', possible_links: num(d.get('possible_links')), reject_reason: null }, 'Status: Approved'),
  approvelink(f, d) {
    const more = moreLinks(d);
    if (!more) return;
    return upd(f.dataset.id, { status: 'link_ready', possible_links: Math.max(num(d.get('possible_links')) || 1, 1 + more.length), target_url: txt(d.get('target_url')), anchor_text: txt(d.get('anchor_text')), queued_links: more, reject_reason: null }, 'Status: Link Ready');
  },
  reject: (f, d) => {
    const other = txt(d.get('other_reason'));
    if (d.get('reason') === 'Other' && !other) return toast('Please write the reason', 'err');
    return upd(f.dataset.id, { status: 'rejected', reject_reason: d.get('reason') === 'Other' ? other : d.get('reason') }, 'Status: Rejected');
  },
  bossedit(f, d) {
    const status = d.get('status'), reason = txt(d.get('reject_reason'));
    if (status === 'rejected' && !reason) return toast('Please write the reject reason', 'err');
    return upd(f.dataset.id, { status, reject_reason: status === 'rejected' ? reason : null, possible_links: Math.max(1, num(d.get('possible_links')) || 1), target_url: txt(d.get('target_url')), anchor_text: txt(d.get('anchor_text')) }, 'Saved');
  },
  addlink(f, d) {
    const more = moreLinks(d);
    if (!more) return;
    const w = site(f.dataset.id), queue = queueOf(w).concat(more);
    return upd(f.dataset.id, { status: 'link_ready', target_url: txt(d.get('target_url')), anchor_text: txt(d.get('anchor_text')), queued_links: queue, possible_links: Math.max(w.possible_links || 1, linkNo(w) + queue.length) }, 'Status: Link Ready');
  },
  async nextlink(f, d) {
    const more = moreLinks(d);
    if (!more) return;
    const w = site(f.dataset.id);
    const { error } = await sb.rpc('add_next_link', { p_id: f.dataset.id, p_target: d.get('target_url'), p_anchor: d.get('anchor_text'), p_price: num(d.get('price')) });
    if (error) return toast(errMsg(error), 'err');
    const queue = queueOf(w).slice(1).concat(more);
    if (queueOf(w).length || more.length) await sb.from('websites').update({ queued_links: queue, possible_links: Math.max(w.possible_links || 1, linkNo(w) + 1 + queue.length) }).eq('id', f.dataset.id);
    toast('Status: Link Ready'); closeDrawer(); refreshSoon();
  },
  async editlink(f, d) {
    const w = site(f.dataset.id), i = +f.dataset.i, k = f.dataset.k;
    const keys = k === 'links' ? ['target_url', 'anchor_text'] : k === 'exch' ? ['target_url', 'anchor_text', 'live_url', 'their_link'] : ['target_url', 'invoice_url'];
    const vals = Object.fromEntries(keys.map(n => [n, txt(d.get(n))]));
    if (k === 'links' && i < 0 && d.get('possible_links') != null) vals.possible_links = Math.max(1, num(d.get('possible_links')) || 1);
    if (i < 0) return upd(w.id, vals, 'Saved');
    const history = hist(w).map((x, n) => (n === i ? { ...x, ...vals } : x));
    return upd(w.id, { link_history: history }, 'Saved');
  },
  changereq: (f, d) => upd(f.dataset.id, { change_request: txt(d.get('note')) }, 'Request sent to admin'),
  async rolepw(f, d) {
    const pr = S.pendingRole;
    if (!pr) return closeDrawer();
    const check = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { error: pe } = await check.auth.signInWithPassword({ email: S.session.user.email, password: d.get('password') });
    if (pe) return toast('Wrong password', 'err');
    const { error } = await sb.rpc('set_user_role', { p_id: pr.id, p_role: pr.role });
    S.pendingRole = null; closeDrawer();
    if (error) { toast(errMsg(error), 'err'); return refreshSoon(); }
    toast('Role updated'); await loadData(); render();
  },
  async invite(f, d) {
    const email = txt(d.get('email')).toLowerCase();
    if (S.people.some(p => (p.email || '').toLowerCase() === email)) return toast('That user already has an account', 'err');
    const { error } = await sb.from('invites').upsert({ email, role: d.get('role') === 'boss' ? 'boss' : 'member' });
    if (error) return toast(errMsg(error), 'err');
    toast('Invite added'); f.reset(); refreshSoon();
  },
  async rates(f, d) {
    const [a, b] = await Promise.all([
      sb.from('settings').update({ team_rate: num(d.get('team_rate')) }).eq('id', 1),
      sb.from('private_settings').update({ boss_rate: num(d.get('boss_rate')) }).eq('id', 1)]);
    if (a.error || b.error) return toast(errMsg(a.error || b.error), 'err');
    S.teamRate = num(d.get('team_rate')); S.bossRate = num(d.get('boss_rate'));
    toast('Rates saved'); render();
  },
  async import(f, d) {
    const members = S.people.filter(p => p.role === 'member');
    const seen = new Set(S.sites.map(w => w.domain));
    let ok = 0; const skipped = [];
    for (const c of parseRows(String(d.get('rows')))) {
      if (/^(url|website|domain)$/i.test(c[0])) continue;
      const dom = normDomain(c[0]);
      const who = (c[4] || '').toLowerCase();
      const m = !who ? S.profile : members.find(p => [p.name, p.email].some(x => x && x.toLowerCase() === who));
      if (!dom.includes('.')) { skipped.push(`${c[0]}: invalid URL`); continue; }
      if (seen.has(dom)) { skipped.push(`${dom}: duplicate`); continue; }
      if (!m) { skipped.push(`${dom}: unknown member "${c[4]}"`); continue; }
      const paid = /paid/i.test(c[2] || '');
      const { error } = await sb.from('websites').insert({ url: c[0], contact_email: c[1] || null, deal_type: paid ? 'paid' : 'exchange', price: paid ? num(c[3]) : null, da: num(c[5]), traffic: c[6] || null, member_id: m.id });
      if (error) { skipped.push(`${dom}: ${errMsg(error)}`); continue; }
      seen.add(dom); ok++;
    }
    $('#importres').innerHTML = `<p><b>${ok}</b> imported, <b>${skipped.length}</b> skipped.</p>${skipped.length ? `<div class="warn">${skipped.map(esc).join('<br>')}</div>` : ''}`;
    toast(`Imported ${ok}, skipped ${skipped.length}`); refreshSoon();
  },
};

const changes = {
  async personrate(t) {
    const v = num(t.value);
    if (v == null || v < 0) { toast('Enter a valid rate', 'err'); return render(); }
    const { error } = await sb.rpc('set_person_rate', { p_id: t.dataset.id, p_rate: v });
    if (error) { toast(errMsg(error), 'err'); return render(); }
    toast('Rate saved'); await loadData(); render();
  },
  csvfile(t) {
    const file = t.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => { const ta = $('textarea[name=rows]'); if (ta) ta.value = String(r.result).replace(/^\uFEFF/, ''); toast(`Loaded ${file.name}. Check the rows, then click Import.`); };
    r.readAsText(file);
  },
  userrole(t) {
    const p = S.people.find(x => x.id === t.dataset.id);
    const role = t.value;
    t.value = p ? p.role : role;
    S.pendingRole = { id: t.dataset.id, role };
    openDrawer('Confirm your password', `<form data-form="rolepw"><p class="hint">Changing ${esc(p ? (p.name || p.email) : 'this user')} to <b>${role === 'boss' ? 'Director' : 'Team member'}</b>. Enter your password to confirm.</p>
      <label>Your password</label><input type="password" name="password" required autocomplete="current-password" autofocus>
      <div style="margin-top:14px"><button class="btn primary" type="submit">Confirm change</button></div></form>`, 'confirm');
  },
  async myname(t) {
    const n = t.value.trim();
    if (!n || n === S.profile.name) { t.value = S.profile.name; return; }
    const { error } = await sb.rpc('set_my_name', { n });
    if (error) { t.value = S.profile.name; return toast(errMsg(error), 'err'); }
    S.profile.name = n; toast('Name updated'); refreshSoon();
  },
  preview: t => { S.preview = t.value ? S.people.find(p => p.id === t.value) : null; render(); },
  mmember: t => { S.mf.member = t.value; render(); },
  mdeal: t => { S.mf.deal = t.value; render(); },
  month: t => { if (t.value) { S.month = t.value; render(); } },
};
const inputs = {
  mq: t => { S.mf.q = t.value; render(); },
  memq: t => { S.mem.q = t.value; render(); },
  bq: t => { S.bossQ = t.value; render(); },
};

let dupTimer;
async function checkDup(input) {
  const form = input.form, box = $('#dup', form), btn = $('[type=submit]', form);
  const d = normDomain(input.value);
  if (!d.includes('.')) { box.innerHTML = ''; btn.disabled = false; return; }
  const { data } = await sb.from('domains').select('member_name,website_id').eq('domain', d).maybeSingle();
  if (normDomain(input.value) !== d) return;
  if (data && data.website_id !== form.dataset.id) {
    box.innerHTML = `<div class="warn">This website is already in the tracker (added by ${esc(data.member_name || 'a team member')}). Don't work on it.</div>`;
    btn.disabled = true;
  } else { box.innerHTML = ''; btn.disabled = false; }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  if (readOnly() && WRITE.has(el.dataset.act)) return toast('Preview is read-only', 'err');
  actions[el.dataset.act](el);
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  if (readOnly()) return toast('Preview is read-only', 'err');
  const btn = $('[type=submit]', f);
  if (btn) btn.disabled = true;
  await forms[f.dataset.form](f, new FormData(f));
  if (btn && btn.isConnected) btn.disabled = false;
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.change) changes[t.dataset.change](t);
  if (t.name === 'status' && $('#rejwrap')) $('#rejwrap').classList.toggle('hidden', t.value !== 'rejected');
  if (t.name === 'reason') { const o = $('#otherwrap'); if (o) o.classList.toggle('hidden', t.value !== 'Other'); }
  if (t.name === 'deal_type') { const p = $('#pricewrap'); if (p) p.classList.toggle('hidden', t.value !== 'paid'); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.input) inputs[t.dataset.input](t);
  if (t.dataset.dup) { clearTimeout(dupTimer); dupTimer = setTimeout(() => checkDup(t), 300); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.drawer) closeDrawer(); });

// ---------- start ----------
if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.startsWith('YOUR_') || !window.supabase) {
  app.innerHTML = `<div class="center"><div class="panel"><h1>Setup needed</h1>
    <p>Add your Supabase URL and anon key to <code>config.js</code>, then run <code>schema.sql</code> in the Supabase SQL editor.</p></div></div>`;
} else {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((event, session) => {
    S.session = session;
    if (event === 'PASSWORD_RECOVERY') { S.recovery = true; showNewPassword(); return; }
    if (!session) { if (S.chan) sb.removeChannel(S.chan); S.chan = null; S.preview = null; showLogin(); return; }
    if (S.recovery) return;
    if (event === 'INITIAL_SESSION' || (event === 'SIGNED_IN' && !S.profile)) setTimeout(boot, 0);
  });
}
})();
