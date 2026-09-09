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

async function refreshStatus() {
  const pill = document.getElementById('statusPill');
  const details = document.getElementById('statusDetails');
  try {
    const data = await api('/api/status');
    if (!data.found) {
      pill.textContent = 'No encontrado';
      pill.className = 'pill pill-unknown';
      details.textContent = `No se encontró el proceso PM2. Revisa el nombre configurado en el panel.`;
      return;
    }
    const online = data.status === 'online';
    pill.textContent = online ? 'En línea' : 'Detenido';
    pill.className = `pill ${online ? 'pill-online' : 'pill-stopped'}`;
    details.innerHTML = `
      Mundo: <strong>${data.levelName}</strong><br/>
      Uptime: ${formatUptime(data.uptimeMs)} · Reinicios: ${data.restarts} · RAM: ${formatBytes(data.memory)}
    `;
    document.getElementById('worldName').textContent = data.levelName;
  } catch (e) {
    pill.textContent = 'Error';
    pill.className = 'pill pill-unknown';
    details.textContent = e.message;
  }
}

async function serverAction(action) {
  const buttons = ['btnStart', 'btnRestart', 'btnStop'].map((id) => document.getElementById(id));
  buttons.forEach((b) => (b.disabled = true));
  try {
    await api(`/api/server/${action}`, { method: 'POST' });
    setTimeout(refreshStatus, 1500);
  } catch (e) {
    alert(e.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.getElementById('btnStart').addEventListener('click', () => serverAction('start'));
document.getElementById('btnRestart').addEventListener('click', () => serverAction('restart'));
document.getElementById('btnStop').addEventListener('click', () => {
  if (confirm('¿Seguro que quieres detener el servidor? Los jugadores conectados serán desconectados.')) {
    serverAction('stop');
  }
});

document.getElementById('btnDownloadWorld').addEventListener('click', () => {
  window.location.href = '/api/world/download';
});

document.getElementById('formWorldUpload').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById('worldFile');
  const msg = document.getElementById('worldUploadMsg');
  if (!fileInput.files[0]) return;

  if (!confirm('Esto detendrá el servidor, hará un backup del mundo actual, y lo reemplazará. ¿Continuar?')) return;

  const formData = new FormData();
  formData.append('worldfile', fileInput.files[0]);

  msg.textContent = 'Subiendo y reemplazando mundo, esto puede tardar…';
  msg.className = 'msg';
  try {
    await api('/api/world/upload', { method: 'POST', body: formData });
    msg.textContent = '¡Mundo reemplazado con éxito!';
    msg.className = 'msg success';
    fileInput.value = '';
    refreshStatus();
    loadBackups();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg error';
  }
});

async function loadBackups() {
  const container = document.getElementById('backupsList');
  try {
    const backups = await api('/api/backups');
    if (backups.length === 0) {
      container.innerHTML = '<p class="muted">Todavía no hay backups.</p>';
      return;
    }
    container.innerHTML = backups
      .map(
        (b) => `
      <div class="list-item">
        <div>
          ${b.name}
          <div class="meta">${formatBytes(b.sizeBytes)} · ${new Date(b.createdAt).toLocaleString()}</div>
        </div>
        <div>
          <a href="/api/backups/${encodeURIComponent(b.name)}" class="btn btn-blue" style="padding:6px 10px;font-size:12px;">Descargar</a>
          <button class="icon-btn" data-file="${b.name}">Eliminar</button>
        </div>
      </div>`
      )
      .join('');
    container.querySelectorAll('.icon-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar el backup ${btn.dataset.file}?`)) return;
        await api(`/api/backups/${encodeURIComponent(btn.dataset.file)}`, { method: 'DELETE' });
        loadBackups();
      });
    });
  } catch (e) {
    container.textContent = e.message;
  }
}

let lastAddonsData = null;

function renderAddonLists() {
  if (!lastAddonsData) return;
  const showSystem = document.getElementById('showSystemPacks').checked;
  const resContainer = document.getElementById('resourcePacksList');
  const behContainer = document.getElementById('behaviorPacksList');

  const render = (list, type) => {
    const filtered = showSystem ? list : list.filter((p) => !p.builtIn);
    if (filtered.length === 0) {
      return showSystem || list.length === 0
        ? '<p class="muted">Ninguno instalado.</p>'
        : '<p class="muted">Solo hay paquetes del sistema instalados. Actívalos arriba para verlos.</p>';
    }
    return filtered
      .map((p) => {
        const versionText = Array.isArray(p.version) ? p.version.join('.') : String(p.version || '?');
        return `
      <div class="list-item">
        <div>
          ${p.name} ${p.appliedToWorld ? '<span class="tag">Aplicado al mundo</span>' : ''} ${p.builtIn ? '<span class="tag tag-system">Sistema</span>' : ''}
          <div class="meta">v${versionText} · ${p.description || ''}</div>
        </div>
        <button class="icon-btn" data-type="${type}" data-folder="${p.folder}">Eliminar</button>
      </div>`;
      })
      .join('');
  };

  resContainer.innerHTML = render(lastAddonsData.resourcePacks, 'resources');
  behContainer.innerHTML = render(lastAddonsData.behaviorPacks, 'behavior');

  document.querySelectorAll('.icon-btn[data-folder]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este addon/texture pack?')) return;
      await api(`/api/addons/${btn.dataset.type}/${encodeURIComponent(btn.dataset.folder)}`, { method: 'DELETE' });
      loadAddons();
    });
  });
}

async function loadAddons() {
  const resContainer = document.getElementById('resourcePacksList');
  try {
    lastAddonsData = await api('/api/addons');
    renderAddonLists();
  } catch (e) {
    resContainer.textContent = e.message;
  }
}

document.getElementById('showSystemPacks').addEventListener('change', renderAddonLists);

document.getElementById('formAddonUpload').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById('addonFile');
  const msg = document.getElementById('addonUploadMsg');
  if (!fileInput.files[0]) return;

  const formData = new FormData();
  formData.append('addonfile', fileInput.files[0]);

  msg.textContent = 'Instalando addon…';
  msg.className = 'msg';
  try {
    const result = await api('/api/addons/upload', { method: 'POST', body: formData });
    msg.textContent = `Instalado: ${result.installed.map((p) => p.name).join(', ')}. Reinicia el servidor para aplicar cambios.`;
    msg.className = 'msg success';
    fileInput.value = '';
    loadAddons();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg error';
  }
});

refreshStatus();
loadBackups();
loadAddons();
setInterval(refreshStatus, 8000);