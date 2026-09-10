// ============================================================
//  Helpers defensivos — evitan "Cannot read properties of null"
// ============================================================
function $(id) {
  const el = document.getElementById(id);
  if (!el) console.warn(`[panel] Elemento #${id} no existe en el DOM.`);
  return el;
}

function on(id, event, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[panel] Elemento #${id} no existe en el DOM — listener no añadido.`);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function formatUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
//  Status
// ============================================================
async function refreshStatus() {
  const pill = $('statusPill');
  const details = $('statusDetails');
  if (!pill || !details) return;

  try {
    const data = await api('api/status');
    if (!data.found) {
      pill.textContent = 'No encontrado';
      pill.className = 'pill pill-unknown';
      details.textContent = `No se encontró el proceso PM2. Revisa el nombre configurado en el panel.`;
    } else {
      const online = data.status === 'online';
      pill.textContent = online ? 'En línea' : 'Detenido';
      pill.className = `pill ${online ? 'pill-online' : 'pill-stopped'}`;
      details.innerHTML = `
        Mundo: <strong>${escapeHtml(data.levelName)}</strong><br/>
        Uptime: ${formatUptime(data.uptimeMs)} · Reinicios: ${data.restarts} · RAM: ${formatBytes(data.memory)}
      `;
      const wName = $('worldName');
      if (wName) wName.textContent = data.levelName;
    }

    const onlineContainer = $('onlinePlayersList');
    if (onlineContainer) {
      if (data.onlinePlayers && data.onlinePlayers.length > 0) {
        onlineContainer.innerHTML = data.onlinePlayers
          .map((p) => `<div class="list-item"><div>🟢 ${escapeHtml(p.name)}</div></div>`)
          .join('');
      } else {
        onlineContainer.innerHTML = '<p class="muted">Nadie está jugando ahora mismo.</p>';
      }
    }

    const lastActivityEl = $('lastActivity');
    if (lastActivityEl) {
      lastActivityEl.textContent = data.lastActivity
        ? `Última conexión: ${new Date(data.lastActivity).toLocaleString()}`
        : 'Todavía no hay registros de conexión.';
    }

    const restartBanner = $('restartBanner');
    if (restartBanner) restartBanner.style.display = data.pendingRestart ? 'flex' : 'none';
  } catch (e) {
    pill.textContent = 'Error';
    pill.className = 'pill pill-unknown';
    details.textContent = e.message;
  }
}

async function serverAction(action) {
  const buttons = ['btnStart', 'btnRestart', 'btnStop'].map((id) => $(id)).filter(Boolean);
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api(`api/server/${action}`, { method: 'POST' });
    setTimeout(refreshStatus, 1500);
  } catch (e) {
    alert(e.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

on('btnStart', 'click', () => serverAction('start'));
on('btnRestart', 'click', () => serverAction('restart'));
on('btnStop', 'click', () => {
  if (confirm('¿Seguro que quieres detener el servidor? Los jugadores conectados serán desconectados.')) {
    serverAction('stop');
  }
});
on('btnRestartFromBanner', 'click', () => serverAction('restart'));

// ============================================================
//  World download / upload
// ============================================================
on('btnDownloadWorld', 'click', () => {
  window.location.href = 'api/world/download';
});

on('formWorldUpload', 'submit', async (e) => {
  e.preventDefault();
  const fileInput = $('worldFile');
  const msg = $('worldUploadMsg');
  if (!fileInput || !fileInput.files[0]) return;

  if (!confirm('Esto detendrá el servidor, hará un backup del mundo actual, y lo reemplazará. ¿Continuar?')) return;

  const formData = new FormData();
  formData.append('worldfile', fileInput.files[0]);

  if (msg) {
    msg.textContent = 'Subiendo y reemplazando mundo, esto puede tardar…';
    msg.className = 'msg';
  }
  try {
    await api('api/world/upload', { method: 'POST', body: formData });
    if (msg) {
      msg.textContent = '¡Mundo reemplazado con éxito!';
      msg.className = 'msg success';
    }
    fileInput.value = '';
    refreshStatus();
    loadBackups();
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  }
});

// ============================================================
//  Create world
// ============================================================
async function loadServerProperties() {
  try {
    const p = await api('api/server/properties');
    const nameEl = $('cwName');
    if (nameEl) nameEl.placeholder = p.levelName || 'Mi Mundo Nuevo';
    const gm = $('cwGamemode'); if (gm) gm.value = p.gamemode || 'survival';
    const diff = $('cwDifficulty'); if (diff) diff.value = p.difficulty || 'normal';
    const seed = $('cwSeed'); if (seed) seed.value = p.seed || '';
    const cheats = $('cwCheats'); if (cheats) cheats.value = p.allowCheats ? 'true' : 'false';
    const perm = $('cwPermission'); if (perm) perm.value = p.playerPermission || 'member';
  } catch (e) {
    /* silencioso */
  }
}

on('formCreateWorld', 'submit', async (e) => {
  e.preventDefault();
  const msg = $('createWorldMsg');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const nameEl = $('cwName');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) {
    if (msg) {
      msg.textContent = 'Ponle un nombre al mundo.';
      msg.className = 'msg error';
    }
    return;
  }
  if (!confirm(`Se creará un mundo nuevo llamado "${name}" y se reemplazará el actual. ¿Continuar?`)) return;

  const body = {
    worldName: name,
    gamemode: $('cwGamemode')?.value || 'survival',
    difficulty: $('cwDifficulty')?.value || 'normal',
    seed: $('cwSeed')?.value || '',
    allowCheats: ($('cwCheats')?.value || 'true') === 'true',
    playerPermission: $('cwPermission')?.value || 'member',
  };

  if (submitBtn) submitBtn.disabled = true;
  if (msg) {
    msg.textContent = 'Iniciando creación del mundo…';
    msg.className = 'msg';
  }

  try {
    const { jobId } = await api('api/world/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    let done = false;
    while (!done) {
      await new Promise((r) => setTimeout(r, 2000));
      const job = await api(`api/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === 'done') {
        if (msg) {
          msg.textContent = '¡Mundo creado! El servidor está regenerando el mundo.';
          msg.className = 'msg success';
        }
        done = true;
        setTimeout(refreshStatus, 2000);
        loadBackups();
      } else if (job.status === 'error') {
        if (msg) {
          msg.textContent = `Error: ${job.error}`;
          msg.className = 'msg error';
        }
        done = true;
      } else {
        const secs = Math.round((Date.now() - job.startedAt) / 1000);
        if (msg) {
          msg.textContent = `Creando mundo… (${secs}s) — no cierres esta pestaña.`;
          msg.className = 'msg';
        }
      }
    }
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

// ============================================================
//  Server Update
// ============================================================
let autoUpdateCheckInterval = null;

function applyUpdateCheckResult(data) {
  const banner = $('updateBanner');
  const bannerText = $('updateBannerText');
  const msg = $('updateMsg');
  const btnUpdate = $('btnUpdateServer');

  if (data.updateAvailable) {
    if (bannerText) {
      bannerText.innerHTML = `🎉 Nueva actualización detectada: <strong>${escapeHtml(data.latest)}</strong> (actual: ${escapeHtml(data.current || 'desconocida')})`;
    }
    if (banner) banner.style.display = 'flex';
    if (msg) {
      msg.innerHTML = `Nueva versión disponible: <strong>${escapeHtml(data.latest)}</strong> (actual: ${escapeHtml(data.current || 'desconocida')})`;
      msg.className = 'msg';
    }
    if (btnUpdate) {
      btnUpdate.disabled = false;
      btnUpdate.dataset.downloadUrl = data.downloadUrl;
    }
  } else {
    if (banner) banner.style.display = 'none';
    if (msg) {
      msg.textContent = `El servidor está actualizado (versión ${data.current || '?'}).`;
      msg.className = 'msg success';
    }
    if (btnUpdate) btnUpdate.disabled = true;
  }
}

async function checkForUpdates(force = false) {
  const msg = $('updateMsg');
  try {
    const url = force ? 'api/server/update/check?force=1' : 'api/server/update/check';
    const data = await api(url);
    applyUpdateCheckResult(data);
  } catch (e) {
    if (force && msg) {
      msg.textContent = e.message;
      msg.className = 'msg error';
    }
  }
}

async function applyUpdate() {
  const msg = $('updateMsg');
  const btnUpdate = $('btnUpdateServer');
  const btnBanner = $('btnUpdateFromBanner');
  if (!confirm('Esto detendrá el servidor, hará un backup completo y aplicará la actualización. ¿Continuar?')) return;

  if (btnUpdate) btnUpdate.disabled = true;
  if (btnBanner) btnBanner.disabled = true;
  if (msg) {
    msg.textContent = 'Iniciando actualización…';
    msg.className = 'msg';
  }

  try {
    const { jobId } = await api('api/server/update', { method: 'POST' });
    let done = false;
    while (!done) {
      await new Promise((r) => setTimeout(r, 2000));
      const job = await api(`api/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === 'done') {
        if (msg) {
          msg.textContent = job.meta?.message || 'Servidor actualizado correctamente.';
          msg.className = 'msg success';
        }
        done = true;
        const banner = $('updateBanner');
        if (banner) banner.style.display = 'none';
        setTimeout(() => checkForUpdates(true), 3000);
        refreshStatus();
        loadBackups();
      } else if (job.status === 'error') {
        if (msg) {
          msg.textContent = `Error: ${job.error}`;
          msg.className = 'msg error';
        }
        done = true;
      } else {
        const secs = Math.round((Date.now() - job.startedAt) / 1000);
        if (msg) {
          msg.textContent = `${job.meta?.message || 'Actualizando…'} (${secs}s)`;
          msg.className = 'msg';
        }
      }
    }
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  } finally {
    if (btnUpdate) btnUpdate.disabled = false;
    if (btnBanner) btnBanner.disabled = false;
  }
}

on('btnCheckUpdates', 'click', () => checkForUpdates(true));
on('btnUpdateServer', 'click', applyUpdate);
on('btnUpdateFromBanner', 'click', applyUpdate);

// ============================================================
//  Backups
// ============================================================
async function loadBackups() {
  const container = $('backupsList');
  if (!container) return;
  try {
    const backups = await api('api/backups');
    if (backups.length === 0) {
      container.innerHTML = '<p class="muted">Todavía no hay backups.</p>';
      return;
    }
    container.innerHTML = backups
      .map(
        (b) => `
      <div class="list-item">
        <div>
          ${escapeHtml(b.name)}
          <div class="meta">${formatBytes(b.sizeBytes)} · ${new Date(b.createdAt).toLocaleString()}</div>
        </div>
        <div>
          <a href="api/backups/${encodeURIComponent(b.name)}" class="btn btn-blue" style="padding:6px 10px;font-size:12px;">Descargar</a>
          <button class="icon-btn" data-file="${escapeHtml(b.name)}">Eliminar</button>
        </div>
      </div>`
      )
      .join('');
    container.querySelectorAll('.icon-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar el backup ${btn.dataset.file}?`)) return;
        await api(`api/backups/${encodeURIComponent(btn.dataset.file)}`, { method: 'DELETE' });
        loadBackups();
      });
    });
  } catch (e) {
    container.textContent = e.message;
  }
}

// ============================================================
//  Addons
// ============================================================
let lastAddonsData = null;

function iconUrl(p) {
  const type = p.type === 'behavior' ? 'behavior' : 'resources';
  return `api/addons/icon?type=${type}&location=${p.location}&folder=${encodeURIComponent(p.folder)}`;
}

function renderAddonLists() {
  if (!lastAddonsData) return;
  const showSystemEl = $('showSystemPacks');
  const showSystem = showSystemEl ? showSystemEl.checked : false;
  const resContainer = $('resourcePacksList');
  const behContainer = $('behaviorPacksList');

  const render = (list, type) => {
    const filtered = showSystem ? list : list.filter((p) => !p.builtIn);
    if (filtered.length === 0) {
      return showSystem || list.length === 0
        ? '<p class="muted">Ninguno instalado.</p>'
        : '<p class="muted">Solo hay paquetes del sistema instalados. Actívalos arriba para verlos.</p>';
    }
    return filtered
      .map((p) => {
        const versionText = Array.isArray(p.version)
          ? p.version.join('.')
          : String(p.version || '?');
        const brokenTag = p.broken
          ? '<span class="tag tag-system" title="No se pudo leer el manifest.json">Roto</span>'
          : '';
        const scriptTag = p.hasScripts
          ? '<span class="tag" style="background:rgba(79,140,255,0.15);color:var(--blue);">Scripts</span>'
          : '';
        const orderDisabled = !p.uuid || !p.appliedToWorld;
        return `
      <div class="pack-item">
        <img class="pack-icon" src="${iconUrl(p)}" onerror="this.style.visibility='hidden'" alt="" />
        <div class="pack-info">
          <div>${escapeHtml(p.name)} ${p.builtIn ? '<span class="tag tag-system">Sistema</span>' : ''} ${p.location === 'world' ? '<span class="tag tag-world">En el mundo</span>' : ''} ${brokenTag} ${scriptTag}</div>
          <div class="meta">v${escapeHtml(versionText)} · ${escapeHtml(p.description || '')}</div>
        </div>
        <div class="pack-actions">
          <button class="order-btn" data-action="up" data-type="${type}" data-uuid="${escapeHtml(p.uuid || '')}" ${orderDisabled || p.isFirst ? 'disabled' : ''}>▲</button>
          <button class="order-btn" data-action="down" data-type="${type}" data-uuid="${escapeHtml(p.uuid || '')}" ${orderDisabled || p.isLast ? 'disabled' : ''}>▼</button>
          <label class="switch" title="Activar/desactivar para el mundo actual">
            <input type="checkbox" data-toggle="${type}" data-folder="${escapeHtml(p.folder)}" data-location="${escapeHtml(p.location)}" ${p.appliedToWorld ? 'checked' : ''} ${p.broken ? 'disabled' : ''} />
            <span class="slider"></span>
          </label>
          <button class="icon-btn" data-type="${type}" data-folder="${escapeHtml(p.folder)}" data-location="${escapeHtml(p.location)}">Eliminar</button>
        </div>
      </div>`;
      })
      .join('');
  };

  if (resContainer) resContainer.innerHTML = render(lastAddonsData.resourcePacks, 'resources');
  if (behContainer) behContainer.innerHTML = render(lastAddonsData.behaviorPacks, 'behavior');

  document.querySelectorAll('.icon-btn[data-folder]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este addon/texture pack?')) return;
      await api(
        `api/addons/${btn.dataset.type}/${encodeURIComponent(btn.dataset.folder)}?location=${btn.dataset.location}`,
        { method: 'DELETE' }
      );
      loadAddons();
    });
  });

  document.querySelectorAll('input[data-toggle]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api(
          `api/addons/${input.dataset.toggle}/${encodeURIComponent(input.dataset.folder)}/toggle`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: input.dataset.location, enabled: input.checked }),
          }
        );
        loadAddons();
      } catch (e) {
        alert(e.message);
        input.checked = !input.checked;
      }
    });
  });

  document.querySelectorAll('.order-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!btn.dataset.uuid) return;
      try {
        await api(`api/addons/${btn.dataset.type}/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: btn.dataset.uuid, direction: btn.dataset.action }),
        });
        loadAddons();
      } catch (e) {
        alert(e.message);
      }
    });
  });
}

async function loadAddons() {
  const resContainer = $('resourcePacksList');
  try {
    lastAddonsData = await api('api/addons');
    renderAddonLists();
  } catch (e) {
    if (resContainer) resContainer.textContent = e.message;
  }
}

on('showSystemPacks', 'change', renderAddonLists);

on('formAddonUpload', 'submit', async (e) => {
  e.preventDefault();
  const fileInput = $('addonFile');
  const msg = $('addonUploadMsg');
  if (!fileInput || !fileInput.files[0]) return;

  const formData = new FormData();
  formData.append('addonfile', fileInput.files[0]);

  if (msg) {
    msg.textContent = 'Instalando addon…';
    msg.className = 'msg';
  }
  try {
    const result = await api('api/addons/upload', { method: 'POST', body: formData });

    const parts = [];
    if (result.installed?.length) {
      parts.push(`✅ Instalados: ${result.installed.map((p) => escapeHtml(p.name)).join(', ')}.`);
    }
    if (result.skipped?.length) {
      parts.push(
        `⚠️ Omitidos: ${result.skipped
          .map((s) => `${escapeHtml(s.dir)} (${escapeHtml(s.reason)})`)
          .join(' | ')}`
      );
    }
    if (parts.length === 0) parts.push('No se instaló ningún pack.');

    if (msg) {
      msg.innerHTML =
        parts.join('<br/>') +
        (result.installed?.length ? '<br/>Reinicia el servidor para aplicar cambios.' : '');
      msg.className = result.skipped?.length ? 'msg error' : 'msg success';
    }

    fileInput.value = '';
    loadAddons();
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  }
});

// ============================================================
//  Console
// ============================================================
async function refreshConsole() {
  const output = $('consoleOutput');
  if (!output) return;
  try {
    const data = await api('api/console/log?lines=200');
    const wasAtBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 20;
    output.textContent = data.found
      ? data.log || '(sin salida todavía)'
      : 'No se encontró el proceso del servidor.';
    if (wasAtBottom) output.scrollTop = output.scrollHeight;
  } catch (e) {
    output.textContent = e.message;
  }
}

on('formConsoleSend', 'submit', async (e) => {
  e.preventDefault();
  const input = $('consoleInput');
  if (!input) return;
  const command = input.value.trim();
  if (!command) return;
  input.value = '';
  try {
    await api('api/console/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    setTimeout(refreshConsole, 800);
  } catch (err) {
    alert(err.message);
  }
});

// ============================================================
//  Skin 3D viewer
// ============================================================
let currentSkinViewer = null;

function skinAvatarUrl(player, size = 40) {
  if (player.xuid) return `https://mc-heads.net/avatar/xuid_${player.xuid}/${size}`;
  return `https://mc-heads.net/avatar/${encodeURIComponent(player.name)}/${size}`;
}

function skinTextureUrl(player) {
  if (player.xuid) return `https://mc-heads.net/skin/xuid_${player.xuid}`;
  return `https://mc-heads.net/skin/${encodeURIComponent(player.name)}`;
}

function closeSkinModal() {
  const modal = $('skinModal');
  if (modal) modal.style.display = 'none';
  if (currentSkinViewer) {
    try {
      currentSkinViewer.dispose();
    } catch (e) {}
    currentSkinViewer = null;
  }
}

async function openSkinModal(player) {
  const modal = $('skinModal');
  const nameEl = $('skinModalName');
  if (!modal) return;
  if (nameEl) nameEl.textContent = player.name;
  modal.style.display = 'flex';

  const canvas = $('skinCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (currentSkinViewer) {
    try {
      currentSkinViewer.dispose();
    } catch (e) {}
    currentSkinViewer = null;
  }

  if (typeof skinview3d === 'undefined') {
    const hint = $('skinModalHint');
    if (hint) hint.textContent = 'No se pudo cargar el visor 3D (CDN no disponible).';
    return;
  }

  try {
    currentSkinViewer = new skinview3d.SkinViewer({
      canvas,
      width: 200,
      height: 320,
      skin: skinTextureUrl(player),
      preserveDrawingBuffer: true,
    });
    currentSkinViewer.autoRotate = true;
    currentSkinViewer.autoRotateSpeed = 0.6;
    currentSkinViewer.animation = new skinview3d.WalkingAnimation();
    currentSkinViewer.animation.speed = 1;
    const hint = $('skinModalHint');
    if (hint) hint.textContent = 'Arrastra para rotar · rueda para zoom';
  } catch (e) {
    console.error(e);
    const hint = $('skinModalHint');
    if (hint) hint.textContent = 'No se pudo cargar la skin 3D.';
  }
}

on('skinModalClose', 'click', closeSkinModal);
on('skinModal', 'click', (e) => {
  if (e.target.id === 'skinModal') closeSkinModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSkinModal();
});

// ============================================================
//  Players
// ============================================================
async function loadPlayers() {
  const container = $('playersTable');
  if (!container) return;
  try {
    const players = await api('api/players');
    if (players.length === 0) {
      container.innerHTML = '<p class="muted">Todavía nadie se ha conectado.</p>';
      return;
    }
    const header = `
      <div class="players-table-header">
        <div>Jugador</div><div>Primera vez</div><div>Última vez</div><div>Estado</div><div>Modo</div><div>Acciones</div>
      </div>`;
    const rows = players
      .map((p) => {
        const statusBadges = [
          p.online
            ? '<span class="tag" style="background:rgba(62,207,142,0.15);color:var(--green);">En línea</span>'
            : '',
          p.banned
            ? '<span class="tag" style="background:rgba(240,87,107,0.15);color:var(--red);">Baneado</span>'
            : '',
          p.isOp
            ? '<span class="tag" style="background:rgba(255,169,77,0.15);color:var(--orange);">Admin</span>'
            : '',
          p.allowlisted ? '<span class="tag">Allowlist</span>' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const safeName = escapeHtml(p.name);
        const skinUrl = skinAvatarUrl(p);
        const fallback = `https://mc-heads.net/avatar/MHF_Steve/40`;
        return `
        <div class="player-row">
          <div class="player-cell-name">
            <img class="player-skin" src="${skinUrl}"
                 onerror="this.onerror=null;this.src='${fallback}'"
                 data-name="${safeName}" title="Ver skin 3D" />
            <span>${safeName}</span>
          </div>
          <div class="meta">${p.firstSeen ? new Date(p.firstSeen).toLocaleDateString() : '—'}</div>
          <div class="meta">${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : '—'}</div>
          <div>${statusBadges || '—'}</div>
          <div>
            <select class="gamemode-select" data-name="${safeName}">
              <option value="">Modo…</option>
              <option value="survival">Survival</option>
              <option value="creative">Creative</option>
              <option value="adventure">Adventure</option>
              <option value="spectator">Spectator</option>
            </select>
          </div>
          <div class="player-actions">
            ${p.online ? `<button class="btn-mini-kick" data-action="kick" data-name="${safeName}">Expulsar</button>` : ''}
            ${
              p.isOp
                ? `<button class="btn-mini-unban" data-action="deop" data-name="${safeName}">Quitar admin</button>`
                : `<button class="btn-mini-kick" data-action="op" data-name="${safeName}">Dar admin</button>`
            }
            ${
              p.banned
                ? `<button class="btn-mini-unban" data-action="unban" data-name="${safeName}">Desbanear</button>`
                : `<button class="btn-mini-ban" data-action="ban" data-name="${safeName}">Banear</button>`
            }
          </div>
        </div>`;
      })
      .join('');
    container.innerHTML = header + rows;

    container.querySelectorAll('.player-skin').forEach((img) => {
      img.addEventListener('click', () => {
        const player = players.find((p) => p.name === img.dataset.name);
        if (player) openSkinModal(player);
      });
    });

    container.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { action, name } = btn.dataset;
        try {
          if (action === 'ban') {
            const reason = prompt(`Razón del ban para ${name} (opcional):`, '') || '';
            if (!confirm(`¿Banear a ${name}?`)) return;
            await api(`api/players/${encodeURIComponent(name)}/ban`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reason }),
            });
          } else if (action === 'unban') {
            if (!confirm(`¿Desbanear a ${name}?`)) return;
            await api(`api/players/${encodeURIComponent(name)}/unban`, { method: 'POST' });
          } else if (action === 'kick') {
            if (!confirm(`¿Expulsar a ${name}?`)) return;
            await api(`api/players/${encodeURIComponent(name)}/kick`, { method: 'POST' });
          } else if (action === 'op') {
            if (!confirm(`¿Dar admin (op) a ${name}?`)) return;
            await api(`api/players/${encodeURIComponent(name)}/op`, { method: 'POST' });
          } else if (action === 'deop') {
            if (!confirm(`¿Quitar admin a ${name}?`)) return;
            await api(`api/players/${encodeURIComponent(name)}/deop`, { method: 'POST' });
          }
          setTimeout(loadPlayers, 1200);
        } catch (e) {
          alert(e.message);
        }
      });
    });

    container.querySelectorAll('.gamemode-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const mode = sel.value;
        const name = sel.dataset.name;
        if (!mode) return;
        try {
          await api(`api/players/${encodeURIComponent(name)}/gamemode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
          });
          sel.value = '';
          setTimeout(loadPlayers, 1200);
        } catch (e) {
          alert(e.message);
          sel.value = '';
        }
      });
    });
  } catch (e) {
    container.textContent = e.message;
  }
}

// ============================================================
//  Boot
// ============================================================
refreshStatus();
loadServerProperties();
loadBackups();
loadAddons();
refreshConsole();
loadPlayers();

// Chequeo de actualizaciones: al abrir + cada 30 min
checkForUpdates(false);
autoUpdateCheckInterval = setInterval(() => checkForUpdates(false), 30 * 60 * 1000);

setInterval(refreshStatus, 8000);
setInterval(refreshConsole, 5000);
setInterval(loadPlayers, 15000);