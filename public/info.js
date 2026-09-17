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

  const players = data.players || [];
  if (players.length === 0) {
    container.innerHTML = '<p class="muted">Todavía nadie se ha conectado.</p>';
    return;
  }

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString();
    } catch (e) {
      return '—';
    }
  };

  const fmtDateTime = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return '—';
    }
  };

  container.innerHTML = players
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
}

function renderPacks(data) {
  const resContainer = $('resourcePacksList');
  const behContainer = $('behaviorPacksList');
  const resBadge = $('resPacksCountBadge');
  const behBadge = $('behPacksCountBadge');

  if (resBadge) resBadge.textContent = data.resourcePacks.length;
  if (behBadge) behBadge.textContent = data.behaviorPacks.length;

  const renderList = (list, type) => {
    if (list.length === 0) return '<p class="muted">Ninguno instalado.</p>';
    return list
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
  };

  if (resContainer) resContainer.innerHTML = renderList(data.resourcePacks, 'resources');
  if (behContainer) behContainer.innerHTML = renderList(data.behaviorPacks, 'behavior');
}

async function refresh() {
  try {
    const data = await api('api/public/info');

    const nameEl = $('serverName');
    if (nameEl) nameEl.textContent = data.serverName;

    const lvlEl = $('levelName');
    if (lvlEl) lvlEl.textContent = `Mundo: ${data.levelName}`;

    const addrEl = $('serverAddress');
    if (addrEl) addrEl.textContent = data.address;

    const portEl = $('serverPort');
    if (portEl) portEl.textContent = data.port;

    renderStatus(data);
    renderPlayers(data);
    renderPacks(data);
    renderAllPlayers(data);
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

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  e.preventDefault();

  const targetId = btn.dataset.copy;
  const target = $(targetId);
  if (!target) return;

  const text = target.textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = '✅';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1200);
  } catch (err) {
    alert('No se pudo copiar: ' + err.message);
  }
});

refresh();
setInterval(refresh, 10000);