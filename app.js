// Application « Hôtel Bruxelles » : une seule conversation continue avec l'agent du site.
// Sous le capot, chaque série d'échanges est un ticket GitHub (une nouvelle série démarre
// après 3 h de calme) : l'affichage les met bout à bout, et Claude ne relit que la série en cours.
const REPO = 'lucassimonturcan-sketch/hotel-bruxelles';
const SITE = 'https://www.andorrahotelbruxelles.com/fr/';
const API = 'https://api.github.com';
const VAPID_PUBLIC = 'BPgWZnAIAiwx006B-UncHnhhIb120dsuy_XPxLa0zCGOHpQnlrekS1IEPuGEXTVQvy9KAIuBe4b8Do-cGN21b0g'; // clé publique des notifications (variable VAPID_PUBLIC_KEY du dépôt)
const NAMES = { 'lucassimonturcan-sketch': 'Lucas' }; // prénoms affichés au-dessus des messages de l'autre personne
const PAUSE = 3 * 3600e3;   // après 3 h sans échange, une nouvelle série commence
const HISTORY = 12;         // nombre de séries affichées
const $ = s => document.querySelector(s);
const main = $('#main'), compose = $('#compose'), txt = $('#txt');
let token = localStorage.getItem('hb_token') || '';
let me = localStorage.getItem('hb_me') || '';
let poll = null, waitingSince = 0, last = null, files = [];
const imgCache = {}, cCache = {};

async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (r.status === 401) { logout(); throw new Error('Code refusé'); }
  if (!r.ok && r.status !== 404 && r.status !== 422) throw new Error('GitHub ' + r.status);
  if (r.status === 204) return null;
  return opts.raw ? r : r.json().then(j => (r.ok ? j : { _err: r.status, ...j }));
}
const post = (path, body, method = 'POST') => api(`/repos/${REPO}${path}`, { method, body: JSON.stringify(body) });

/* ---------- Mise en forme ---------- */
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function md(s) {
  const out = [];
  for (const block of s.trim().split(/\n{2,}/)) {
    const lines = block.split('\n');
    const inl = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    if (lines.every(l => /^\s*([-*]|\d+\.)\s/.test(l)))
      out.push('<ul>' + lines.map(l => '<li>' + inl(l.replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/^\[[ x]\]\s*/i, '')) + '</li>').join('') + '</ul>');
    else out.push('<p>' + lines.map(l => inl(l.replace(/^#+\s*/, ''))).join('<br>') + '</p>');
  }
  return out.join('');
}
// messages de Claude : on retire les en-têtes techniques de GitHub
const cleanAI = b => b.replace(/<!--[\s\S]*?-->/g, '').split('\n')
  .filter(l => !/View job|Create PR|claude\/issue-|Claude finished|Claude Code is working|spinner|I'll analyze|Todo List|^\s*Aperçu ?:|^\s*-{3,}\s*$|^\s*—+\s*$/i.test(l))
  .join('\n').replace(/<img[^>]*>/g, '').trim();
const userText = b => b.replace(/<!--[\s\S]*?-->/g, '').replace(/^(📷 |📎 )?(Photo jointe|Fichier joint) .*$/gm, '').replace(/@claude\s*/gi, '').replace(/^\[Idée\]\s*/i, '').trim();
const dayLabel = d => new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const labelsOf = i => i.labels.map(l => l.name);

/* ---------- Connexion ---------- */
function showLogin(err) {
  stopPoll(); compose.classList.add('hidden'); $('#site').classList.add('hidden');
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
      me = u.login; localStorage.setItem('hb_token', token); localStorage.setItem('hb_me', me); showChat();
    } catch { token = ''; showLogin('Ce code ne fonctionne pas. Vérifiez-le ou demandez-en un nouveau à Lucas.'); }
  };
}
function logout() { localStorage.removeItem('hb_token'); token = ''; showLogin(); }

/* ---------- La conversation ---------- */
async function loadImg(path, ref) {
  if (imgCache[path]) return imgCache[path];
  const r = await api(`/repos/${REPO}/contents/${path}?ref=${ref}`, { raw: true, headers: { Accept: 'application/vnd.github.raw' } });
  return (imgCache[path] = URL.createObjectURL(await r.blob()));
}
function renderIssue(issue, comments) {
  const all = [{ user: issue.user, body: issue.body || '', created_at: issue.created_at }, ...comments];
  const L = labelsOf(issue), working = L.includes('en-cours'), publishing = L.includes('publier');
  const lastShot = all.map(c => /<!--apercu:/.test(c.body)).lastIndexOf(true);
  const settled = all.slice(lastShot + 1).some(c => /<!--(publie|annule)-->/.test(c.body));
  const lastBot = all.map(c => c.user.login === 'claude[bot]').lastIndexOf(true);
  const html = [`<div class="day">${dayLabel(issue.created_at)}</div>`];
  all.forEach((c, k) => {
    const b = c.body || '';
    if (/<!--publie-->/.test(b)) return html.push(`<div class="m m--sys">Publié sur le site</div>`);
    if (/<!--annule-->/.test(b)) return html.push(`<div class="m m--sys">Modification annulée, rien n’a changé sur le site</div>`);
    if (/<!--echec-->/.test(b)) return html.push(`<div class="m m--sys">La publication n’a pas pu se faire. Rien n’a changé sur le site. Prévenez Lucas.</div>`);
    const shot = b.match(/<!--apercu:(\S+) ([^>]*?)-->/);
    if (shot) {
      const acts = k === lastShot && !settled && !working && !publishing
        ? `<div class="acts"><button class="btn btn--ok" data-pub="${issue.number}">Publier</button><button class="btn btn--line" data-edit>Modifier</button><button class="btn btn--no" data-cancel="${issue.number}" data-branch="${shot[1]}">Annuler</button></div>` : '';
      return html.push(`<div class="m m--ai"><div class="cap">Aperçu sur téléphone et ordinateur</div><div class="shots">${shot[2].trim().split(/\s+/).map(f => `<img data-src="${f}" data-ref="apercus" alt="Aperçu">`).join('')}</div>${acts}</div>`);
    }
    if (c.user.type === 'Bot' || /\[bot\]$/.test(c.user.login)) {
      if (working && k === lastBot) return; // message provisoire (en anglais) remplacé par « L’agent travaille… »
      const t = cleanAI(b); if (t) html.push(`<div class="m m--ai">${md(t)}</div>`);
    } else {
      const pics = [...b.matchAll(/<!--photo:(\S+)-->/g)].map(x => x[1]);
      const docs = [...b.matchAll(/<!--fichier:(\S+)-->/g)].map(x => x[1].split('/').pop());
      const t = userText(b);
      if (t || pics.length || docs.length) html.push(`${c.user.login !== me ? `<div class="who-me">${esc(NAMES[c.user.login] || c.user.login)}</div>` : ''}<div class="m m--me">${t ? md(t) : ''}${pics.length ? `<div class="shots">${pics.map(f => `<img data-src="${f}" data-ref="envois" alt="Photo envoyée">`).join('')}</div>` : ''}${docs.map(d => `<div class="file">Fichier : ${esc(d)}</div>`).join('')}</div>`);
    }
  });
  return html.join('');
}
async function showChat() {
  stopPoll(); compose.classList.remove('hidden'); $('#site').classList.remove('hidden');
  if (!main.innerHTML || main.querySelector('.login')) main.innerHTML = '<div class="wrap"><div class="empty">Chargement…</div></div>';
  const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 120;
  const issues = (await api(`/repos/${REPO}/issues?labels=app&state=all&per_page=${HISTORY}&sort=created&direction=desc`)).reverse();
  // les commentaires ne sont rechargés que pour les séries qui ont bougé (économise les appels à GitHub)
  const comments = await Promise.all(issues.map(async i => {
    const c = cCache[i.number];
    if (c && c.at === i.updated_at) return c.list;
    const list = i.comments ? await api(`/repos/${REPO}/issues/${i.number}/comments?per_page=100`) : [];
    cCache[i.number] = { at: i.updated_at, list }; return list;
  }));
  last = issues[issues.length - 1] || null;
  const busy = issues.some(i => labelsOf(i).some(l => ['en-cours', 'publier'].includes(l)));
  const publishing = issues.some(i => labelsOf(i).includes('publier'));
  const waiting = busy || (waitingSince && Date.now() - waitingSince < 90000);
  if (!busy && waitingSince && Date.now() - waitingSince > 90000) waitingSince = 0;
  const canNotif = VAPID_PUBLIC && 'PushManager' in window && 'Notification' in window && Notification.permission === 'default';
  main.innerHTML = `<div class="wrap"><div class="msgs">
    ${issues.length ? '' : '<div class="m m--ai"><p>Bonjour. Je suis l’agent du site. Je connais tout le site de l’Hôtel Bruxelles. Posez-moi une question, proposez une idée ou dites-moi ce qu’il faut changer. Vous pouvez joindre des photos et des fichiers.</p></div>'}
    ${issues.map((i, n) => renderIssue(i, comments[n])).join('')}
    ${waiting ? `<div class="typing"><svg class="spark" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 6.2L20 6l-4.4 4.8L22 12l-6.4 1.2L20 18l-6.4-2.2L12 22l-1.6-6.2L4 18l4.4-4.8L2 12l6.4-1.2L4 6l6.4 2.2z"/></svg>${publishing ? 'Publication en cours… (1 à 2 min)' : 'L’agent travaille… (environ 1 min)'}</div>` : ''}
    ${canNotif ? '<button class="notif" id="notif">Être prévenu quand l’agent répond</button>' : ''}
  </div></div>`;
  main.querySelectorAll('img[data-src]').forEach(async im => { im.src = await loadImg(im.dataset.src, im.dataset.ref); im.onclick = () => zoom(im.src); });
  main.querySelectorAll('[data-pub]').forEach(b => b.onclick = () => publish(+b.dataset.pub, b));
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { txt.placeholder = 'Que faut-il changer ?'; txt.focus(); });
  main.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => cancel(+b.dataset.cancel, b.dataset.branch));
  if ($('#notif')) $('#notif').onclick = enableNotif;
  if (atBottom || waiting || !showChat.done) main.scrollTop = main.scrollHeight;
  showChat.done = true;
  poll = setTimeout(showChat, waiting ? 8000 : 60000);
}
function zoom(src) {
  const z = document.createElement('div'); z.className = 'zoom';
  z.innerHTML = `<button aria-label="Fermer">×</button><img src="${src}" alt="">`;
  z.onclick = () => z.remove(); document.body.appendChild(z);
}

/* ---------- Envoyer, publier, annuler ---------- */
async function send() {
  const t = txt.value.trim();
  if (!t && !files.length) return;
  if (!t) return alert('Écrivez aussi ce qu’il faut en faire (par exemple : « mets ces photos dans la galerie »).');
  $('#send').disabled = true; $('#send').disabled = true;
  try {
    const body = '@claude ' + t + await uploadFiles();
    // on continue la série en cours, sauf après une longue pause : Claude relit ainsi moins de choses
    const L = last ? labelsOf(last) : [];
    const keep = last && (L.some(l => ['en-cours', 'a-valider', 'publier'].includes(l)) || Date.now() - new Date(last.updated_at) < PAUSE);
    if (keep) {
      if (last.state === 'closed') await post(`/issues/${last.number}`, { state: 'open' }, 'PATCH');
      await post(`/issues/${last.number}/comments`, { body });
    } else {
      await post('/issues', { title: t.length > 60 ? t.slice(0, 57).trim() + '…' : t, body, labels: ['app'] });
    }
    txt.value = ''; files = []; drawThumbs(); autosize(); txt.placeholder = 'Écrire à l’agent…';
    waitingSince = Date.now(); showChat.done = false; showChat();
  } catch (e) { alert("L'envoi n'a pas marché. Vérifiez la connexion internet et réessayez."); }
  $('#send').disabled = false;
}
async function publish(n, btn) {
  if (!confirm('Mettre cette modification en ligne sur le vrai site ?')) return;
  btn.disabled = true; btn.textContent = 'Publication…';
  try {
    // GitHub fusionne, reconstruit le site et l'envoie chez Dinatur (workflow « Publier une demande »)
    const r = await post(`/issues/${n}/labels`, { labels: ['publier'] });
    if (r && r._err) throw new Error('GitHub ' + r._err);
    waitingSince = Date.now(); showChat();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Publier';
    alert('La publication a échoué (' + (e.message || 'erreur') + '). Prévenez Lucas.');
  }
}
async function cancel(n, branch) {
  if (!confirm('Annuler cette modification ? Rien ne sera changé sur le site.')) return;
  await post(`/issues/${n}/comments`, { body: '<!--annule-->\nModification annulée depuis l’application.' });
  if (branch) await api(`/repos/${REPO}/git/refs/heads/${branch}`, { method: 'DELETE' });
  await api(`/repos/${REPO}/issues/${n}/labels/a-valider`, { method: 'DELETE' });
  showChat();
}

/* ---------- Photos et fichiers ---------- */
const b64 = s => btoa(unescape(encodeURIComponent(s)));
async function ensureBranch(name) {
  const br = await api(`/repos/${REPO}/branches/${name}`);
  if (!br._err) return;
  const m = await api(`/repos/${REPO}/git/ref/heads/main`);
  await post('/git/refs', { ref: 'refs/heads/' + name, sha: m.object.sha });
}
// photos réduites à 2000 px (JPEG) pour un envoi rapide ; Claude les prépare ensuite pour le site
function shrink(file) {
  return new Promise((ok, ko) => {
    const im = new Image(); im.onerror = ko;
    im.onload = () => {
      const k = Math.min(1, 2000 / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      ok({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', data: c.toDataURL('image/jpeg', 0.88), img: true });
    };
    im.src = URL.createObjectURL(file);
  });
}
const readRaw = file => new Promise((ok, ko) => { const r = new FileReader(); r.onerror = ko; r.onload = () => ok({ name: file.name, data: r.result, img: false }); r.readAsDataURL(file); });
function drawThumbs() {
  $('#thumbs').innerHTML = files.map((f, i) => `<div>${f.img ? `<img src="${f.data}" alt="">` : `<span class="doc">${esc(f.name)}</span>`}<button data-i="${i}" aria-label="Retirer">×</button></div>`).join('');
  $('#thumbs').querySelectorAll('button').forEach(b => b.onclick = () => { files.splice(+b.dataset.i, 1); drawThumbs(); });
  if (files.length && !txt.value) txt.placeholder = 'Que faut-il en faire ?';
}
async function uploadFiles() {
  if (!files.length) return '';
  await ensureBranch('envois');
  const day = new Date().toISOString().slice(0, 10), stamp = Date.now();
  let out = '';
  for (const [i, f] of files.entries()) {
    const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').toLowerCase();
    const path = `envois/${day}/${me}-${stamp}-${i + 1}-${safe}`;
    const r = await post(`/contents/${path}`, { message: 'Fichier envoyé depuis l’application', branch: 'envois', content: f.data.split(',')[1] }, 'PUT');
    if (!r || r._err) throw new Error('envoi');
    out += f.img ? `\n<!--photo:${path}-->\nPhoto jointe : \`${path}\`` : `\n<!--fichier:${path}-->\nFichier joint : \`${path}\``;
  }
  return out;
}
$('#pic').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  for (const f of [...e.target.files].slice(0, 20 - files.length)) {
    if (f.size > 25e6 && !f.type.startsWith('image/')) { alert(`« ${f.name} » est trop gros (25 Mo maximum).`); continue; }
    files.push(f.type.startsWith('image/') && !/gif|svg/.test(f.type) ? await shrink(f) : await readRaw(f));
  }
  e.target.value = ''; drawThumbs();
};

/* ---------- Notifications ---------- */
function keyBytes(k) { const p = '='.repeat((4 - k.length % 4) % 4), r = atob((k + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); }
async function enableNotif() {
  try {
    if (await Notification.requestPermission() !== 'granted') return alert('Les notifications sont refusées. Vous pourrez les activer dans Réglages › Notifications.');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) });
    // l'abonnement est rangé dans le dépôt (branche « notifications ») pour que GitHub puisse prévenir ce téléphone
    await ensureBranch('notifications');
    const id = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)), h = [...new Uint8Array(id)].slice(0, 6).map(x => x.toString(16).padStart(2, '0')).join('');
    const path = `abonnements/${me}-${h}.json`;
    const old = await api(`/repos/${REPO}/contents/${path}?ref=notifications`);
    await post(`/contents/${path}`, { message: 'Notifications : ' + me, branch: 'notifications', content: b64(JSON.stringify({ login: me, sub })), ...(old.sha ? { sha: old.sha } : {}) }, 'PUT');
    alert('C’est activé ! Vous serez prévenu dès que l’agent répond.'); showChat();
  } catch (e) { alert('Activation impossible (' + e.message + '). L’application doit être ouverte depuis l’écran d’accueil.'); }
}

/* ---------- Saisie et dictée ---------- */
function autosize() { txt.style.height = 'auto'; txt.style.height = Math.min(txt.scrollHeight, 160) + 'px'; }
txt.addEventListener('input', autosize);
$('#send').onclick = send;
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
    rec.onerror = () => alert('Dictée indisponible ici : utilisez le micro du clavier de l’iPhone.');
    rec.start(); $('#mic').classList.add('rec');
  };
} else $('#mic').onclick = () => { txt.focus(); alert('Appuyez sur le micro du clavier de l’iPhone pour dicter.'); };
function stopPoll() { clearTimeout(poll); poll = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) showChat(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
token ? showChat().catch(() => showLogin('Connexion impossible pour le moment.')) : showLogin();
