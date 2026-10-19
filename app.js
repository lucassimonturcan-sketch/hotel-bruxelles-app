// Application « Hôtel Bruxelles » : parler à l'agent du site via les tickets GitHub
const REPO = 'lucassimonturcan-sketch/hotel-bruxelles';
const SITE = 'https://www.andorrahotelbruxelles.com/fr/';
const API = 'https://api.github.com';
const $ = s => document.querySelector(s);
const main = $('#main'), compose = $('#compose'), txt = $('#txt');
let token = localStorage.getItem('hb_token') || '';
let me = localStorage.getItem('hb_me') || '';
let current = null, mode = 'do', poll = null, waitingSince = 0;
const imgCache = {};

async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (r.status === 401) { logout(); throw new Error('Code refusé'); }
  if (!r.ok && r.status !== 404 && r.status !== 422) throw new Error('GitHub ' + r.status);
  if (r.status === 204) return null;
  return opts.raw ? r : r.json().then(j => (r.ok ? j : { _err: r.status, ...j }));
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function md(s) {
  const out = [];
  for (const block of s.trim().split(/\n{2,}/)) {
    const lines = block.split('\n');
    const inl = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    if (lines.every(l => /^\s*([-*]|\d+\.)\s/.test(l)))
      out.push('<ul>' + lines.map(l => '<li>' + inl(l.replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/^\[x\]\s*/i, '✓ ').replace(/^\[ \]\s*/, '○ ')) + '</li>').join('') + '</ul>');
    else out.push('<p>' + lines.map(l => inl(l.replace(/^#+\s*/, ''))).join('<br>') + '</p>');
  }
  return out.join('');
}
// Nettoie les messages de Claude (en-têtes techniques, liens de branche…)
function cleanAI(b) {
  return b.replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .filter(l => !/View job|Create PR|claude\/issue-|Claude finished|Claude Code is working|spinner|^\s*-{3,}\s*$|^\s*—+\s*$/i.test(l))
    .join('\n').replace(/<img[^>]*>/g, '').trim();
}
const userText = b => b.replace(/<!--[\s\S]*?-->/g, '').replace(/@claude\s*/gi, '').replace(/^\[Idée\]\s*/i, '💡 ').trim();
const ago = d => { const m = Math.round((Date.now() - new Date(d)) / 60000); return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); };

function header(title, sub, back) {
  $('#title').innerHTML = esc(title) + (sub ? `<small>${esc(sub)}</small>` : '');
  $('#back').classList.toggle('hidden', !back);
  $('#site').classList.toggle('hidden', !token);
}

/* ---------- Connexion ---------- */
function showLogin(err) {
  stopPoll(); compose.classList.add('hidden'); header('Hôtel Bruxelles', 'Assistant du site');
  main.innerHTML = `<div class="login"><div class="logo">HB</div><h2>Bienvenue</h2>
    <p>Entrez votre code d'accès personnel. Il est enregistré sur ce téléphone, une seule fois.</p>
    <input id="tok" type="password" autocomplete="off" placeholder="Code d'accès (github_pat_…)">
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <button class="btn btn--gold" id="go">Entrer</button></div>`;
  $('#go').onclick = async () => {
    token = $('#tok').value.trim(); if (!token) return;
    try {
      const u = await api('/user'); const r = await api('/repos/' + REPO);
      if (!u.login || r._err) throw new Error();
      me = u.login; localStorage.setItem('hb_token', token); localStorage.setItem('hb_me', me); showList();
    } catch { token = ''; showLogin('Ce code ne fonctionne pas. Vérifiez-le ou demandez-en un nouveau à Lucas.'); }
  };
}
function logout() { localStorage.removeItem('hb_token'); token = ''; showLogin(); }

/* ---------- Liste des demandes ---------- */
function status(i) {
  const labels = i.labels.map(l => l.name);
  if (labels.includes('en-cours')) return ['tag--work', 'Claude travaille…'];
  if (i.state === 'closed') return i.state_reason === 'not_planned' ? ['', 'Annulée'] : ['tag--ok', 'Publiée'];
  return ['tag--wait', 'À regarder'];
}
async function showList() {
  stopPoll(); current = null; header('Hôtel Bruxelles', 'Vos demandes', false);
  compose.classList.remove('hidden'); txt.placeholder = 'Nouvelle demande…'; setHint();
  main.innerHTML = '<div class="wrap"><div class="empty">Chargement…</div></div>';
  const items = await api(`/repos/${REPO}/issues?labels=app&state=all&per_page=40&sort=updated`);
  const open = items.filter(i => i.state === 'open'), closed = items.filter(i => i.state === 'closed');
  const card = i => { const [c, t] = status(i); return `<button class="card" data-n="${i.number}"><h3>${esc(i.title)}</h3><span class="tag ${c}">${t}</span><span class="meta">${ago(i.updated_at)}</span></button>`; };
  main.innerHTML = `<div class="wrap list">
    ${items.length ? '' : '<div class="empty">Aucune demande pour l’instant.<br>Écrivez ci-dessous ce que vous voulez changer sur le site, ou une idée.</div>'}
    ${open.length ? '<div class="sec">En cours</div>' + open.map(card).join('') : ''}
    ${closed.length ? '<div class="sec">Terminées</div>' + closed.slice(0, 15).map(card).join('') : ''}</div>`;
  main.querySelectorAll('[data-n]').forEach(b => b.onclick = () => showThread(+b.dataset.n));
  if (open.some(i => i.labels.some(l => l.name === 'en-cours'))) poll = setTimeout(showList, 15000);
}

/* ---------- Conversation ---------- */
async function loadImg(path) {
  if (imgCache[path]) return imgCache[path];
  const r = await api(`/repos/${REPO}/contents/${path}?ref=apercus`, { raw: true, headers: { Accept: 'application/vnd.github.raw' } });
  return (imgCache[path] = URL.createObjectURL(await r.blob()));
}
async function showThread(n, keepScroll) {
  stopPoll(); current = n;
  const [issue, comments] = await Promise.all([api(`/repos/${REPO}/issues/${n}`), api(`/repos/${REPO}/issues/${n}/comments?per_page=100`)]);
  if (current !== n) return;
  header(issue.title, status(issue)[1], true);
  compose.classList.toggle('hidden', issue.state === 'closed'); txt.placeholder = 'Répondre…'; setHint();
  const working = issue.labels.some(l => l.name === 'en-cours');
  const all = [{ user: issue.user, body: issue.body || '', created_at: issue.created_at }, ...comments];
  const lastShot = all.map(c => /<!--apercu:/.test(c.body)).lastIndexOf(true);
  const html = [];
  all.forEach((c, k) => {
    const b = c.body || '';
    if (/<!--publie-->/.test(b)) return html.push(`<div class="m m--sys">✅ Publié sur le site · ${ago(c.created_at)}</div>`);
    if (/<!--annule-->/.test(b)) return html.push(`<div class="m m--sys">Demande annulée</div>`);
    const shot = b.match(/<!--apercu:(\S+) ([^>]*?)-->/);
    if (shot) {
      const files = shot[2].trim().split(/\s+/);
      const acts = k === lastShot && issue.state === 'open' && !working
        ? `<div class="acts"><button class="btn btn--ok" data-pub="${shot[1]}">✅ Publier</button><button class="btn btn--line" data-edit>✏️ Modifier</button><button class="btn btn--no" data-cancel>✕ Annuler</button></div>` : '';
      return html.push(`<div class="m m--ai"><div class="who">APERÇU</div><p>Voici à quoi ça ressemble (téléphone et ordinateur) :</p><div class="shots">${files.map(f => `<img data-src="${f}" alt="Aperçu">`).join('')}</div>${acts}</div>`);
    }
    if (c.user.type === 'Bot' || /\[bot\]$/.test(c.user.login)) {
      const t = cleanAI(b); if (t) html.push(`<div class="m m--ai"><div class="who">CLAUDE</div>${md(t)}</div>`);
    } else {
      const t = userText(b); if (t) html.push(`<div class="m m--me">${md(t)}</div>`);
    }
  });
  const waiting = working || (waitingSince && Date.now() - waitingSince < 90000);
  if (waiting) html.push('<div class="typing"><i></i><i></i><i></i>Claude travaille… (1 à 3 min)</div>');
  main.innerHTML = `<div class="wrap"><div class="msgs">${html.join('')}</div></div>`;
  main.querySelectorAll('img[data-src]').forEach(async im => { im.src = await loadImg(im.dataset.src); im.onclick = () => zoom(im.src); });
  main.querySelectorAll('[data-pub]').forEach(b => b.onclick = () => publish(issue, b.dataset.pub, b));
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { txt.placeholder = 'Que faut-il changer ?'; txt.focus(); });
  main.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => cancel(issue));
  if (!keepScroll || waiting) main.scrollTop = main.scrollHeight;
  if (!working && waitingSince && Date.now() - waitingSince > 90000) waitingSince = 0;
  if (waiting) poll = setTimeout(() => showThread(n, true), 8000);
}
function zoom(src) {
  const z = document.createElement('div'); z.className = 'zoom';
  z.innerHTML = `<button aria-label="Fermer">×</button><img src="${src}" alt="">`;
  z.onclick = () => z.remove(); document.body.appendChild(z);
}

/* ---------- Actions ---------- */
async function send() {
  const t = txt.value.trim(); if (!t) return;
  $('#send').disabled = true;
  const body = '@claude ' + (mode === 'idea' ? '[Idée] ' : '') + t;
  try {
    if (current) await api(`/repos/${REPO}/issues/${current}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    else {
      const title = (mode === 'idea' ? '💡 ' : '') + (t.length > 60 ? t.slice(0, 57).trim() + '…' : t);
      const i = await api(`/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({ title, body, labels: ['app'] }) });
      current = i.number;
    }
    txt.value = ''; autosize(); waitingSince = Date.now(); showThread(current);
  } catch (e) { alert("L'envoi n'a pas marché. Vérifiez la connexion internet et réessayez."); }
  $('#send').disabled = false;
}
async function publish(issue, branch, btn) {
  if (!confirm('Mettre cette modification en ligne sur le vrai site ?')) return;
  btn.disabled = true; btn.textContent = 'Publication…';
  try {
    let pr = await api(`/repos/${REPO}/pulls`, { method: 'POST', body: JSON.stringify({ title: issue.title, head: branch, base: 'main', body: `Demande #${issue.number} (application Hôtel Bruxelles)` }) });
    if (pr._err) pr = (await api(`/repos/${REPO}/pulls?head=${REPO.split('/')[0]}:${branch}&state=open`))[0];
    const m = await api(`/repos/${REPO}/pulls/${pr.number}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }) });
    if (!m || m._err) throw new Error(m && m.message);
    await api(`/repos/${REPO}/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: '<!--publie-->\n✅ Publié depuis l’application. Le site sera à jour dans 2 à 3 minutes.' }) });
    await api(`/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
    alert('C’est publié ! Le site sera à jour dans 2 à 3 minutes.');
    showThread(issue.number);
  } catch (e) {
    btn.disabled = false; btn.textContent = '✅ Publier';
    alert('La publication a échoué (' + (e.message || 'erreur') + '). Prévenez Lucas.');
  }
}
async function cancel(issue) {
  if (!confirm('Annuler cette demande ? Rien ne sera changé sur le site.')) return;
  await api(`/repos/${REPO}/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: '<!--annule-->\nDemande annulée depuis l’application.' }) });
  await api(`/repos/${REPO}/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
  showList();
}

/* ---------- Saisie, dictée, mode ---------- */
function setHint() { $('#hint').textContent = mode === 'idea' ? 'Claude réfléchit avec vous, sans rien changer sur le site.' : 'Claude prépare la modification et vous montre un aperçu avant publication.'; }
function autosize() { txt.style.height = 'auto'; txt.style.height = Math.min(txt.scrollHeight, 160) + 'px'; }
txt.addEventListener('input', autosize);
$('#send').onclick = send;
$('#mode').onclick = e => { const b = e.target.closest('button'); if (!b) return; mode = b.dataset.m; document.querySelectorAll('#mode button').forEach(x => x.classList.toggle('on', x === b)); setHint(); };
$('#back').onclick = showList;
$('#site').onclick = () => window.open(SITE, '_blank');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  let rec = null;
  $('#mic').onclick = () => {
    if (rec) return rec.stop();
    rec = new SR(); rec.lang = 'fr-FR'; rec.interimResults = false; rec.continuous = true;
    const base = txt.value ? txt.value + ' ' : '';
    rec.onresult = e => { txt.value = base + [...e.results].map(r => r[0].transcript).join(' '); autosize(); };
    rec.onend = () => { rec = null; $('#mic').classList.remove('rec'); };
    rec.start(); $('#mic').classList.add('rec');
  };
} else $('#mic').classList.add('hidden');
function stopPoll() { clearTimeout(poll); poll = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) current ? showThread(current, true) : showList(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
token ? showList().catch(() => showLogin('Connexion impossible pour le moment.')) : showLogin();
