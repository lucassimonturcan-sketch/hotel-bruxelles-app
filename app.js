// Application « Hôtel Bruxelles » : parler à l'agent du site via les tickets GitHub
const REPO = 'lucassimonturcan-sketch/hotel-bruxelles';
const SITE = 'https://www.andorrahotelbruxelles.com/fr/';
const API = 'https://api.github.com';
const VAPID_PUBLIC = ''; // clé publique des notifications (variable VAPID_PUBLIC_KEY du dépôt)
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
    .filter(l => !/View job|Create PR|claude\/issue-|Claude finished|Claude Code is working|spinner|I'll analyze|Todo List|^\s*Aperçu ?:|^\s*-{3,}\s*$|^\s*—+\s*$/i.test(l))
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
  if (labels.includes('publier')) return ['tag--work', 'Publication…'];
  if (labels.includes('a-valider')) return ['tag--wait', 'Aperçu à valider'];
  return ['', ''];
}
async function showList() {
  stopPoll(); current = null; header('Hôtel Bruxelles', 'Vos conversations', false);
  compose.classList.remove('hidden'); txt.placeholder = 'Nouvelle conversation…'; setHint();
  main.innerHTML = '<div class="wrap"><div class="empty">Chargement…</div></div>';
  const items = await api(`/repos/${REPO}/issues?labels=app&state=all&per_page=50&sort=updated`);
  const card = i => { const [c, t] = status(i); return `<button class="card" data-n="${i.number}"><h3>${esc(i.title)}</h3>${t ? `<span class="tag ${c}">${t}</span>` : ''}<span class="meta">${ago(i.updated_at)}</span></button>`; };
  const canNotif = VAPID_PUBLIC && 'PushManager' in window && 'Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied';
  main.innerHTML = `<div class="wrap list">
    ${canNotif ? '<button class="btn btn--dark" id="notif" style="margin-bottom:14px">🔔 Être prévenu quand Claude répond</button>' : ''}
    <div class="sec">Nouvelle conversation : écrivez en bas</div>
    ${items.length ? '<div class="sec">Conversations</div>' + items.map(card).join('') : '<div class="empty">Écrivez ci-dessous ce que vous voulez changer sur le site, ou une idée.</div>'}</div>`;
  main.querySelectorAll('[data-n]').forEach(b => b.onclick = () => showThread(+b.dataset.n));
  if ($('#notif')) $('#notif').onclick = enableNotif;
  if (items.some(i => i.labels.some(l => ['en-cours', 'publier'].includes(l.name)))) poll = setTimeout(showList, 15000);
}

/* ---------- Conversation ---------- */
async function loadImg(path, ref = 'apercus') {
  if (imgCache[path]) return imgCache[path];
  const r = await api(`/repos/${REPO}/contents/${path}?ref=${ref}`, { raw: true, headers: { Accept: 'application/vnd.github.raw' } });
  return (imgCache[path] = URL.createObjectURL(await r.blob()));
}
async function showThread(n, keepScroll) {
  stopPoll(); current = n;
  const [issue, comments] = await Promise.all([api(`/repos/${REPO}/issues/${n}`), api(`/repos/${REPO}/issues/${n}/comments?per_page=100`)]);
  if (current !== n) return;
  header(issue.title, status(issue)[1] || 'Conversation', true);
  compose.classList.remove('hidden'); txt.placeholder = 'Écrire à Claude…'; setHint();
  const working = issue.labels.some(l => l.name === 'en-cours');
  const publishing = issue.labels.some(l => l.name === 'publier');
  const all = [{ user: issue.user, body: issue.body || '', created_at: issue.created_at }, ...comments];
  const lastShot = all.map(c => /<!--apercu:/.test(c.body)).lastIndexOf(true);
  const settled = all.slice(lastShot + 1).some(c => /<!--(publie|annule)-->/.test(c.body));
  const lastBot = all.map(c => c.user.login === 'claude[bot]').lastIndexOf(true);
  const html = [];
  all.forEach((c, k) => {
    const b = c.body || '';
    if (/<!--publie-->/.test(b)) return html.push(`<div class="m m--sys">✅ Publié sur le site · ${ago(c.created_at)}</div>`);
    if (/<!--echec-->/.test(b)) return html.push(`<div class="m m--sys">⚠️ La publication n’a pas pu se faire. Rien n’a changé sur le site. Prévenez Lucas.</div>`);
    if (/<!--annule-->/.test(b)) return html.push(`<div class="m m--sys">Modification annulée, rien n’a changé sur le site</div>`);
    const shot = b.match(/<!--apercu:(\S+) ([^>]*?)-->/);
    if (shot) {
      const files = shot[2].trim().split(/\s+/);
      const acts = k === lastShot && !settled && !working && !publishing
        ? `<div class="acts"><button class="btn btn--ok" data-pub="${shot[1]}">✅ Publier</button><button class="btn btn--line" data-edit>✏️ Modifier</button><button class="btn btn--no" data-cancel="${shot[1]}">✕ Annuler</button></div>` : '';
      return html.push(`<div class="m m--ai"><div class="who">APERÇU</div><p>Voici à quoi ça ressemble (téléphone et ordinateur) :</p><div class="shots">${files.map(f => `<img data-src="${f}" alt="Aperçu">`).join('')}</div>${acts}</div>`);
    }
    if (c.user.type === 'Bot' || /\[bot\]$/.test(c.user.login)) {
      // pendant le travail, le message provisoire de Claude (en anglais) est remplacé par « Claude travaille… »
      if (working && k === lastBot) return;
      const t = cleanAI(b); if (t) html.push(`<div class="m m--ai"><div class="who">CLAUDE</div>${md(t)}</div>`);
    } else {
      const pics = [...b.matchAll(/<!--photo:(\S+)-->/g)].map(x => x[1]);
      const t = userText(b.replace(/^📷 Photo jointe.*$/gm, ''));
      if (t || pics.length) html.push(`<div class="m m--me">${t ? md(t) : ''}${pics.length ? `<div class="shots">${pics.map(f => `<img data-src="${f}" data-ref="envois" alt="Photo envoyée">`).join('')}</div>` : ''}</div>`);
    }
  });
  const waiting = working || publishing || (waitingSince && Date.now() - waitingSince < 90000);
  if (waiting) html.push(`<div class="typing"><i></i><i></i><i></i>${publishing ? 'Publication en cours… (1 à 2 min)' : 'Claude travaille… (1 à 3 min)'}</div>`);
  main.innerHTML = `<div class="wrap"><div class="msgs">${html.join('')}</div></div>`;
  main.querySelectorAll('img[data-src]').forEach(async im => { im.src = await loadImg(im.dataset.src, im.dataset.ref || 'apercus'); im.onclick = () => zoom(im.src); });
  main.querySelectorAll('[data-pub]').forEach(b => b.onclick = () => publish(issue, b.dataset.pub, b));
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { txt.placeholder = 'Que faut-il changer ?'; txt.focus(); });
  main.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => cancel(issue, b.dataset.cancel));
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
  const t = txt.value.trim(); if (!t && !photos.length) return;
  if (!t) return alert('Écrivez aussi où mettre la photo (par exemple : « mets cette photo en premier sur la page Restaurant »).');
  $('#send').disabled = true; $('#send').textContent = '…';
  let body = '@claude ' + (mode === 'idea' ? '[Idée] ' : '') + t;
  try { body += await uploadPhotos(); } catch (e) { $('#send').disabled = false; $('#send').textContent = '➤'; return alert("La photo n'a pas pu être envoyée. Réessayez."); }
  try {
    if (current) {
      await api(`/repos/${REPO}/issues/${current}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
      await api(`/repos/${REPO}/issues/${current}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    }
    else {
      const title = (mode === 'idea' ? '💡 ' : '') + (t.length > 60 ? t.slice(0, 57).trim() + '…' : t);
      const i = await api(`/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({ title, body, labels: ['app'] }) });
      current = i.number;
    }
    txt.value = ''; photos = []; drawThumbs(); autosize(); waitingSince = Date.now(); showThread(current);
  } catch (e) { alert("L'envoi n'a pas marché. Vérifiez la connexion internet et réessayez."); }
  $('#send').disabled = false; $('#send').textContent = '➤';
}
async function publish(issue, branch, btn) {
  if (!confirm('Mettre cette modification en ligne sur le vrai site ?')) return;
  btn.disabled = true; btn.textContent = 'Publication…';
  try {
    // GitHub fusionne, reconstruit le site et l'envoie chez Dinatur (workflow « Publier une demande »)
    const r = await api(`/repos/${REPO}/issues/${issue.number}/labels`, { method: 'POST', body: JSON.stringify({ labels: ['publier'] }) });
    if (r && r._err) throw new Error('GitHub ' + r._err);
    waitingSince = Date.now(); showThread(issue.number);
  } catch (e) {
    btn.disabled = false; btn.textContent = '✅ Publier';
    alert('La publication a échoué (' + (e.message || 'erreur') + '). Prévenez Lucas.');
  }
}
async function cancel(issue, branch) {
  if (!confirm('Annuler cette modification ? Rien ne sera changé sur le site, et vous pourrez continuer la conversation.')) return;
  await api(`/repos/${REPO}/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: '<!--annule-->\nModification annulée depuis l’application.' }) });
  if (branch) await api(`/repos/${REPO}/git/refs/heads/${branch}`, { method: 'DELETE' });
  await api(`/repos/${REPO}/issues/${issue.number}/labels/a-valider`, { method: 'DELETE' });
  showThread(issue.number);
}


/* ---------- Notifications ---------- */
const b64 = s => btoa(unescape(encodeURIComponent(s)));
function keyBytes(k) { const p = '='.repeat((4 - k.length % 4) % 4), r = atob((k + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); }
async function enableNotif() {
  try {
    if (await Notification.requestPermission() !== 'granted') return alert('Les notifications sont refusées. Vous pourrez les activer dans Réglages › Notifications.');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) });
    // l'abonnement est rangé dans le dépôt (branche « notifications ») pour que GitHub puisse prévenir ce téléphone
    const br = await api(`/repos/${REPO}/branches/notifications`);
    if (br._err) { const m = await api(`/repos/${REPO}/git/ref/heads/main`); await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/notifications', sha: m.object.sha }) }); }
    const id = (await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint))), h = [...new Uint8Array(id)].slice(0, 6).map(x => x.toString(16).padStart(2, '0')).join('');
    const path = `abonnements/${me}-${h}.json`;
    const old = await api(`/repos/${REPO}/contents/${path}?ref=notifications`);
    await api(`/repos/${REPO}/contents/${path}`, { method: 'PUT', body: JSON.stringify({ message: 'Notifications : ' + me, branch: 'notifications', content: b64(JSON.stringify({ login: me, sub })), ...(old.sha ? { sha: old.sha } : {}) }) });
    alert('C’est activé ! Vous serez prévenu dès que Claude répond.'); showList();
  } catch (e) { alert('Activation impossible (' + e.message + '). L’application doit être ouverte depuis l’écran d’accueil.'); }
}


/* ---------- Photos ---------- */
let photos = [];
async function ensureBranch(name) {
  const br = await api(`/repos/${REPO}/branches/${name}`);
  if (!br._err) return;
  const m = await api(`/repos/${REPO}/git/ref/heads/main`);
  await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + name, sha: m.object.sha }) });
}
// réduit la photo (2000 px max, JPEG) pour un envoi rapide ; Claude la prépare ensuite pour le site
function shrink(file) {
  return new Promise((ok, ko) => {
    const im = new Image(); im.onerror = ko;
    im.onload = () => {
      const k = Math.min(1, 2000 / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      ok(c.toDataURL('image/jpeg', 0.88));
    };
    im.src = URL.createObjectURL(file);
  });
}
function drawThumbs() {
  $('#thumbs').innerHTML = photos.map((p, i) => `<div><img src="${p}" alt=""><button data-i="${i}" aria-label="Retirer">×</button></div>`).join('');
  $('#thumbs').querySelectorAll('button').forEach(b => b.onclick = () => { photos.splice(+b.dataset.i, 1); drawThumbs(); });
  if (photos.length && !txt.value) txt.placeholder = 'Où faut-il mettre cette photo ?';
}
async function uploadPhotos() {
  if (!photos.length) return '';
  await ensureBranch('envois');
  let out = '';
  for (const [i, p] of photos.entries()) {
    const path = `envois/${new Date().toISOString().slice(0, 10)}/${me}-${Date.now()}-${i + 1}.jpg`;
    const r = await api(`/repos/${REPO}/contents/${path}`, { method: 'PUT', body: JSON.stringify({ message: 'Photo envoyée depuis l’application', branch: 'envois', content: p.split(',')[1] }) });
    if (!r || r._err) throw new Error('envoi');
    out += `\n<!--photo:${path}-->\n📷 Photo jointe : \`${path}\``;
  }
  return out;
}
$('#pic').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  for (const f of [...e.target.files].slice(0, 6 - photos.length)) photos.push(await shrink(f));
  e.target.value = ''; drawThumbs();
};

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
const startN = +new URLSearchParams(location.search).get('n');
token ? (startN ? showThread(startN) : showList()).catch(() => showLogin('Connexion impossible pour le moment.')) : showLogin();
