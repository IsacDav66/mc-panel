function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUptimeLong(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return '—';
  }
}

function versionText(v) {
  if (Array.isArray(v)) return v.join('.');
  return String(v || '?');
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------- Copiar al portapapeles con fallback para HTTP ----------
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }

  return new Promise((resolve, reject) => {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '-9999px';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);

      textarea.focus();
      textarea.select();
      try { textarea.setSelectionRange(0, textarea.value.length); } catch (e) {}

      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);

      if (ok) resolve();
      else reject(new Error('No se pudo copiar'));
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- Estado global ----------
let lastInfoData = null;
const COLLAPSE_LIMIT = 5;
const listState = {
  players: false,
  resources: false,
  behavior: false,
};

function buildToggleButton(type, total, expanded) {
  if (total <= COLLAPSE_LIMIT) return '';
  const hidden = total - COLLAPSE_LIMIT;
  const label = expanded ? 'Mostrar menos' : `Mostrar más (${hidden})`;
  const iconId = expanded ? 'i-chevron-up' : 'i-chevron-down';
  return `<button type="button" class="btn-toggle-list" data-toggle-list="${type}">
    <span>${label}</span>
    <svg class="icon"><use href="#${iconId}"/></svg>
  </button>`;
}

// ---------- Renders ----------
function renderStatus(data) {
  const pill = $('statusPill');
  const details = $('statusDetails');
  const uptimeBlock = $('uptimeBlock');
  const uptimeValue = $('uptimeValue');

  if (pill) {
    if (data.online) {
      pill.textContent = 'En línea';
      pill.className = 'pill pill-online';
    } else {
      pill.textContent = 'Offline';
      pill.className = 'pill pill-stopped';
    }
  }

  if (details) {
    const rows = [
      `<div class="row"><span>Modo</span><strong>${escapeHtml(capitalize(data.gamemode))}</strong></div>`,
      `<div class="row"><span>Dificultad</span><strong>${escapeHtml(capitalize(data.difficulty))}</strong></div>`,
      `<div class="row"><span>Jugadores</span><strong>${data.playersOnlineCount} / ${data.maxPlayers}</strong></div>`,
      `<div class="row"><span>Última conexión</span><strong>${escapeHtml(formatDate(data.lastActivity))}</strong></div>`,
    ];
    details.innerHTML = rows.join('');
  }

  if (uptimeBlock && uptimeValue) {
    if (data.online && data.uptimeMs) {
      uptimeValue.textContent = formatUptimeLong(data.uptimeMs);
      uptimeBlock.style.display = 'block';
    } else {
      uptimeBlock.style.display = 'none';
    }
  }
}

function renderVersion(data) {
  const el = $('versionValue');
  if (!el) return;
  el.textContent = data.version || 'Desconocida';
}

function renderPlayers(data) {
  const container = $('onlinePlayersList');
  const badge = $('playersCountBadge');
  if (badge) badge.textContent = data.playersOnlineCount;
  if (!container) return;

  if (!data.playersOnline || data.playersOnline.length === 0) {
    container.innerHTML = '<p class="muted">Nadie está jugando ahora mismo.</p>';
    return;
  }

  container.innerHTML = data.playersOnline
    .map((p) => `<div class="list-item"><div class="player-name">${escapeHtml(p.name)}</div></div>`)
    .join('');
}

function renderAllPlayers(data) {
  const container = $('allPlayersList');
  const badge = $('playersTotalBadge');
  if (badge) badge.textContent = data.playersTotalCount || 0;
  if (!container) return;

  const all = data.players || [];
  if (all.length === 0) {
    container.innerHTML = '<p class="muted">Todavía nadie se ha conectado.</p>';
    return;
  }

  const expanded = listState.players;
  const shown = expanded ? all : all.slice(0, COLLAPSE_LIMIT);

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString(); } catch (e) { return '—'; }
  };

  const fmtDateTime = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch (e) { return '—'; }
  };

  const rows = shown
    .map((p) => {
      const onlineTag = p.online
        ? '<span class="tag tag-online">En línea</span>'
        : '';
      return `
        <div class="player-public-row">
          <div class="player-public-name">
            ${onlineTag}
            <span>${escapeHtml(p.name)}</span>
          </div>
          <div class="player-public-meta" data-label="Primera vez">${escapeHtml(fmtDate(p.firstSeen))}</div>
          <div class="player-public-meta" data-label="Última vez">${escapeHtml(fmtDateTime(p.lastSeen))}</div>
        </div>`;
    })
    .join('');

  container.innerHTML = rows + buildToggleButton('players', all.length, expanded);
}

function renderPacks(data) {
  const resContainer = $('resourcePacksList');
  const behContainer = $('behaviorPacksList');
  const resBadge = $('resPacksCountBadge');
  const behBadge = $('behPacksCountBadge');

  if (resBadge) resBadge.textContent = data.resourcePacks.length;
  if (behBadge) behBadge.textContent = data.behaviorPacks.length;

  const renderList = (list, type, container, stateKey) => {
    if (!container) return;
    if (list.length === 0) {
      container.innerHTML = '<p class="muted">Ninguno instalado.</p>';
      return;
    }

    const expanded = listState[stateKey];
    const shown = expanded ? list : list.slice(0, COLLAPSE_LIMIT);

    const items = shown
      .map((p) => {
        const icon = `api/public/pack-icon?type=${type}&folder=${encodeURIComponent(p.folder)}&location=${encodeURIComponent(p.location || 'global')}`;
        const brokenTag = p.broken ? '<span class="tag tag-broken">Roto</span>' : '';
        const desc = p.description ? escapeHtml(p.description) : '';
        return `
          <div class="pack-item">
            <img class="pack-icon" src="${icon}" alt="" onerror="this.style.visibility='hidden'" />
            <div class="pack-info">
              <div class="pack-name">${escapeHtml(p.name)} ${brokenTag}</div>
              <div class="meta">v${escapeHtml(versionText(p.version))}${desc ? ' · ' + desc : ''}</div>
            </div>
          </div>`;
      })
      .join('');

    container.innerHTML = items + buildToggleButton(stateKey, list.length, expanded);
  };

  renderList(data.resourcePacks, 'resources', resContainer, 'resources');
  renderList(data.behaviorPacks, 'behavior', behContainer, 'behavior');
}

function renderAll(data) {
  renderStatus(data);
  renderVersion(data);
  renderPlayers(data);
  renderPacks(data);
  renderAllPlayers(data);
}

async function refresh() {
  try {
    const data = await api('api/public/info');
    lastInfoData = data;

    const nameEl = $('serverName');
    if (nameEl) nameEl.textContent = data.serverName;

    const lvlEl = $('levelName');
    if (lvlEl) lvlEl.textContent = `Mundo: ${data.levelName}`;

    const addrEl = $('serverAddress');
    if (addrEl) addrEl.textContent = data.address;

    const portEl = $('serverPort');
    if (portEl) portEl.textContent = data.port;

    renderAll(data);
  } catch (e) {
    const pill = $('statusPill');
    if (pill) {
      pill.textContent = 'Error';
      pill.className = 'pill pill-unknown';
    }
    const details = $('statusDetails');
    if (details) details.textContent = e.message;
  }
}

// ---------- Listeners ----------
document.addEventListener('click', async (e) => {
  // Toggle de listas colapsables
  const toggleBtn = e.target.closest('[data-toggle-list]');
  if (toggleBtn) {
    const type = toggleBtn.dataset.toggleList;
    if (type in listState) {
      listState[type] = !listState[type];
      if (lastInfoData) renderAll(lastInfoData);
    }
    return;
  }

  // Botones de copiar
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  e.preventDefault();

  const targetId = btn.dataset.copy;
  const target = $(targetId);
  if (!target) return;

  const text = target.textContent.trim();
  try {
    await copyToClipboard(text);
    btn.classList.add('copied');
    const use = btn.querySelector('use');
    if (use) {
      const original = use.getAttribute('href');
      use.setAttribute('href', '#i-check');
      setTimeout(() => {
        use.setAttribute('href', original);
        btn.classList.remove('copied');
      }, 1200);
    } else {
      setTimeout(() => btn.classList.remove('copied'), 1200);
    }
  } catch (err) {
    alert('No se pudo copiar: ' + err.message);
  }
});

refresh();
setInterval(refresh, 10000);