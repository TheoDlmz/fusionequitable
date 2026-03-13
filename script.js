/* =========================================
   CONSTANTS
   ========================================= */

const MAX_LISTS = 5;
const MIN_LISTS = 2;

const DEFAULT_COLORS = ['#52B788', '#4361EE', '#F4A261', '#E63946', '#A855F7'];
const LIST_NAMES     = ['A', 'B', 'C', 'D', 'E'];

/* =========================================
   STATE — deux couches distinctes
   "draft"    = ce que l'utilisateur voit/édite dans le formulaire
   "committed"= ce qui a été validé et utilisé pour le classement
   ========================================= */

let draftLists      = [];  // { name, color, votes, gender }  — formulaire en cours
let committedLists  = [];  // snapshot au moment du dernier "Valider"
let committedForcedHead = null; // snapshot de forcedHeadIndex au moment du Valider

let rankingState    = [];    // tableau d'indices dans committedLists
let parityMode      = false;
let cityLocked      = false;  // true quand importé depuis la modale ville
let useDhondt       = true;   // true = D'Hondt, false = Écart minimal
let useCandidates   = false;  // true quand "Utiliser les noms des candidats" est coché
let totalSeats      = 50;
let forcedHeadIndex = null;  // null = défaut (liste avec le plus de voix), sinon index dans draftLists

/* =========================================
   DOM REFS
   ========================================= */

const wrapper            = document.getElementById('lists-wrapper');
const addBtn             = document.getElementById('add-btn');
const validateBtn        = document.getElementById('validate-btn');
const errorBox           = document.getElementById('error-box');
const resultsPlaceholder = document.getElementById('results-placeholder');
const resultsContent     = document.getElementById('results-content');
const modeRadios         = document.querySelectorAll('input[name="fusion-mode"]');
const modePropLabel      = document.getElementById('mode-prop-label');
const modeParityLabel    = document.getElementById('mode-parity-label');
const parityHint         = document.getElementById('parity-hint');
const seatsInput         = document.getElementById('seats-input');
const forcedHeadBtns     = document.getElementById('forced-head-btns');

/* =========================================
   HELPERS
   ========================================= */

function getNextName()      { return `Liste ${LIST_NAMES[draftLists.length]}`; }
function getDefaultColor(i) { return DEFAULT_COLORS[i] ?? `hsl(${Math.floor(Math.random()*360)},60%,55%)`; }

function hexToRgb(hex) {
  return { r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16), b: parseInt(hex.slice(5,7),16) };
}
function isDark(hex) {
  const {r,g,b} = hexToRgb(hex);
  return (0.299*r + 0.587*g + 0.114*b) / 255 < 0.55;
}
function deepCopy(arr) { return arr.map(l => ({ ...l })); }

/* =========================================
   PARITY HELPERS  (travaillent sur committedLists)
   ========================================= */

function fusedHeadGender() {
  // Si une tête est forcée (committedForcedHead est l'index dans committedLists)
  if (committedForcedHead !== null && committedLists[committedForcedHead]) {
    return committedLists[committedForcedHead].gender || 'H';
  }
  // Sinon si drag&drop a déplacé la tête
  if (parityMode && rankingState.length > 0) {
    return committedLists[rankingState[0]].gender || 'H';
  }
  // Défaut : liste avec le plus de voix
  let best = committedLists[0];
  committedLists.forEach(l => { if (l.votes > best.votes) best = l; });
  return best.gender || 'H';
}

function expectedGenderAtInCandidate(seatIndex, candidate) {
  const head = committedLists[candidate[0]].gender || 'H';
  return (seatIndex % 2 === 0) ? head : (head === 'H' ? 'F' : 'H');
}

function genderInList(listIndex, memberIndex) {
  const head = committedLists[listIndex].gender || 'H';
  return (memberIndex % 2 === 0) ? head : (head === 'H' ? 'F' : 'H');
}

function computeParityViolations(candidate) {
  if (!parityMode) return null;
  const used = committedLists.map(() => 0);
  return candidate.map((li, si) => {
    const mg = genderInList(li, used[li]);
    const eg = expectedGenderAtInCandidate(si, candidate);
    used[li]++;
    return mg !== eg;
  });
}

function isParityOk(candidate) {
  if (!parityMode) return true;
  return computeParityViolations(candidate).every(v => !v);
}

/* =========================================
   TOOLTIP
   ========================================= */

function createTooltip(targetEl, html) {
  let tip = null;
  function show() {
    tip = document.createElement('div');
    tip.className = 'info-tooltip';
    tip.innerHTML = html;
    document.body.appendChild(tip);
    const r = targetEl.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top  = (r.top - 8) + 'px';
    requestAnimationFrame(() => tip && tip.classList.add('visible'));
  }
  function hide() {
    if (tip) { tip.classList.remove('visible'); const t = tip; tip = null; setTimeout(() => t.remove(), 200); }
  }
  targetEl.addEventListener('mouseenter', show);
  targetEl.addEventListener('mouseleave', hide);
}

/* =========================================
   VALIDATION (against draftLists)
   ========================================= */

function validate() {
  const errors = [], highlights = [];
  draftLists.forEach((list, i) => {
    if (!list.name || !list.name.trim()) { errors.push(`La liste n°${i+1} n'a pas de nom.`); highlights.push(i); }
    if (list.votes === null || list.votes === undefined || list.votes === '') {
      errors.push(`La liste "${list.name||`n°${i+1}`}" n'a pas de nombre de voix.`);
      if (!highlights.includes(i)) highlights.push(i);
    } else if (list.votes < 0) {
      errors.push(`La liste "${list.name}" a un nombre de voix négatif.`);
      if (!highlights.includes(i)) highlights.push(i);
    }
    if (parityMode && !list.gender) {
      errors.push(`"${list.name||`n°${i+1}`}" : veuillez indiquer le genre de la tête de liste.`);
      if (!highlights.includes(i)) highlights.push(i);
    }
  });
  document.querySelectorAll('.list-row').forEach((row,i) =>
    row.classList.toggle('error-highlight', highlights.includes(i))
  );
  if (errors.length) {
    errorBox.innerHTML = errors.map(e=>`• ${e}`).join('<br>');
    errorBox.classList.add('visible');
    return false;
  }
  errorBox.classList.remove('visible');
  errorBox.innerHTML = '';
  return true;
}

/* =========================================
   ALGORITHMS (travaillent sur committedLists)
   ========================================= */

/* ──────────────────────────────────────────────────────────────
   Files d'attente par genre pour chaque liste (mode candidats)
   
   Chaque liste maintient deux files : H et F.
   On pioche dans la file du genre requis.
   Les candidats du mauvais genre restent en attente dans leur file.
   cursors[i] = index global dans candidats (avance séquentiellement)
   queues[i]  = { H: [...], F: [...] }  — candidats en attente
   ────────────────────────────────────────────────────────────── */

function buildCandidateQueues() {
  // Retourne { cursors, queues } si useCandidates && candidatsData, sinon null
  if (!useCandidates || !candidatsData) return null;
  const cursors = committedLists.map(() => 0);
  const queues  = committedLists.map(() => ({ H: [], F: [] }));
  return { cursors, queues };
}

function nextCandidateOfGender(listIndex, genre, qstate) {
  // Cherche le prochain candidat du genre requis pour la liste listIndex.
  // Remplit la file de l'autre genre avec les candidats rencontrés.
  // Retourne { nom, memberIndex } ou null si plus de candidat disponible.
  if (!qstate) return null;
  const list = committedLists[listIndex];
  if (!list._dept || !list._ville || !list._libelle) return null;
  const key   = list._dept + '|' + list._ville + '|' + list._libelle;
  const cands = candidatsData ? candidatsData[key] : null;
  if (!cands) return null;

  const { cursors, queues } = qstate;
  const alt = genre === 'H' ? 'F' : 'H';

  // D'abord vérifier la file d'attente du genre requis
  if (queues[listIndex][genre].length) {
    return queues[listIndex][genre].shift();
  }

  // Sinon avancer le curseur jusqu'à trouver le bon genre
  while (cursors[listIndex] < cands.length) {
    const cand = cands[cursors[listIndex]];
    const memberIndex = cursors[listIndex];
    cursors[listIndex]++;
    const g = cand.genre === 'F' ? 'F' : 'H';
    if (g === genre) {
      return { nom: cand.nom, memberIndex };
    } else {
      // Mettre en file d'attente pour plus tard
      queues[listIndex][alt].push({ nom: cand.nom, memberIndex });
    }
  }
  return null; // Liste épuisée pour ce genre
}

function hasNextCandidateOfGender(listIndex, genre, qstate) {
  if (!qstate) return true; // sans candidats, pas de contrainte
  const list = committedLists[listIndex];
  if (!list._dept || !list._ville || !list._libelle) return true;
  const key   = list._dept + '|' + list._ville + '|' + list._libelle;
  const cands = candidatsData ? candidatsData[key] : null;
  if (!cands) return true;
  const { cursors, queues } = qstate;
  if (queues[listIndex][genre].length) return true;
  // Regarder en avant dans le curseur sans le déplacer
  const alt = genre === 'H' ? 'F' : 'H';
  for (let j = cursors[listIndex]; j < cands.length; j++) {
    const g = cands[j].genre === 'F' ? 'F' : 'H';
    if (g === genre) return true;
  }
  return false;
}

/* ── computeRanking : proportionnel pur, alternance H/F globale ── */
function computeRanking() {
  const N = committedLists.reduce((s,l) => s + l.votes, 0);
  if (!N) { showError('Le total des voix est 0.'); return null; }

  // Déterminer le genre de tête fusionnée (pour l'alternance globale)
  let headGender;
  if (committedForcedHead !== null && committedLists[committedForcedHead]) {
    headGender = committedLists[committedForcedHead].gender || 'H';
  } else {
    let bestList = committedLists[0];
    committedLists.forEach(l => { if (l.votes > bestList.votes) bestList = l; });
    headGender = bestList.gender || 'H';
  }

  const qstate   = buildCandidateQueues();
  const seats    = committedLists.map(() => 0);
  const ranking  = [];
  // candidatAssigned[seatIndex] = { listIndex, nom, memberIndex }
  const assigned = [];

  for (let k = 1; k <= totalSeats; k++) {
    const si     = k - 1;
    const needed = (si % 2 === 0) ? headGender : (headGender === 'H' ? 'F' : 'H');

    // Choisir la liste selon la proportionnalité, en contraignant le genre si candidats
    let best = -1, bestVal = -Infinity;

    if (k === 1 && committedForcedHead !== null && committedLists[committedForcedHead]) {
      const canProvide = !qstate || hasNextCandidateOfGender(committedForcedHead, needed, qstate);
      if (canProvide) best = committedForcedHead;
    }

    if (best === -1) {
      committedLists.forEach((l, i) => {
        if (qstate && !hasNextCandidateOfGender(i, needed, qstate)) return;
        const v = useDhondt ? l.votes / (seats[i] + 1) : (l.votes / N) * k - seats[i];
        if (v > bestVal) { bestVal = v; best = i; }
      });
    }

    // Fallback sans contrainte de genre (liste épuisée du bon genre)
    if (best === -1) {
      committedLists.forEach((l, i) => {
        const v = useDhondt ? l.votes / (seats[i] + 1) : (l.votes / N) * k - seats[i];
        if (v > bestVal) { bestVal = v; best = i; }
      });
    }

    if (best === -1) { showError('Impossible de construire le classement à la position ' + k + '.'); return null; }

    ranking.push(best);

    if (qstate) {
      const cand = nextCandidateOfGender(best, needed, qstate);
      assigned.push(cand ? { listIndex: best, nom: cand.nom, memberIndex: cand.memberIndex } : null);
    }

    seats[best]++;
  }

  // Stocker les assignations pour l'affichage
  window._candidateAssigned = assigned;
  return ranking;
}

/* ── computeRankingParity : conserve l'ordre des candidats ── */
function computeRankingParity() {
  const N = committedLists.reduce((s,l) => s + l.votes, 0);
  if (!N) { showError('Le total des voix est 0.'); return null; }
  let headGender;
  if (committedForcedHead !== null && committedLists[committedForcedHead]) {
    headGender = committedLists[committedForcedHead].gender || 'H';
  } else {
    let bestList = committedLists[0];
    committedLists.forEach(l => { if (l.votes > bestList.votes) bestList = l; });
    headGender = bestList.gender || 'H';
  }
  const seats = committedLists.map(() => 0), ranking = [];
  for (let k = 1; k <= totalSeats; k++) {
    const si = k - 1;
    const needed = (si % 2 === 0) ? headGender : (headGender === 'H' ? 'F' : 'H');
    let best = -1, bestVal = -Infinity;
    if (k === 1 && committedForcedHead !== null && committedLists[committedForcedHead]) {
      const forcedGender = genderInList(committedForcedHead, 0);
      if (forcedGender === needed) best = committedForcedHead;
    }
    if (best === -1) {
      committedLists.forEach((l,i) => {
        if (genderInList(i, seats[i]) !== needed) return;
        const v = useDhondt ? l.votes / (seats[i] + 1) : (l.votes / N) * k - seats[i];
        if (v > bestVal) { bestVal = v; best = i; }
      });
    }
    // Fallback si aucune liste ne peut satisfaire la parité
    if (best === -1) {
      committedLists.forEach((l,i) => {
        const v = useDhondt ? l.votes / (seats[i] + 1) : (l.votes / N) * k - seats[i];
        if (v > bestVal) { bestVal = v; best = i; }
      });
    }
    if (best === -1) { showError('Impossible de satisfaire la parité à la position ' + k + '.'); return null; }
    ranking.push(best); seats[best]++;
  }
  window._candidateAssigned = null; // pas utilisé en mode parité
  return ranking;
}

function showError(msg) {
  errorBox.innerHTML = '• ' + msg;
  errorBox.classList.add('visible');
}

/* =========================================
   DISPROPORTIONNALITÉ
   ========================================= */

function computeDisproportionality() {
  if (!rankingState.length || !committedLists.length) return null;
  const N = committedLists.reduce((s,l) => s + l.votes, 0);
  if (!N) return null;

  const n   = committedLists.length;
  const cum = new Array(n).fill(0);
  const dev    = new Array(n).fill(0);
  const devNeg = new Array(n).fill(0);
  const prevD  = new Array(n).fill(0);

  // adv[i] = [{k, delta}, …]  — chaque entrée = un seuil où la liste i est avantagée
  // dis[i] = [{k, delta}, …]  — idem désavantagée
  const adv = committedLists.map(() => []);
  const dis = committedLists.map(() => []);

  for (let k = 1; k <= rankingState.length; k++) {
    cum[rankingState[k - 1]]++;

    for (let i = 0; i < n; i++) {
      const exact = (committedLists[i].votes / N) * k;
      const d = Math.trunc(cum[i] - exact); // >0 avantagée, <0 désavantagée, 0 neutre
      const pd = prevD[i];

      dev[i]    += Math.abs(d);
      devNeg[i] += Math.max(0, -d);

      // ── Transitions de signe ou de valeur ──
      // On enregistre les plages {kStart, kEnd, delta}
      if (d !== pd) {
        // Fermer la plage précédente
        if (pd > 0 && adv[i].length) adv[i][adv[i].length - 1].kEnd = k - 1;
        if (pd < 0 && dis[i].length) dis[i][dis[i].length - 1].kEnd = k - 1;
        // Ouvrir une nouvelle plage
        if (d > 0) adv[i].push({ kStart: k, kEnd: k, delta: d });
        else if (d < 0) dis[i].push({ kStart: k, kEnd: k, delta: d });
      } else if (d > 0 && adv[i].length) {
        adv[i][adv[i].length - 1].kEnd = k;
      } else if (d < 0 && dis[i].length) {
        dis[i][dis[i].length - 1].kEnd = k;
      }

      prevD[i] = d;
    }
  }

  return {
    total:    dev.reduce((s, d) => s + d, 0),
    totalNeg: devNeg.reduce((s, d) => s + d, 0),
    dev,
    devNeg,
    advantaged:    adv,
    disadvantaged: dis,
  };
}

/* =========================================
   RENDER — déviation + statut parité
   ========================================= */

function renderDisproportionality() {
  const existing = resultsContent.querySelector('.dispro-row');
  if (existing) existing.remove();
  const stats = computeDisproportionality();
  if (!stats) return;

  const threshold = totalSeats * 0.1; // seuil légèreté : 10% de la taille

  // ── Calcul du qualificatif par liste ──────────────────────────────────────
  // score = somme devPos - somme devNeg (net)
  function qualifier(i) {
    const adv = stats.advantaged[i];
    const dis = stats.disadvantaged[i];
    // Pondérer chaque plage par sa longueur : delta * (kEnd - kStart + 1)
    const netAdv = adv.reduce((s, r) => s + r.delta * (r.kEnd - r.kStart + 1), 0);
    const netDis = dis.reduce((s, r) => s + Math.abs(r.delta) * (r.kEnd - r.kStart + 1), 0);
    const net = netAdv - netDis;
    if (net === 0 && !adv.length && !dis.length) return 'neutral';
    if (net > 0)  return Math.abs(net) < threshold ? 'slight-adv' : 'adv';
    if (net < 0)  return Math.abs(net) < threshold ? 'slight-dis' : 'dis';
    return 'neutral';
  }

  const QUAL_LABEL = {
    'adv':       { text: 'avantagée',             cls: 'dispro-adv' },
    'slight-adv':{ text: 'légèrement avantagée',  cls: 'dispro-adv dispro-adv--slight' },
    'dis':       { text: 'désavantagée',           cls: 'dispro-dis' },
    'slight-dis':{ text: 'légèrement désavantagée',cls: 'dispro-dis dispro-dis--slight' },
    'neutral':   { text: 'neutre',                 cls: 'dispro-neutral' },
  };

  const row = document.createElement('div');
  row.className = 'dispro-row';

  // ── Zone principale : indices | résumé | ordre ─────────────────────────────
  const mainZone = document.createElement('div');
  mainZone.className = 'dispro-main';

  // Indices (gauche)
  const indicesZone = document.createElement('div');
  indicesZone.className = 'dispro-indices';

  function makeIndex(label, value, cls, tooltip) {
    const bl = document.createElement('div');
    bl.className = 'dispro-block dispro-block--total';
    const lr = Object.assign(document.createElement('div'), { className: 'dispro-label-row' });
    const tl = Object.assign(document.createElement('span'), { className: 'dispro-label' });
    tl.textContent = label;
    const ib = Object.assign(document.createElement('span'), { className: 'dispro-info-btn' });
    ib.textContent = 'i';
    createTooltip(ib, tooltip);
    lr.append(tl, ib);
    const v = Object.assign(document.createElement('div'), { className: 'dispro-value' + (cls ? ' ' + cls : '') });
    v.textContent = value;
    bl.append(lr, v);
    return bl;
  }

  indicesZone.append(
    makeIndex('Dév. totale', stats.total, '',
      'Somme des écarts absolus à la proportionnalité, selon <em>"Proportional Rankings"</em> de Piotr Skowron et al.'),
    Object.assign(document.createElement('div'), { className: 'dispro-sep' }),
    makeIndex('Sous-repr.', stats.totalNeg, 'dispro-value--neg',
      'Somme des écarts négatifs : mesure à quel point les listes reçoivent <em>moins</em> que leur part proportionnelle.')
  );
  mainZone.append(indicesZone);

  // Résumé qualitatif (centre)
  const summaryZone = document.createElement('div');
  summaryZone.className = 'dispro-summary';

  // Regrouper les listes par qualificatif
  const groups = {};
  committedLists.forEach((list, i) => {
    const q = qualifier(i);
    if (!groups[q]) groups[q] = [];
    groups[q].push({ list, i });
  });

  const qualOrder = ['adv','slight-adv','neutral','slight-dis','dis'];
  qualOrder.forEach(q => {
    if (!groups[q]) return;
    const grp = groups[q];
    const line = document.createElement('div');
    line.className = 'dispro-summary-line';

    // Pastilles
    const dots = document.createElement('span');
    dots.className = 'dispro-summary-dots';
    grp.forEach(({ list }) => {
      const d = document.createElement('span');
      d.className = 'dispro-desc-dot';
      d.style.backgroundColor = list.color;
      dots.appendChild(d);
    });
    line.appendChild(dots);

    // Noms
    const names = grp.map(g => g.list.name);
    const prefix = names.length > 1 ? 'Les listes ' : 'La liste ';
    const joined = names.length > 1
      ? names.slice(0,-1).join(', ') + ' et ' + names[names.length-1]
      : names[0];

    const nameSp = document.createElement('span');
    nameSp.className = 'dispro-desc-name';
    nameSp.textContent = prefix + joined;
    line.appendChild(nameSp);

    if (q === 'neutral') {
      const t = document.createElement('span');
      t.className = 'dispro-desc-text dispro-neutral';
      t.textContent = names.length > 1 ? ' ne sont ni avantagées ni désavantagées' : " n’est ni avantagée ni désavantagée";
      line.appendChild(t);
    } else {
      const isPlural = names.length > 1;
      const verb = isPlural ? ' sont ' : ' est ';
      const verbSp = document.createElement('span');
      verbSp.className = 'dispro-desc-text';
      verbSp.textContent = verb;
      line.appendChild(verbSp);
      const qualSp = document.createElement('span');
      qualSp.className = QUAL_LABEL[q].cls;
      qualSp.textContent = QUAL_LABEL[q].text + (isPlural && !QUAL_LABEL[q].text.endsWith('s') ? 's' : '');
      line.appendChild(qualSp);
    }
    summaryZone.appendChild(line);
  });

  // ── Lien "Afficher les détails" (déclaré avant son premier usage)
  const toggleLink = document.createElement('button');
  toggleLink.className = 'dispro-toggle-link';
  toggleLink.textContent = 'Afficher les détails';

  summaryZone.appendChild(toggleLink);
  mainZone.append(summaryZone);

  // Statut parité (droite)
  if (parityMode) {
    const ok = isParityOk(rankingState);
    const sb = document.createElement('div');
    sb.className = 'parity-status ' + (ok ? 'parity-status--ok' : 'parity-status--broken');
    const ic = Object.assign(document.createElement('div'), { className: 'parity-status-icon' });
    ic.textContent = ok ? '✓' : '✕';
    const tx = document.createElement('div'); tx.className = 'parity-status-text';
    const lb = Object.assign(document.createElement('div'), { className: 'parity-status-label' });
    lb.textContent = 'Ordre';
    const vl = Object.assign(document.createElement('div'), { className: 'parity-status-value' });
    vl.textContent = ok ? 'conservé' : 'perdu';
    tx.append(lb, vl); sb.append(ic, tx);
    mainZone.append(sb);
  }

  row.appendChild(mainZone);

  // ── Bloc détails (caché par défaut) ───────────────────────────────────────
  const details = document.createElement('div');
  details.className = 'dispro-details hidden';

  function renderRange({kStart, kEnd, delta}, cls) {
    const dsp = document.createElement('span');
    dsp.className = 'dispro-delta ' + cls;
    dsp.textContent = (delta > 0 ? '+' : '') + delta;
    const rangeStr = kStart === kEnd
      ? `${kStart} siège${kStart > 1 ? 's' : ''}`
      : `entre ${kStart} et ${kEnd} sièges`;
    return [rangeStr + ' (', dsp, ')'];
  }

  const neutral = [];
  committedLists.forEach((list, i) => {
    const adv = stats.advantaged[i];
    const dis = stats.disadvantaged[i];

    if (!adv.length && !dis.length) { neutral.push(list.name); return; }

    const line = document.createElement('div');
    line.className = 'dispro-desc-line';
    const dot = document.createElement('span');
    dot.className = 'dispro-desc-dot'; dot.style.backgroundColor = list.color;
    const nameSp = document.createElement('span');
    nameSp.className = 'dispro-desc-name'; nameSp.textContent = list.name;
    const textSp = document.createElement('span');
    textSp.className = 'dispro-desc-text';

    if (adv.length) {
      const sp = Object.assign(document.createElement('span'), { className: 'dispro-adv' });
      sp.textContent = 'est avantagée';
      textSp.append(' ', sp, ' si ');
      adv.forEach((range, idx) => {
        if (idx > 0) textSp.append(idx === adv.length - 1 ? ' et ' : ', ');
        textSp.append(...renderRange(range, 'dispro-delta--pos'));
      });
    }
    if (dis.length) {
      if (adv.length) textSp.append(' ; ');
      const sp = Object.assign(document.createElement('span'), { className: 'dispro-dis' });
      sp.textContent = 'désavantagée';
      textSp.append(sp, ' si ');
      dis.forEach((range, idx) => {
        if (idx > 0) textSp.append(idx === dis.length - 1 ? ' et ' : ', ');
        textSp.append(...renderRange(range, 'dispro-delta--neg'));
      });
    }
    line.append(dot, nameSp, textSp);
    details.appendChild(line);
  });

  if (neutral.length) {
    const nline = document.createElement('div');
    nline.className = 'dispro-desc-line dispro-desc-line--neutral';
    const prefix = neutral.length > 1 ? 'Les listes ' : 'La liste ';
    const joined = neutral.length > 1
      ? neutral.slice(0,-1).join(', ') + ' et ' + neutral[neutral.length-1]
      : neutral[0];
    nline.textContent = prefix + joined + (neutral.length > 1 ? ' ne sont' : " n'est") + ' ni avantagée' + (neutral.length > 1 ? 's' : '') + ' ni désavantagée' + (neutral.length > 1 ? 's' : '') + '.';
    details.appendChild(nline);
  }

  row.appendChild(details);

  // Toggle
  toggleLink.addEventListener('click', () => {
    const open = !details.classList.contains('hidden');
    details.classList.toggle('hidden', open);
    toggleLink.textContent = open ? 'Afficher les détails' : 'Masquer les détails';
  });

  const rl = resultsContent.querySelector('.ranking-list');
  if (rl) resultsContent.insertBefore(row, rl); else resultsContent.appendChild(row);
}

/* =========================================
   DRAG & DROP — ghost visuel CSS natif amélioré
   ========================================= */

let dragSrcIndex  = null;
let dragOverIndex = null;

function onDragStart(e, index) {
  dragSrcIndex  = index;
  dragOverIndex = null;
  e.dataTransfer.effectAllowed = 'move';
  // Laisser le navigateur faire son ghost natif mais on cache l'original après un tick
  requestAnimationFrame(() => {
    const items = resultsContent.querySelectorAll('.ranking-item');
    if (items[index]) items[index].classList.add('drag-src');
  });
}

function onDragEnd() {
  dragSrcIndex  = null;
  dragOverIndex = null;
  document.querySelectorAll('.ranking-item').forEach(el => {
    el.classList.remove('drag-src', 'drag-over-top', 'drag-over-bot');
  });
}

function onDragOver(e, index) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (dragOverIndex === index) return;
  dragOverIndex = index;
  document.querySelectorAll('.ranking-item').forEach((el, i) => {
    el.classList.remove('drag-over-top', 'drag-over-bot');
    if (i === index) {
      el.classList.add(index < dragSrcIndex ? 'drag-over-top' : 'drag-over-bot');
    }
  });
}

function onDrop(e, index) {
  e.preventDefault();
  if (dragSrcIndex === null || dragSrcIndex === index) return;

  // Déplacer dans rankingState
  const moved = rankingState.splice(dragSrcIndex, 1)[0];
  rankingState.splice(index, 0, moved);

  // Mise à jour chirurgicale : pas de re-render complet
  updateRankingListInPlace();
}

/* =========================================
   PARTI DROPDOWN
   ========================================= */

function closeAllDropdowns() {
  document.querySelectorAll('.parti-dropdown').forEach(d => d.remove());
}

function openPartiDropdown(btnEl, seatIndex) {
  closeAllDropdowns();
  const dropdown = document.createElement('div');
  dropdown.className = 'parti-dropdown';

  committedLists.forEach((list, listIndex) => {
    const opt = document.createElement('div');
    opt.className = 'parti-option' + (listIndex === rankingState[seatIndex] ? ' current' : '');
    const dot = Object.assign(document.createElement('div'), { className: 'parti-option-dot' });
    dot.style.backgroundColor = list.color;
    opt.appendChild(dot);
    opt.appendChild(document.createTextNode(list.name));
    opt.addEventListener('mousedown', (e) => {
      e.preventDefault();
      rankingState[seatIndex] = listIndex;
      closeAllDropdowns();
      // Vider _candidateAssigned car les noms sont désalignés après changement de parti
      if (useCandidates) window._candidateAssigned = null;
      // Reconstruire toute la liste pour recalculer les noms
      updateRankingListInPlace();
    });
    dropdown.appendChild(opt);
  });

  const panel = document.getElementById('right-panel');
  const r = btnEl.getBoundingClientRect(), pr = panel.getBoundingClientRect();
  dropdown.style.top  = (r.top - pr.top + panel.scrollTop) + 'px';
  dropdown.style.left = (r.left - pr.left - 160) + 'px';
  panel.appendChild(dropdown);
  setTimeout(() => document.addEventListener('click', closeAllDropdowns, { once: true }), 0);
}

/* =========================================
   MISE À JOUR CHIRURGICALE — ranking
   ========================================= */

/**
 * Reconstruit le contenu d'un seul item du classement (seatIndex).
 * Ne touche pas aux autres items.
 */
function updateSingleRankingItem(seatIndex) {
  const items = resultsContent.querySelectorAll('.ranking-item');
  if (!items[seatIndex]) return;
  const oldItem = items[seatIndex];
  const newItem = buildRankingItem(seatIndex, rankingState[seatIndex]);
  oldItem.replaceWith(newItem);
  // Ré-attacher les events drag sur le nouvel item
  newItem.addEventListener('dragstart', (e) => onDragStart(e, seatIndex));
  newItem.addEventListener('dragend',   () => onDragEnd());
  newItem.addEventListener('dragover',  (e) => onDragOver(e, seatIndex));
  newItem.addEventListener('drop',      (e) => onDrop(e, seatIndex));
}

/**
 * Recalcule et met à jour uniquement les badges genre sans reconstruire les items.
 */
function refreshViolationBadges() {
  if (!parityMode) return;
  const violations  = computeParityViolations(rankingState);
  const used        = committedLists.map(() => 0);
  const items       = resultsContent.querySelectorAll('.ranking-item');

  rankingState.forEach((listIndex, seatIndex) => {
    const badge = items[seatIndex]?.querySelector('.ranking-gender-badge');
    if (!badge) { used[listIndex]++; return; }
    const memberGender = genderInList(listIndex, used[listIndex]);
    badge.textContent = memberGender;
    const isViolation = violations[seatIndex];
    badge.className = 'ranking-gender-badge' + (isViolation ? ' ranking-gender-badge--violation' : '');
    if (isViolation) {
      badge.style.color       = '#ff6b6b';
      badge.style.borderColor = '#ff6b6b';
    } else {
      const dark = isDark(committedLists[listIndex].color);
      badge.style.color       = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.5)';
      badge.style.borderColor = dark ? 'rgba(255,255,255,0.3)'  : 'rgba(0,0,0,0.2)';
    }
    used[listIndex]++;
  });
}

/**
 * Après un drop, réordonne les éléments DOM sans reconstruire,
 * puis met à jour les numéros et badges.
 */
function updateRankingListInPlace() {
  onDragEnd();

  // Après un drag, _candidateAssigned ne correspond plus aux nouveaux indices.
  // On le vide pour forcer getCandidatName() comme fallback.
  if (useCandidates) {
    window._candidateAssigned = null;
  }

  const container = resultsContent.querySelector('.ranking-list');
  if (!container) { rerenderRankingList(); return; }

  // Récupérer les items actuels dans le DOM
  const items = Array.from(container.querySelectorAll('.ranking-item'));

  // Reconstruire l'ordre DOM selon rankingState en déplaçant les nœuds
  // On associe chaque item à son ancienne position via data-seat
  items.forEach((el, i) => el.dataset.seat = i);

  // Rebuil complet mais sans animation : on remplace les items un par un
  // Pour le drag, on préfère reconstruire la liste entière mais sans la classe d'animation
  container.innerHTML = '';
  const usedPerList = committedLists.map(() => 0);
  const violations  = computeParityViolations(rankingState);

  rankingState.forEach((listIndex, seatIndex) => {
    const item = buildRankingItem(seatIndex, listIndex, violations, usedPerList);
    item.classList.add('no-anim'); // pas d'animation au réordonnancement
    item.addEventListener('dragstart', (e) => onDragStart(e, seatIndex));
    item.addEventListener('dragend',   () => onDragEnd());
    item.addEventListener('dragover',  (e) => onDragOver(e, seatIndex));
    item.addEventListener('drop',      (e) => onDrop(e, seatIndex));
    container.appendChild(item);
    usedPerList[listIndex]++;
  });

  renderDisproportionality();
}

/* =========================================
   CONSTRUCTION D'UN ITEM DE CLASSEMENT
   ========================================= */

function buildRankingItem(seatIndex, listIndex, violations, usedPerList) {
  // Si violations/usedPerList ne sont pas fournis, les recalculer
  if (!violations) violations = computeParityViolations(rankingState);

  // Calculer usedPerList jusqu'à seatIndex si non fourni
  let memberIndexForThisList;
  if (usedPerList !== undefined) {
    memberIndexForThisList = usedPerList[listIndex];
  } else {
    memberIndexForThisList = rankingState.slice(0, seatIndex).filter(i => i === listIndex).length;
  }

  const list = committedLists[listIndex];
  const dark = isDark(list.color);
  const isViolation = violations ? violations[seatIndex] : false;

  const item = document.createElement('div');
  item.className = 'ranking-item';
  item.draggable = true;
  item.style.backgroundColor = list.color;

  // Poignée
  const handle = document.createElement('div');
  handle.className = 'ranking-handle';
  handle.innerHTML = `<svg width="12" height="16" viewBox="0 0 12 16" fill="none">
    <circle cx="3" cy="3"  r="1.5" fill="currentColor"/>
    <circle cx="9" cy="3"  r="1.5" fill="currentColor"/>
    <circle cx="3" cy="8"  r="1.5" fill="currentColor"/>
    <circle cx="9" cy="8"  r="1.5" fill="currentColor"/>
    <circle cx="3" cy="13" r="1.5" fill="currentColor"/>
    <circle cx="9" cy="13" r="1.5" fill="currentColor"/>
  </svg>`;
  handle.style.color = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';

  const pos = document.createElement('div');
  pos.className = 'ranking-position';
  pos.style.color = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)';
  pos.textContent = seatIndex + 1;

  const name = document.createElement('div');
  name.className = 'ranking-name';
  name.style.color = dark ? '#ffffff' : '#1B2E22';

  // Chercher le vrai nom dans _candidateAssigned (mode proportionnel) ou getCandidatName (mode parité)
  let candidatNom = null;
  if (useCandidates) {
    // _candidateAssigned peut être chargé depuis le state partagé, même sans candidatsData
    if (window._candidateAssigned && window._candidateAssigned[seatIndex]) {
      candidatNom = window._candidateAssigned[seatIndex].nom;
    } else if (candidatsData) {
      candidatNom = getCandidatName(listIndex, memberIndexForThisList);
    }
  }
  if (candidatNom) {
    const nameTop = document.createElement('div');
    nameTop.textContent = candidatNom;
    const nameSub = document.createElement('div');
    nameSub.className = 'ranking-name-sub';
    nameSub.style.color = dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.45)';
    nameSub.textContent = list.name;
    name.append(nameTop, nameSub);
  } else {
    name.textContent = list.name;
  }

  item.appendChild(handle);
  item.appendChild(pos);
  item.appendChild(name);

  if (parityMode) {
    const memberGender = genderInList(listIndex, memberIndexForThisList);
    const badge = document.createElement('div');
    badge.className = 'ranking-gender-badge' + (isViolation ? ' ranking-gender-badge--violation' : '');
    badge.textContent = memberGender;
    if (isViolation) {
      badge.style.color = '#ff6b6b'; badge.style.borderColor = '#ff6b6b';
    } else {
      badge.style.color       = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.5)';
      badge.style.borderColor = dark ? 'rgba(255,255,255,0.3)'  : 'rgba(0,0,0,0.2)';
    }
    item.appendChild(badge);
  }

  const editBtn = document.createElement('button');
  editBtn.className = 'ranking-edit-btn';
  editBtn.title = 'Changer de parti';
  editBtn.style.color = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.35)';
  editBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>`;
  editBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openPartiDropdown(editBtn, seatIndex); });
  item.appendChild(editBtn);

  return item;
}

/* =========================================
   RENDER COMPLET — ranking list (appelé uniquement par renderResults)
   ========================================= */

function rerenderRankingList() {
  const existing = resultsContent.querySelector('.ranking-list');
  if (existing) existing.remove();

  const violations  = computeParityViolations(rankingState);
  const usedPerList = committedLists.map(() => 0);
  const container   = document.createElement('div');
  container.className = 'ranking-list';

  rankingState.forEach((listIndex, seatIndex) => {
    const item = buildRankingItem(seatIndex, listIndex, violations, usedPerList);
    item.addEventListener('dragstart', (e) => onDragStart(e, seatIndex));
    item.addEventListener('dragend',   () => onDragEnd());
    item.addEventListener('dragover',  (e) => onDragOver(e, seatIndex));
    item.addEventListener('drop',      (e) => onDrop(e, seatIndex));
    container.appendChild(item);
    usedPerList[listIndex]++;
  });

  resultsContent.appendChild(container);
  renderDisproportionality();
}

/* =========================================
   LOADING CANDIDATS
   ========================================= */

function showCandidatsLoading() {
  resultsPlaceholder.classList.add('hidden');
  resultsContent.innerHTML = '';
  resultsContent.classList.add('visible');
  const loader = document.createElement('div');
  loader.id = 'candidats-loader';
  loader.className = 'candidats-loader';
  loader.innerHTML = '<div class="candidats-loader-spinner"></div><div class="candidats-loader-text">Chargement des candidats…</div>';
  resultsContent.appendChild(loader);
}

function hideCandidatsLoading() {
  const loader = document.getElementById('candidats-loader');
  if (loader) loader.remove();
}

/* =========================================
   RENDER RESULTS COMPLET (appelé par Valider)
   ========================================= */

function renderResults(ranking) {
  rankingState = [...ranking];
  resultsContent.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'results-header';
  const titleRow = document.createElement('div');
  titleRow.className = 'results-title-row';
  const title = Object.assign(document.createElement('div'), { className: 'results-title' });
  title.textContent = 'Liste fusionnée';
  const exportBtns = document.createElement('div');
  exportBtns.className = 'results-export-btns';
  const exportCsvBtn = document.createElement('button');
  exportCsvBtn.className = 'export-btn';
  exportCsvBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> CSV';
  exportCsvBtn.addEventListener('click', () => exportRanking('csv'));
  const exportXlsBtn = document.createElement('button');
  exportXlsBtn.className = 'export-btn';
  exportXlsBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Excel';
  exportXlsBtn.addEventListener('click', () => exportRanking('excel'));
  exportBtns.append(exportCsvBtn, exportXlsBtn);
  titleRow.append(title, exportBtns);
  const subtitle = Object.assign(document.createElement('div'), { className: 'results-subtitle' });
  subtitle.textContent = `${totalSeats} sièges — répartition ${parityMode ? 'proportionnelle & paritaire' : 'proportionnelle'}`;
  header.append(titleRow, subtitle);
  resultsContent.appendChild(header);

  const summary = document.createElement('div');
  summary.className = 'results-summary';
  const N = committedLists.reduce((s,l) => s+l.votes, 0);
  committedLists.forEach(list => {
    const chip = document.createElement('div');
    chip.className = 'summary-chip';
    const dot = Object.assign(document.createElement('div'), { className: 'summary-chip-dot' });
    dot.style.backgroundColor = list.color;
    chip.appendChild(dot);
    let lbl = `${list.name} — ${((list.votes/N)*100).toFixed(1)}%`;
    if (parityMode) lbl += ` (tête: ${list.gender})`;
    chip.appendChild(document.createTextNode(lbl));
    summary.appendChild(chip);
  });
  resultsContent.appendChild(summary);

  resultsPlaceholder.classList.add('hidden');
  resultsContent.classList.add('visible');
  document.getElementById('share-btn').classList.add('active');
  rerenderRankingList();
}

/* =========================================
   RENDER FORM — chirurgical (ajout/suppression)
   ========================================= */

function buildListRow(list, index) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.dataset.index = index;

  const swatchWrapper = document.createElement('div');
  swatchWrapper.className = 'color-swatch-wrapper';
  const swatchDisplay = Object.assign(document.createElement('div'), { className: 'color-swatch-display' });
  swatchDisplay.style.backgroundColor = list.color;
  const swatch = document.createElement('input');
  swatch.type = 'color'; swatch.className = 'color-swatch'; swatch.value = list.color;
  swatch.addEventListener('input', e => { draftLists[index].color = e.target.value; swatchDisplay.style.backgroundColor = e.target.value; renderForcedHeadBtns(); });
  swatchWrapper.append(swatchDisplay, swatch);

  const nameInput = Object.assign(document.createElement('input'), { type: 'text', className: 'input-name', placeholder: 'Nom de la liste', value: list.name });
  nameInput.addEventListener('input', e => { draftLists[index].name = e.target.value; renderForcedHeadBtns(); });

  const votesInput = Object.assign(document.createElement('input'), { type: 'number', className: 'input-votes', placeholder: 'Nombre de voix', min: '0' });
  votesInput.value = list.votes !== null ? list.votes : '';
  votesInput.addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    draftLists[index].votes = isNaN(v) ? null : v;
    row.classList.remove('error-highlight');
  });

  const genderToggle = document.createElement('div');
  genderToggle.className = 'gender-toggle' + (parityMode ? '' : ' hidden');
  ['H','F'].forEach(g => {
    const btn = Object.assign(document.createElement('button'), { className: 'gender-btn' + (list.gender === g ? ' active' : ''), textContent: g });
    btn.addEventListener('click', () => {
      draftLists[index].gender = g;
      row.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    genderToggle.appendChild(btn);
  });

  const deleteBtn = Object.assign(document.createElement('button'), { className: 'delete-btn', innerHTML: '&times;' });
  deleteBtn.title = 'Supprimer cette liste';
  updateDeleteBtn(deleteBtn);
  deleteBtn.addEventListener('click', () => {
    if (draftLists.length <= MIN_LISTS) return;
    // Supprimer sans re-render complet
    draftLists.splice(index, 1);
    row.classList.add('row-removing');
    row.addEventListener('animationend', () => {
      row.remove();
      if (forcedHeadIndex === index) forcedHeadIndex = null;
      else if (forcedHeadIndex !== null && forcedHeadIndex > index) forcedHeadIndex--;
      rebuildRowBindings();
      updateAllDeleteBtns();
      updateAddBtn();
      renderForcedHeadBtns();
    }, { once: true });
  });

  // Verrouillage si importé depuis ville
  if (cityLocked) {
    nameInput.disabled = true;
    nameInput.title = 'Importé depuis la liste officielle';
    genderToggle.querySelectorAll('.gender-btn').forEach(b => { b.disabled = true; b.style.pointerEvents = 'none'; });
    deleteBtn.disabled = true;
    deleteBtn.style.display = 'none';
  }

  row.append(swatchWrapper, nameInput, votesInput, genderToggle, deleteBtn);
  return row;
}

function updateDeleteBtn(btn) {
  btn.className = 'delete-btn' + (draftLists.length > MIN_LISTS ? ' active' : '');
  btn.disabled  = draftLists.length <= MIN_LISTS;
}
function updateAllDeleteBtns() {
  wrapper.querySelectorAll('.delete-btn').forEach(btn => updateDeleteBtn(btn));
}

/**
 * Relie tous les event listeners qui dépendent de l'index (input, delete, gender)
 * après un changement d'ordre dans draftLists. On profite du data-index sur chaque row.
 */
function rebuildRowBindings() {
  wrapper.querySelectorAll('.list-row').forEach((row, i) => {
    row.dataset.index = i;
    const list = draftLists[i];

    const swatch     = row.querySelector('.color-swatch');
    const swDisplay  = row.querySelector('.color-swatch-display');
    const nameInput  = row.querySelector('.input-name');
    const votesInput = row.querySelector('.input-votes');
    const deleteBtn  = row.querySelector('.delete-btn');
    const genderBtns = row.querySelectorAll('.gender-btn');

    // Cloner pour supprimer anciens listeners, puis réattacher
    function reattach(el, evt, fn) {
      const clone = el.cloneNode(true);
      el.replaceWith(clone);
      clone.addEventListener(evt, fn);
      return clone;
    }

    reattach(swatch, 'input', e => { draftLists[i].color = e.target.value; swDisplay.style.backgroundColor = e.target.value; renderForcedHeadBtns(); });
    reattach(nameInput,  'input', e => { draftLists[i].name  = e.target.value; renderForcedHeadBtns(); });
    reattach(votesInput, 'input', e => {
      const v = parseInt(e.target.value, 10);
      draftLists[i].votes = isNaN(v) ? null : v;
      row.classList.remove('error-highlight');
    });
    reattach(deleteBtn, 'click', () => {
      if (draftLists.length <= MIN_LISTS) return;
      draftLists.splice(i, 1);
      row.classList.add('row-removing');
      row.addEventListener('animationend', () => {
        row.remove();
        if (forcedHeadIndex === i) forcedHeadIndex = null;
        else if (forcedHeadIndex !== null && forcedHeadIndex > i) forcedHeadIndex--;
        rebuildRowBindings();
        updateAllDeleteBtns();
        updateAddBtn();
        renderForcedHeadBtns();
      }, { once: true });
    });
    genderBtns.forEach((btn, gi) => {
      const g = gi === 0 ? 'H' : 'F';
      const clone = btn.cloneNode(true);
      btn.replaceWith(clone);
      clone.addEventListener('click', () => {
        draftLists[i].gender = g;
        row.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('active'));
        clone.classList.add('active');
      });
    });
  });
}

/* =========================================
   SÉLECTEUR TÊTE DE LISTE FORCÉE
   ========================================= */

function renderForcedHeadBtns() {
  forcedHeadBtns.innerHTML = '';

  // Bouton "D" — défaut
  const defaultBtn = document.createElement('button');
  defaultBtn.className = 'forced-head-btn forced-head-btn--default' + (forcedHeadIndex === null ? ' active' : '');
  defaultBtn.textContent = 'Auto';
  defaultBtn.style.width = '40px';
  defaultBtn.dataset.tooltip = 'Par défaut';
  defaultBtn.addEventListener('click', () => {
    forcedHeadIndex = null;
    renderForcedHeadBtns();
  });
  forcedHeadBtns.appendChild(defaultBtn);

  // Un bouton par liste draft
  draftLists.forEach((list, i) => {
    const btn = document.createElement('button');
    btn.className = 'forced-head-btn' + (forcedHeadIndex === i ? ' active' : '');
    btn.dataset.tooltip = list.name;
    btn.style.backgroundColor = forcedHeadIndex === i ? list.color : 'transparent';
    btn.style.borderColor = list.color;

    // Petit cercle coloré
    const dot = document.createElement('span');
    dot.className = 'forced-head-dot';
    dot.style.backgroundColor = list.color;
    btn.appendChild(dot);

    btn.addEventListener('click', () => {
      forcedHeadIndex = i;
      renderForcedHeadBtns();
    });
    forcedHeadBtns.appendChild(btn);
  });
}

/* Render initial complet du formulaire (appelé une seule fois à l'init) */
function renderForm() {
  wrapper.innerHTML = '';
  draftLists.forEach((list, i) => {
    wrapper.appendChild(buildListRow(list, i));
  });
  renderForcedHeadBtns();
}

function updateAddBtn() {
  addBtn.classList.toggle('hidden', draftLists.length >= MAX_LISTS);
}

/* =========================================
   PARITY CHECKBOX
   ========================================= */

function onModeChange() {
  const val  = document.querySelector('input[name="fusion-mode"]:checked')?.value;
  parityMode = (val === 'parity');
  // Mettre à jour le style actif des labels
  modePropLabel.classList.toggle('active', !parityMode);
  modeParityLabel.classList.toggle('active', parityMode);
  parityHint.classList.toggle('hidden', !parityMode);
  document.querySelectorAll('.gender-toggle').forEach(el => el.classList.toggle('hidden', !parityMode));
}

/* =========================================
   ADD LIST — chirurgical
   ========================================= */

function addList() {
  if (cityLocked) return;
  if (draftLists.length >= MAX_LISTS) return;
  const newList = { name: getNextName(), color: getDefaultColor(draftLists.length), votes: null, gender: null };
  draftLists.push(newList);
  const row = buildListRow(newList, draftLists.length - 1);
  row.classList.add('row-entering');
  wrapper.appendChild(row);
  updateAllDeleteBtns();
  updateAddBtn();
  renderForcedHeadBtns();
}

/* =========================================
   INIT
   ========================================= */

function init() {
  draftLists = [
    { name: 'Liste A', color: getDefaultColor(0), votes: null, gender: null },
    { name: 'Liste B', color: getDefaultColor(1), votes: null, gender: null },
  ];
  renderForm();
  updateAddBtn();

  modeRadios.forEach(r => r.addEventListener('change', onModeChange));
  addBtn.addEventListener('click', addList);

  // Toggle méthode
  document.querySelectorAll('.method-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      useDhondt = btn.dataset.method === 'dhondt';
      document.querySelectorAll('.method-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  seatsInput.addEventListener('change', () => {
    let v = parseInt(seatsInput.value, 10);
    if (isNaN(v)) v = 50;
    v = Math.max(5, Math.min(200, v));
    seatsInput.value = v;
    totalSeats = v;
  });

  validateBtn.addEventListener('click', async () => {
    if (!validate()) return;
    // Snapshot : les données du formulaire deviennent les données committées
    committedLists      = deepCopy(draftLists);
    committedForcedHead = forcedHeadIndex;
    // Attendre que candidatsData soit chargé si nécessaire
    if (cityLocked && useCandidates) {
      const depts = [...new Set(committedLists.filter(l => l._dept).map(l => l._dept))];
      if (depts.length && depts.some(d => !_loadedDepts.has(d))) {
        await loadCandidatsCSV(depts);
      }
    }
    const ranking = parityMode ? computeRankingParity() : computeRanking();
    if (ranking) renderResults(ranking);
  });
}

init();


/* =========================================
   EXPORT CSV / EXCEL
   ========================================= */

function buildExportRows() {
  const hasNames   = useCandidates && (candidatsData || window._candidateAssigned);
  const hasGenders = parityMode || hasNames;
  const usedPerList = committedLists.map(() => 0);

  const rows = [['Rang', 'Liste' + (hasNames ? ', Nom' : '') + (hasGenders ? ', Genre' : '')]];
  const header = ['Rang', 'Liste'];
  if (hasNames)   header.push('Nom');
  if (hasGenders) header.push('Genre');
  const data = [header];

  rankingState.forEach((listIndex, seatIndex) => {
    const list = committedLists[listIndex];
    const memberIndex = usedPerList[listIndex];
    const row = [seatIndex + 1, list.name];

    if (hasNames) {
      let nom = null;
      if (window._candidateAssigned && window._candidateAssigned[seatIndex]) {
        nom = window._candidateAssigned[seatIndex].nom;
      } else if (candidatsData) {
        nom = getCandidatName(listIndex, memberIndex);
      }
      row.push(nom || '');
    }

    if (hasGenders) {
      let genre = null;
      if (window._candidateAssigned && window._candidateAssigned[seatIndex]) {
        // genre stocké dans candidateAssigned ? sinon on dérive
        const cand = window._candidateAssigned[seatIndex];
        genre = cand.genre || null;
      }
      if (!genre && candidatsData) {
        genre = getCandidatGenre(listIndex, memberIndex);
      }
      if (!genre && parityMode) {
        genre = genderInList(listIndex, memberIndex);
      }
      row.push(genre || '');
    }

    data.push(row);
    usedPerList[listIndex]++;
  });
  return data;
}

function exportRanking(format) {
  const data = buildExportRows();
  if (format === 'csv') {
    const csv = data.map(row => row.map(cell => {
      const s = String(cell);
      return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g,'""') + '"' : s;
    }).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'liste_fusionnee.csv' });
    a.click(); URL.revokeObjectURL(url);
  } else {
    // Excel via SheetJS (si disponible) sinon fallback CSV
    if (typeof XLSX !== 'undefined') {
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Liste fusionnée');
      XLSX.writeFile(wb, 'liste_fusionnee.xlsx');
    } else {
      // Charger SheetJS dynamiquement
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = () => exportRanking('excel');
      document.head.appendChild(s);
    }
  }
}

/* =========================================
   PARTAGE — save / load / URL
   ========================================= */

const BACKEND = 'back.php';
const BASE_URL = 'https://fusionequitable.lamsade.fr/';

/**
 * Construit l'objet state à sauvegarder.
 * On utilise committedLists (le dernier état validé).
 */
function buildShareState() {
  return {
    committedLists,
    rankingState,
    parityMode,
    totalSeats,
    forcedHeadIndex: committedForcedHead,
    useCandidates,
    cityLocked,
    candidateAssigned: window._candidateAssigned || null,
  };
}

/**
 * Restaure l'application depuis un state chargé.
 */
function restoreState(state) {
  committedLists      = state.committedLists || [];
  rankingState        = state.rankingState   || [];
  parityMode          = state.parityMode     || false;
  totalSeats          = state.totalSeats     || 50;
  forcedHeadIndex     = state.forcedHeadIndex ?? null;
  committedForcedHead = forcedHeadIndex;

  // Restaurer le formulaire (draftLists = copie de committedLists)
  draftLists = deepCopy(committedLists);

  // Restaurer UI formulaire
  // Restaurer le mode radio
  const targetVal = parityMode ? 'parity' : 'proportional';
  modeRadios.forEach(r => { r.checked = (r.value === targetVal); });
  modePropLabel.classList.toggle('active', !parityMode);
  modeParityLabel.classList.toggle('active', parityMode);
  parityHint.classList.toggle('hidden', !parityMode);
  seatsInput.value = totalSeats;

  // Restaurer useCandidates, cityLocked et les noms de candidats
  useCandidates = state.useCandidates || false;
  cityLocked    = state.cityLocked    || false;
  window._candidateAssigned = state.candidateAssigned || null;

  renderForm();
  updateAddBtn();

  // Si cityLocked, restaurer l'UI de verrouillage
  if (cityLocked) applyLockUI();

  // Restaurer le classement
  if (rankingState.length > 0 && committedLists.length > 0) {
    if (cityLocked && useCandidates) {
      // Afficher un écran de chargement, attendre le CSV, puis render
      showCandidatsLoading();
      const depts = [...new Set(committedLists.filter(l => l._dept).map(l => l._dept))];
      loadCandidatsCSV(depts).then(() => {
        hideCandidatsLoading();
        renderResults(rankingState);
      });
    } else {
      renderResults(rankingState);
    }
  }
}

/**
 * Sauvegarde le state courant en base et retourne l'ID.
 */
async function saveState() {
  const state = buildShareState();
  const resp  = await fetch(BACKEND + '?action=save', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(state),
  });
  if (!resp.ok) throw new Error('Erreur serveur : ' + resp.status);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data.id;
}

/**
 * Charge un state depuis la base via son ID.
 */
async function loadState(id) {
  const resp = await fetch(BACKEND + '?action=load&id=' + encodeURIComponent(id));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('Erreur serveur : ' + resp.status);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data.state;
}

/**
 * Lit l'ID dans l'URL si on est sur /fusion/XXXXX
 */
function getIdFromUrl() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  // pathname = /fusion/ID  → parts = ['fusion', 'ID']
  // ou pathname = /fusion/  → parts = ['fusion']
  if (parts.length >= 1) {
    const id = parts[0];
    if (/^[a-z0-9]{6,12}$/.test(id)) return id;
  }
  return null;
}

/* ── Modal partage ──────────────────────────────────────────────────────────── */

const shareBtn        = document.getElementById('share-btn');
const shareOverlay    = document.getElementById('share-overlay');
const shareModal      = document.getElementById('share-modal');
const shareModalClose = document.getElementById('share-modal-close');
const shareLinkDisplay = document.getElementById('share-link-display');
const shareCopyBtn    = document.getElementById('share-copy-btn');
const shareCopiedToast = document.getElementById('share-copied-toast');

let currentShareUrl = '';
let copiedTimeout   = null;

function openShareModal() {
  if (!rankingState.length) {
    alert('Veuillez d\'abord valider un classement avant de le partager.');
    return;
  }

  shareModal.classList.add('visible');
  shareOverlay.classList.add('visible');
  shareLinkDisplay.textContent = 'Génération du lien…';
  shareLinkDisplay.classList.remove('error');
  currentShareUrl = '';

  saveState()
    .then(id => {
      currentShareUrl = BASE_URL + id;
      shareLinkDisplay.textContent = currentShareUrl;
      // Mettre à jour l'URL du navigateur
      history.pushState({ id }, '', id);
    })
    .catch(err => {
      shareLinkDisplay.textContent = 'Erreur : ' + err.message;
      shareLinkDisplay.classList.add('error');
    });
}

function closeShareModal() {
  shareModal.classList.remove('visible');
  shareOverlay.classList.remove('visible');
}

shareBtn.addEventListener('click', openShareModal);
shareModalClose.addEventListener('click', closeShareModal);
shareOverlay.addEventListener('click', closeShareModal);

shareCopyBtn.addEventListener('click', () => {
  if (!currentShareUrl) return;
  navigator.clipboard.writeText(currentShareUrl).then(() => {
    shareCopiedToast.classList.add('visible');
    if (copiedTimeout) clearTimeout(copiedTimeout);
    copiedTimeout = setTimeout(() => shareCopiedToast.classList.remove('visible'), 2000);
  });
});

/* ── Chargement automatique depuis l'URL ─────────────────────────────────── */

async function tryLoadFromUrl() {
  const id = getIdFromUrl();
  if (!id) return;

  try {
    const state = await loadState(id);
    if (state) {
      restoreState(state);
    }
  } catch (e) {
    console.warn('Impossible de charger l\'état depuis l\'URL :', e);
  }
}

// Lancer le chargement depuis l'URL au démarrage
tryLoadFromUrl();

/* =========================================
   DICTIONNAIRE NUANCES
   ========================================= */

const NUANCE_LABEL = {
  "LCOM": "PCF",
  "LDIV": "Divers",
  "LDSV": "Droite souverainiste",
  "LDVC": "Divers Centre",
  "LDVD": "Divers Droite",
  "LDVG": "Divers Gauche",
  "LECO": "Divers Écologistes",
  "LEXD": "Extrême Droite",
  "LEXG": "Extrême Gauche",
  "LFI":  "LFI",
  "LHOR": "Horizons",
  "LLR":  "LR",
  "LMDM": "MoDem",
  "LREC": "Reconquête",
  "LREG": "Régionalistes",
  "LREN": "Renaissance",
  "LRN":  "RN",
  "LSOC": "PS",
  "LUC":  "Union du Centre",
  "LUD":  "Union de Droite",
  "LUDI": "UDI",
  "LUDR": "UDR",
  "LUG":  "Union de Gauche",
  "LUXD": "Union d'Extrême Droite",
  "LVEC": "Les Verts",
};

const NUANCE_COLOR = {
  "LCOM": "#c20e0e",
  "LDIV": "#6B7280",
  "LDSV": "#9bb0da",
  "LDVC": "#f3cd52",
  "LDVD": "#3B82F6",
  "LDVG": "#E05A5A",
  "LECO": "#22C55E",
  "LEXD": "#614524",
  "LEXG": "#7c0808",
  "LFI":  "#e22f2f",
  "LHOR": "#9bf8f3",
  "LLR":  "#184dc0",
  "LMDM": "#F97316",
  "LREC": "#4b433b",
  "LREG": "#e46d28",
  "LREN": "#F97316",
  "LRN":  "#2c3242",
  "LSOC": "#EC4899",
  "LUC":  "#f0e68b",
  "LUD":  "#6e9af1",
  "LUDI": "#359bca",
  "LUDR": "#262e3f",
  "LUG":  "#d4596e",
  "LUXD": "#3a3225",
  "LVEC": "#38a71c",
  "":     "#c4c5c7",
};

function getNuanceLabel(code) {
  return NUANCE_LABEL[code] || code || '—';
}
function getNuanceColor(code) {
  return NUANCE_COLOR[code] || '#6B7280';
}

/* =========================================
   PARSING CSV
   ========================================= */

let csvData = null;       // listes.csv
let candidatsData = null; // candidats.csv
const _loadedDepts = new Set(); // départements déjà chargés

async function loadCSV() {
  if (csvData !== null) return csvData;
  try {
    const resp = await fetch('listes.csv');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    csvData = parseCSV(text);
    return csvData;
  } catch (e) {
    console.error('Erreur chargement listes CSV:', e);
    csvData = [];
    return [];
  }
}

async function loadCandidatsCSV(depts) {
  // depts = tableau de codes département à charger (ex: ['75', '92'])
  // Si non fourni, ne charge rien (on ne sait pas quoi charger)
  if (!depts || !depts.length) return candidatsData || {};
  if (candidatsData === null) candidatsData = {};

  const toLoad = depts.filter(d => !_loadedDepts.has(d));
  if (!toLoad.length) return candidatsData;

  await Promise.all(toLoad.map(async dept => {
    try {
      const resp = await fetch('candidats/candidats_' + dept + '.csv');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const partial = parseCandidatsCSV(text);
      Object.assign(candidatsData, partial);
      _loadedDepts.add(dept);
    } catch (e) {
      console.error('Erreur chargement candidats dept ' + dept + ':', e);
      _loadedDepts.add(dept); // marquer comme tenté pour ne pas réessayer
    }
  }));

  return candidatsData;
}

function parseCandidatsCSV(text) {
  // Retourne un index: { "dept|ville|libelle": [{rang, genre, nom_prenom}, ...] }
  const lines = text.trim().split('\n');
  const index = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 6) continue;
    const dept    = cols[0].trim();
    const ville   = cols[1].trim();
    const libelle = cols[2].trim();
    const rang    = parseInt(cols[3].trim()) || 0;
    const genre   = cols[4].trim();
    const nom     = cols[5].trim();
    const key = dept + '|' + ville + '|' + libelle;
    if (!index[key]) index[key] = [];
    index[key].push({ rang, genre, nom });
  }
  // Trier par rang
  for (const k of Object.keys(index)) {
    index[k].sort((a, b) => a.rang - b.rang);
  }
  return index;
}

function getCandidatName(listIndex, memberIndex) {
  if (!candidatsData || !cityLocked || !useCandidates) return null;
  const list = committedLists[listIndex];
  if (!list._ville || !list._dept) return null;
  const key = list._dept + '|' + list._ville + '|' + list._libelle;
  const cands = candidatsData[key];
  if (!cands || memberIndex >= cands.length) return null;
  return cands[memberIndex].nom;
}

function getCandidatGenre(listIndex, memberIndex) {
  if (!candidatsData || !cityLocked || !useCandidates) return null;
  const list = committedLists[listIndex];
  if (!list._ville || !list._dept) return null;
  const key = list._dept + '|' + list._ville + '|' + list._libelle;
  const cands = candidatsData[key];
  if (!cands || memberIndex >= cands.length) return null;
  return cands[memberIndex].genre === 'F' ? 'F' : 'H';
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  // Nouvelle format: code_departement,ville,libelle_liste,nuance_politique,nom,prenom,genre
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 7) continue;
    rows.push({
      codeDept:  cols[0].trim(),
      ville:     cols[1].trim(),
      libelle:   cols[2].trim(),
      codeNuance:cols[3].trim(),
      nomTete:   cols[4].trim(),
      prenomTete:cols[5].trim(),
      sexeTete:  cols[6].trim(),
      taille:    parseInt(cols[7]) || 15,
    });
  }
  return rows;
}

function splitCSVLine(line) {
  // Gère les champs entre guillemets séparés par ,
  const result = [];
  let inQuote = false, cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

/* =========================================
   MODAL VILLE
   ========================================= */

const citySearchBtn    = document.getElementById('city-search-btn');
const cityOverlay      = document.getElementById('city-overlay');
const cityModal        = document.getElementById('city-modal');
const cityModalClose   = document.getElementById('city-modal-close');
const citySearchInput  = document.getElementById('city-search-input');
const cityResults      = document.getElementById('city-results');
const cityStep1        = document.getElementById('city-step-1');
const cityStep2        = document.getElementById('city-step-2');
const citySelectedCity = document.getElementById('city-selected-city');
const cityListsChk     = document.getElementById('city-lists-checkboxes');
const cityImportBtn    = document.getElementById('city-import-btn');

let selectedCityRows = []; // listes de la ville choisie

function openCityModal() {
  cityModal.classList.add('visible');
  cityOverlay.classList.add('visible');
  showCityStep1();
  citySearchInput.value = '';
  cityResults.innerHTML = '';
  setTimeout(() => citySearchInput.focus(), 50);
  // Précharger le CSV en arrière-plan
  loadCSV();
}

function closeCityModal() {
  cityModal.classList.remove('visible');
  cityOverlay.classList.remove('visible');
}

function applyLockUI() {
  addBtn.classList.add('hidden');
  document.querySelector('.validate-row').classList.add('seats-hidden');
  // citySearchBtn reste actif pour permettre de changer de ville
  document.getElementById('reset-btn').classList.remove('hidden');
  document.querySelector('.seats-input-group').classList.add('hidden');
}

function resetCity() {
  cityLocked = false;
  const cityLabel = document.getElementById('city-search-btn-label');
  if (cityLabel) cityLabel.textContent = 'Chercher une ville';
  useCandidates = false;
  candidatsData = null;
  window._candidateAssigned = null;
  draftLists = [
    { name: 'Liste A', color: getDefaultColor(0), votes: null, gender: null },
    { name: 'Liste B', color: getDefaultColor(1), votes: null, gender: null },
  ];
  forcedHeadIndex = null;
  renderForm();
  updateAddBtn();
  addBtn.classList.remove('hidden');
  document.querySelector('.validate-row').classList.remove('seats-hidden');
  document.getElementById('reset-btn').classList.add('hidden');
  document.querySelector('.seats-input-group').classList.remove('hidden');
  // Effacer les résultats
  committedLists = [];
  rankingState = [];
  resultsContent.innerHTML = '';
  document.querySelector('.results-placeholder')?.classList.remove('hidden');
  document.getElementById('share-btn').classList.remove('active');
}

function showCityStep1() {
  cityStep1.classList.remove('hidden');
  cityStep2.classList.add('hidden');
}

function showCityStep2(rows) {
  selectedCityRows = rows;
  cityStep1.classList.add('hidden');
  cityStep2.classList.remove('hidden');

  // Titre ville
  citySelectedCity.textContent = rows[0].ville + ' (' + rows[0].codeDept + ')';

  // Générer les checkboxes
  cityListsChk.innerHTML = '';
  rows.forEach((row, idx) => {
    const item = document.createElement('label');
    item.className = 'city-list-item';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'city-list-chk';
    chk.dataset.idx = idx;
    chk.addEventListener('change', updateImportBtn);

    const dot = document.createElement('span');
    dot.className = 'city-list-dot';
    dot.style.backgroundColor = getNuanceColor(row.codeNuance);

    const info = document.createElement('div');
    info.className = 'city-list-info';

    const top = document.createElement('div');
    top.className = 'city-list-name';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = row.libelle;
    const nuanceSpan = document.createElement('span');
    nuanceSpan.className = 'city-list-nuance';
    nuanceSpan.textContent = ' (' + getNuanceLabel(row.codeNuance) + ')';
    top.append(nameSpan, nuanceSpan);

    const sub = document.createElement('div');
    sub.className = 'city-list-head';
    sub.textContent = row.prenomTete + ' ' + row.nomTete;

    info.append(top, sub);
    item.append(chk, dot, info);
    cityListsChk.appendChild(item);
  });

  cityImportBtn.disabled = true;
}

function updateImportBtn() {
  const checked = cityListsChk.querySelectorAll('.city-list-chk:checked').length;
  cityImportBtn.disabled = checked < 2 || checked > 5;
}

function importSelectedLists() {
  const checked = [...cityListsChk.querySelectorAll('.city-list-chk:checked')];
  const toImport = checked.map(chk => selectedCityRows[parseInt(chk.dataset.idx)]);

  // Taille de liste : max des listes sélectionnées
  const maxTaille = Math.max(...toImport.map(r => r.taille));
  totalSeats = maxTaille;
  seatsInput.value = maxTaille;

  // Remplacer draftLists avec les couleurs de nuance + métadonnées pour candidats
  draftLists = toImport.map((row, i) => ({
    name:     row.libelle,
    color:    getNuanceColor(row.codeNuance),
    votes:    null,
    gender:   row.sexeTete === 'F' ? 'F' : (row.sexeTete === 'M' ? 'H' : null),
    _dept:    row.codeDept,
    _ville:   row.ville,
    _libelle: row.libelle,
  }));

  forcedHeadIndex = null;
  cityLocked = true;
  useCandidates = document.getElementById('city-use-candidates-chk').checked;

  renderForm();
  updateAddBtn();
  applyLockUI();
  // Mettre le nom de la ville dans le bouton
  const cityLabel = document.getElementById('city-search-btn-label');
  if (cityLabel) cityLabel.textContent = toImport[0].ville + ' (' + toImport[0].codeDept + ')';
  closeCityModal();

  // Charger les candidats du/des département(s) concerné(s)
  const depts = [...new Set(toImport.map(r => r.codeDept))];
  loadCandidatsCSV(depts);
}

// Recherche ville
let searchDebounce = null;
citySearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = citySearchInput.value.trim();
  if (q.length < 3) { cityResults.innerHTML = ''; return; }
  searchDebounce = setTimeout(() => searchCities(q), 150);
});

async function searchCities(q) {
  const data = await loadCSV();
  if (!data.length) {
    cityResults.innerHTML = '<div class="city-no-result">Impossible de charger la liste des villes.</div>';
    return;
  }

  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const qn = norm(q);

  // Dédoublonner par dept+ville
  const seen = new Set();
  const matches = [];
  for (const row of data) {
    const key = row.codeDept + '|' + row.ville;
    if (seen.has(key)) continue;
    if (norm(row.ville).startsWith(qn)) {
      seen.add(key);
      matches.push(row);
    }
  }

  // Trier par longueur de nom croissante, puis prendre les 10 premiers
  matches.sort((a, b) => a.ville.length - b.ville.length);
  const topMatches = matches.slice(0, 10);

  cityResults.innerHTML = '';
  if (!topMatches.length) {
    cityResults.innerHTML = '<div class="city-no-result">Aucune ville trouvée.</div>';
    return;
  }

  topMatches.forEach(row => {
    const btn = document.createElement('button');
    btn.className = 'city-result-item';
    btn.innerHTML = `<span class="city-result-name">${row.ville}</span><span class="city-result-dept">(${row.codeDept})</span>`;
    btn.addEventListener('click', () => {
      // Collapse la liste des suggestions
      cityResults.innerHTML = '';
      citySearchInput.value = row.ville;
      // Récupérer toutes les listes de cette ville+dept
      const rows = data.filter(r => r.codeDept === row.codeDept && r.ville === row.ville);
      showCityStep2(rows);
    });
    cityResults.appendChild(btn);
  });
}

// Events
citySearchBtn.addEventListener('click', openCityModal);

// Info modal
const infoOverlay   = document.getElementById('info-overlay');
const infoModal     = document.getElementById('info-modal');
const infoProjectBtn = document.getElementById('info-project-btn');
const infoModalClose = document.getElementById('info-modal-close');

function openInfoModal() {
  infoModal.classList.add('visible');
  infoOverlay.classList.add('visible');
}
function closeInfoModal() {
  infoModal.classList.remove('visible');
  infoOverlay.classList.remove('visible');
}
infoProjectBtn.addEventListener('click', openInfoModal);
infoModalClose.addEventListener('click', closeInfoModal);
infoOverlay.addEventListener('click', closeInfoModal);
document.getElementById('reset-btn').addEventListener('click', resetCity);
cityModalClose.addEventListener('click', closeCityModal);
cityOverlay.addEventListener('click', closeCityModal);
cityImportBtn.addEventListener('click', importSelectedLists);