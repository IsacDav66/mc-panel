require('dotenv').config();
const express = require('express');
const basicAuth = require('express-basic-auth');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

const PORT = process.env.PORT || 8081;
const BEDROCK_DIR = process.env.BEDROCK_DIR || '/home/ubuntu/bedrock-server';
const PM2_NAME = process.env.PM2_PROCESS_NAME || 'minecraft-bedrock';
const WORLDS_DIR = path.join(BEDROCK_DIR, 'worlds');
const BACKUPS_DIR = path.join(BEDROCK_DIR, 'panel-backups');
const RESOURCE_PACKS_DIR = path.join(BEDROCK_DIR, 'resource_packs');
const BEHAVIOR_PACKS_DIR = path.join(BEDROCK_DIR, 'behavior_packs');
const PROPERTIES_FILE = path.join(BEDROCK_DIR, 'server.properties');
const CONSOLE_FIFO = path.join(BEDROCK_DIR, 'console.fifo');
const BANNED_PLAYERS_FILE = path.join(BEDROCK_DIR, 'banned-players.json');
const ALLOWLIST_FILE = path.join(BEDROCK_DIR, 'allowlist.json');
const PERMISSIONS_FILE = path.join(BEDROCK_DIR, 'permissions.json');
const PANEL_DATA_DIR = path.join(BEDROCK_DIR, 'panel-data');
const PLAYERS_FILE = path.join(PANEL_DATA_DIR, 'players.json');
const EVENTS_FILE = path.join(PANEL_DATA_DIR, 'events.json');
const MAX_EVENTS = 1000;

const UPLOAD_TMP = path.join(os.tmpdir(), 'mc-panel-uploads');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
fs.mkdirSync(RESOURCE_PACKS_DIR, { recursive: true });
fs.mkdirSync(BEHAVIOR_PACKS_DIR, { recursive: true });
fs.mkdirSync(PANEL_DATA_DIR, { recursive: true });

let busy = false;
let pendingRestart = false;

function withLock(res, fn) {
  if (busy) {
    return res.status(409).json({ error: 'Otra operación está en curso, espera a que termine.' });
  }
  busy = true;
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: err.message || String(err) });
    })
    .finally(() => {
      busy = false;
    });
}

// ---------- async job tracker ----------
const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    meta: {},
  });
  setTimeout(() => jobs.delete(id), JOB_TTL_MS);
  return id;
}

const upload = multer({
  dest: UPLOAD_TMP,
  limits: { fileSize: 500 * 1024 * 1024 },
});

const app = express();
app.use(express.json());

app.use(
  basicAuth({
    users: { [process.env.PANEL_USER || 'admin']: process.env.PANEL_PASS || 'cambia-esta-clave' },
    challenge: true,
    realm: 'MC Bedrock Panel',
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function readProperties() {
  const raw = fs.readFileSync(PROPERTIES_FILE, 'utf8');
  const props = {};
  raw.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    props[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  });
  return props;
}

function updateProperties(updates) {
  const raw = fs.readFileSync(PROPERTIES_FILE, 'utf8');
  const lines = raw.split('\n');
  const seen = new Set();
  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx);
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) result.push(`${k}=${v}`);
  }
  fs.writeFileSync(PROPERTIES_FILE, result.join('\n'));
}

function getLevelName() {
  const props = readProperties();
  return (props['level-name'] || 'Bedrock level').trim();
}

function getCurrentWorldPath() {
  return path.join(WORLDS_DIR, getLevelName());
}

function pm2Jlist() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    return [];
  }
}

function findPm2Process() {
  const list = pm2Jlist();
  return list.find((p) => p.name === PM2_NAME);
}

function pm2Action(action) {
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) throw new Error('Acción no permitida');
  execSync(`pm2 ${action} ${PM2_NAME}`, { encoding: 'utf8' });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function zipDirToFile(sourceDir, destZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizeVersion(v) {
  if (Array.isArray(v) && v.length > 0) return v.map((n) => Number(n) || 0);
  if (typeof v === 'string') {
    const parts = v.split('.').map((n) => Number(n) || 0);
    return parts.length > 0 ? parts : [1, 0, 0];
  }
  if (typeof v === 'number') return [v, 0, 0];
  return [1, 0, 0];
}

// Los packs del BDS vienen en minúsculas exactas. Cualquier carpeta con
// mayúsculas es de un usuario y nunca debe considerarse built-in.
const BUILTIN_EXACT = new Set([
  'vanilla',
  'chemistry',
  'editor',
  'server_editor_library',
  'server_library',
  'server_ui_library',
  'image_experiment',
  'physics',
]);

const BUILTIN_PREFIXES = [
  'vanilla_',
  'chemistry_',
  'physics_',
  'experimental_',
  'image_experiment_',
];

function isBuiltInFolder(folderName) {
  // BDS usa siempre minúsculas para sus carpetas internas.
  if (folderName !== folderName.toLowerCase()) return false;
  if (BUILTIN_EXACT.has(folderName)) return true;
  return BUILTIN_PREFIXES.some((p) => folderName.startsWith(p));
}

// Algunos manifiestos internos usan este name para marcarse como sistema.
const BUILTIN_NAME_PATTERN = /^(resourcePack|behaviorPack)\./i;

function isBuiltInPack(folderName, builtInByName) {
  return isBuiltInFolder(folderName) || builtInByName;
}

function loadLangMap(dir) {
  const textsDir = path.join(dir, 'texts');
  if (!fs.existsSync(textsDir)) return {};
  const candidates = ['en_US.lang', 'en_GB.lang'];
  let fileName = candidates.find((f) => fs.existsSync(path.join(textsDir, f)));
  if (!fileName) {
    const any = fs.readdirSync(textsDir).find((f) => f.endsWith('.lang'));
    fileName = any;
  }
  if (!fileName) return {};
  const map = {};
  try {
    const raw = fs.readFileSync(path.join(textsDir, fileName), 'utf8');
    raw.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('##') || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    });
  } catch (e) {}
  return map;
}

function looksLikeTranslationKey(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(value);
}

function resolveText(rawValue, langMap) {
  if (looksLikeTranslationKey(rawValue) && langMap[rawValue]) return langMap[rawValue];
  return rawValue;
}

function readManifest(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    let raw = fs.readFileSync(manifestPath, 'utf8');

    // Quitar BOM UTF-8 (los packs internos del BDS lo llevan)
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    raw = raw.replace(/^\uFEFF/, '').trim();

    const data = JSON.parse(raw);

    const headerUuid = data.header && data.header.uuid;
    const headerVersion = normalizeVersion(data.header && data.header.version);
    const minEngineVersion = Array.isArray(data.header && data.header.min_engine_version)
      ? data.header.min_engine_version
      : null;
    const langMap = loadLangMap(dir);
    const rawName = (data.header && data.header.name) || path.basename(dir);
    const rawDescription = (data.header && data.header.description) || '';
    const name = resolveText(rawName, langMap);
    const description = resolveText(rawDescription, langMap);

    const modules = data.modules || [];
    let type = 'resources';
    if (modules.some((m) => m.type === 'data')) type = 'behavior';
    else if (modules.some((m) => m.type === 'resources')) type = 'resources';

    const hasScripts = modules.some((m) => m.type === 'script');
    const scriptDeps = (data.dependencies || [])
      .filter((d) => d.module_name)
      .map((d) => `${d.module_name}@${d.version}`);

    const builtInByName = BUILTIN_NAME_PATTERN.test(rawName || '');
    return {
      uuid: headerUuid,
      version: headerVersion,
      name,
      description,
      type,
      builtInByName,
      minEngineVersion,
      hasScripts,
      scriptDeps,
    };
  } catch (e) {
    return null;
  }
}

function listInstalledPacks(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return entries.map((e) => {
    const dir = path.join(baseDir, e.name);
    const manifest = readManifest(dir);
    const builtInByFolder = isBuiltInFolder(e.name);

    if (!manifest) {
      return {
        folder: e.name,
        builtIn: builtInByFolder,
        uuid: null,
        name: e.name,
        description: 'manifest.json ilegible o ausente',
        version: null,
        type: null,
        broken: true,
      };
    }

    const builtIn = builtInByFolder || isBuiltInPack(e.name, manifest.builtInByName);
    const { builtInByName, ...rest } = manifest;
    return { folder: e.name, builtIn, ...rest };
  });
}

function readWorldPackList(fileName) {
  const worldPath = getCurrentWorldPath();
  const filePath = path.join(worldPath, fileName);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeWorldPackList(fileName, list) {
  const worldPath = getCurrentWorldPath();
  const filePath = path.join(worldPath, fileName);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
}

function readJson(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return defaultValue;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getPm2LogPaths() {
  const proc = findPm2Process();
  if (!proc || !proc.pm2_env) return null;
  return {
    out: proc.pm2_env.pm_out_log_path,
    err: proc.pm2_env.pm_err_log_path,
  };
}

function tailFile(filePath, lines) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    return execSync(`tail -n ${Number(lines) || 200} "${filePath}"`, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  } catch (e) {
    return '';
  }
}

function sendConsoleCommand(command) {
  if (!fs.existsSync(CONSOLE_FIFO)) {
    throw new Error(
      'No se encontró el FIFO de consola (console.fifo). El servidor debe arrancar con el script start.sh para poder recibir comandos.'
    );
  }
  fs.appendFileSync(CONSOLE_FIFO, command.trim() + '\n');
}

let onlineSet = new Set();
let logReadOffset = null;

function loadPlayers() {
  return readJson(PLAYERS_FILE, {});
}

function savePlayers(players) {
  writeJson(PLAYERS_FILE, players);
}

function appendEvent(event) {
  const events = readJson(EVENTS_FILE, []);
  events.push(event);
  while (events.length > MAX_EVENTS) events.shift();
  writeJson(EVENTS_FILE, events);
}

function touchPlayer(name, xuid, isOnline) {
  const players = loadPlayers();
  const key = xuid || name;
  const now = new Date().toISOString();
  const existing = players[key] || { name, xuid: xuid || null, firstSeen: now };
  existing.name = name;
  existing.lastSeen = now;
  existing.online = isOnline;
  players[key] = existing;
  savePlayers(players);
}

function pollServerLog() {
  const logPaths = getPm2LogPaths();
  if (!logPaths || !logPaths.out || !fs.existsSync(logPaths.out)) return;

  let size;
  try {
    size = fs.statSync(logPaths.out).size;
  } catch (e) {
    return;
  }

  if (logReadOffset === null) {
    logReadOffset = size;
    return;
  }

  if (size < logReadOffset) logReadOffset = 0;
  if (size === logReadOffset) return;

  const fd = fs.openSync(logPaths.out, 'r');
  const length = size - logReadOffset;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, logReadOffset);
  fs.closeSync(fd);
  logReadOffset = size;

  const text = buffer.toString('utf8');
  const lines = text.split('\n');

  const connectRe = /Player connected:\s*([^,]+),\s*xuid:\s*(\d+)/i;
  const disconnectRe = /Player disconnected:\s*([^,]+),\s*xuid:\s*(\d+)/i;

  for (const line of lines) {
    const connectMatch = line.match(connectRe);
    const disconnectMatch = line.match(disconnectRe);
    if (connectMatch) {
      const name = connectMatch[1].trim();
      const xuid = connectMatch[2].trim();
      onlineSet.add(xuid);
      touchPlayer(name, xuid, true);
      appendEvent({ type: 'join', name, xuid, timestamp: new Date().toISOString() });
    } else if (disconnectMatch) {
      const name = disconnectMatch[1].trim();
      const xuid = disconnectMatch[2].trim();
      onlineSet.delete(xuid);
      touchPlayer(name, xuid, false);
      appendEvent({ type: 'leave', name, xuid, timestamp: new Date().toISOString() });
    }
  }
}

setInterval(pollServerLog, 3000);

function getOnlinePlayers() {
  const players = loadPlayers();
  return Object.values(players).filter((p) => onlineSet.has(p.xuid));
}

function getLastActivity() {
  const players = loadPlayers();
  const timestamps = Object.values(players)
    .map((p) => p.lastSeen)
    .filter(Boolean)
    .sort();
  return timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
}

// ---------- updater helpers ----------

async function getLatestBedrockDownload() {
  const res = await fetch('https://net-secondary.web.minecraft-services.net/api/v1.0/download/links');
  if (!res.ok) throw new Error('No se pudo consultar la API de descargas de Mojang.');
  const data = await res.json();
  const links = data.result?.links || [];
  const linuxLink = links.find((l) => l.downloadType === 'serverBedrockLinux');
  if (!linuxLink) throw new Error('No se encontró el enlace de descarga para Linux.');
  const url = linuxLink.downloadUrl;
  const match = url.match(/bedrock-server-([\d.]+)\.zip/);
  const version = match ? match[1] : 'desconocida';
  return { url, version };
}

function getCurrentBedrockVersion() {
  // 1. Intentar leer version.json (formato oficial del BDS)
  const versionFile = path.join(BEDROCK_DIR, 'version.json');
  if (fs.existsSync(versionFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      // El archivo puede tener la clave "version" o "serverVersion"
      return data.version || data.serverVersion || null;
    } catch (e) {
      // Si falla el parseo, continuamos con el siguiente método
    }
  }

  // 2. Fallback: extraer la versión del nombre del archivo bedrock_server
  //    Normalmente el binario se llama "bedrock_server" y la versión está en el log o en el nombre del zip original.
  //    Una forma fiable es buscar en la carpeta un archivo como "bedrock-server-1.26.45.1.zip" o similar.
  try {
    const files = fs.readdirSync(BEDROCK_DIR);
    const versionedFile = files.find(f => f.startsWith('bedrock-server-') && f.endsWith('.zip'));
    if (versionedFile) {
      const match = versionedFile.match(/bedrock-server-([\d.]+)\.zip/);
      if (match) return match[1];
    }
  } catch (e) {}

  // 3. Último recurso: intentar obtenerla del ejecutable (puede no funcionar en todos los casos)
  try {
    const out = execSync(`strings "${path.join(BEDROCK_DIR, 'bedrock_server')}" | grep -m1 "v[0-9]"`, { encoding: 'utf8' });
    const match = out.match(/v([\d.]+)/);
    return match ? match[1] : null;
  } catch (e) {
    return null; // No se pudo determinar la versión
  }
}

// ---------- routes: status & server control ----------

app.get('/api/status', (req, res) => {
  const proc = findPm2Process();
  const onlinePlayers = getOnlinePlayers();
  const lastActivity = getLastActivity();
  if (!proc) {
    return res.json({ found: false, onlinePlayers, lastActivity });
  }
  res.json({
    found: true,
    status: proc.pm2_env.status,
    uptimeMs: proc.pm2_env.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
    restarts: proc.pm2_env.restart_time,
    memory: proc.monit ? proc.monit.memory : null,
    cpu: proc.monit ? proc.monit.cpu : null,
    levelName: getLevelName(),
    onlinePlayers,
    lastActivity,
    pendingRestart,
  });
});

app.post('/api/server/:action', (req, res) => {
  withLock(res, async () => {
    pm2Action(req.params.action);
    if (req.params.action === 'restart' || req.params.action === 'start') {
      pendingRestart = false;
    }
    res.json({ ok: true });
  });
});

app.get('/api/server/properties', (req, res) => {
  try {
    const props = readProperties();
    res.json({
      levelName: (props['level-name'] || '').trim(),
      gamemode: (props['gamemode'] || 'survival').trim(),
      difficulty: (props['difficulty'] || 'normal').trim(),
      seed: (props['level-seed'] || '').trim(),
      allowCheats: String(props['allow-cheats'] || 'true').trim() === 'true',
      playerPermission: (props['default-player-permission-level'] || 'member').trim(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- routes: updater ----------

// Cache para no golpear la API de Mojang en cada carga del panel
let updateCheckCache = { data: null, timestamp: 0 };
const UPDATE_CACHE_TTL = 60 * 60 * 1000; // 1 hora

app.get('/api/server/update/check', async (req, res) => {
  try {
    const forceRefresh = req.query.force === '1';
    const now = Date.now();

    if (!forceRefresh && updateCheckCache.data && now - updateCheckCache.timestamp < UPDATE_CACHE_TTL) {
      return res.json(updateCheckCache.data);
    }

    const current = getCurrentBedrockVersion();
    const latest = await getLatestBedrockDownload();
    const updateAvailable = !current || current !== latest.version;
    const data = { current, latest: latest.version, updateAvailable, downloadUrl: latest.url, checkedAt: now };

    updateCheckCache = { data, timestamp: now };
    res.json(data);
  } catch (e) {
    if (updateCheckCache.data) return res.json(updateCheckCache.data);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/server/update', (req, res) => {
  if (busy) {
    return res.status(409).json({ error: 'Otra operación está en curso, espera a que termine.' });
  }

  busy = true;
  const jobId = createJob();
  const job = jobs.get(jobId);

  res.json({ ok: true, jobId });

  (async () => {
    const updateTmpDir = path.join(UPLOAD_TMP, `bedrock-update-${timestamp()}`);
    try {
      job.meta.message = 'Consultando la última versión…';
      const latest = await getLatestBedrockDownload();
      job.meta.latestVersion = latest.version;

      job.meta.message = 'Deteniendo servidor…';
      let wasRunning = false;
      const proc = findPm2Process();
      if (proc && proc.pm2_env.status === 'online') {
        wasRunning = true;
        pm2Action('stop');
        await sleep(2000);
      }

      job.meta.message = 'Creando backup de seguridad…';
      const backupZip = path.join(BACKUPS_DIR, `pre-update-${timestamp()}.zip`);
      await zipDirToFile(BEDROCK_DIR, backupZip);

      job.meta.message = `Descargando versión ${latest.version}…`;
      const zipPath = path.join(updateTmpDir, 'bedrock-server.zip');
      await fsp.mkdir(updateTmpDir, { recursive: true });
      const downloadRes = await fetch(latest.url);
      if (!downloadRes.ok) throw new Error('Error al descargar el servidor.');
      const fileStream = fs.createWriteStream(zipPath);
      await new Promise((resolve, reject) => {
        downloadRes.body.pipe(fileStream);
        downloadRes.body.on('error', reject);
        fileStream.on('finish', resolve);
      });

      job.meta.message = 'Extrayendo nueva versión…';
      const extractDir = path.join(updateTmpDir, 'extracted');
      await fsp.mkdir(extractDir, { recursive: true });
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractDir, true);

      job.meta.message = 'Instalando nueva versión…';
      const preserve = [
        'server.properties',
        'allowlist.json',
        'permissions.json',
        'banned-players.json',
        'worlds',
        'resource_packs',
        'behavior_packs',
        'console.fifo',
      ];
      const preserveTmp = path.join(updateTmpDir, 'preserve');
      await fsp.mkdir(preserveTmp, { recursive: true });
      for (const item of preserve) {
        const src = path.join(BEDROCK_DIR, item);
        if (fs.existsSync(src)) {
          await fsp.rename(src, path.join(preserveTmp, item));
        }
      }
      const entries = await fsp.readdir(BEDROCK_DIR);
      for (const entry of entries) {
        if (entry === 'panel-backups' || entry === 'panel-data') continue;
        await rmrf(path.join(BEDROCK_DIR, entry));
      }
      await fsp.cp(extractDir, BEDROCK_DIR, { recursive: true });
      for (const item of preserve) {
        const src = path.join(preserveTmp, item);
        if (fs.existsSync(src)) {
          await fsp.rename(src, path.join(BEDROCK_DIR, item));
        }
      }

      await rmrf(updateTmpDir);

      if (wasRunning) {
        job.meta.message = 'Reiniciando servidor…';
        pm2Action('start');
      }
      pendingRestart = false;

      job.status = 'done';
      job.finishedAt = Date.now();
      job.meta.message = `Actualizado a la versión ${latest.version}.`;
    } catch (err) {
      console.error('Error en /api/server/update:', err);
      job.status = 'error';
      job.error = err.message || String(err);
      job.finishedAt = Date.now();
      await rmrf(updateTmpDir);
    } finally {
      busy = false;
    }
  })();
});

// ---------- jobs ----------

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado (o ya expiró).' });
  res.json(job);
});

// ---------- routes: world ----------

app.get('/api/world/download', (req, res) => {
  withLock(res, async () => {
    const worldPath = getCurrentWorldPath();
    if (!fs.existsSync(worldPath)) {
      busy = false;
      return res.status(404).json({ error: 'No se encontró la carpeta del mundo actual.' });
    }
    const tmpZip = path.join(UPLOAD_TMP, `world-${timestamp()}.zip`);
    await zipDirToFile(worldPath, tmpZip);
    res.download(tmpZip, `${getLevelName()}.mcworld`, async (err) => {
      await rmrf(tmpZip);
      busy = false;
      if (err) console.error(err);
    });
  });
});

app.post('/api/world/upload', upload.single('worldfile'), (req, res) => {
  withLock(res, async () => {
    if (!req.file) throw new Error('No se recibió ningún archivo.');
    const uploadedPath = req.file.path;
    const worldPath = getCurrentWorldPath();

    if (fs.existsSync(worldPath)) {
      const backupZip = path.join(BACKUPS_DIR, `world-backup-${timestamp()}.zip`);
      await zipDirToFile(worldPath, backupZip);
    }

    let wasRunning = false;
    const proc = findPm2Process();
    if (proc && proc.pm2_env.status === 'online') {
      wasRunning = true;
      pm2Action('stop');
      await sleep(1500);
    }

    try {
      await rmrf(worldPath);
      await fsp.mkdir(worldPath, { recursive: true });
      const zip = new AdmZip(uploadedPath);
      zip.extractAllTo(worldPath, true);

      const items = fs.readdirSync(worldPath);
      if (items.length === 1) {
        const onlyItem = path.join(worldPath, items[0]);
        if (fs.statSync(onlyItem).isDirectory() && fs.existsSync(path.join(onlyItem, 'level.dat'))) {
          const tmpMove = path.join(WORLDS_DIR, `__tmp_move_${timestamp()}`);
          await fsp.rename(onlyItem, tmpMove);
          await rmrf(worldPath);
          await fsp.rename(tmpMove, worldPath);
        }
      }
    } finally {
      await rmrf(uploadedPath);
    }

    if (wasRunning) pm2Action('start');
    res.json({ ok: true });
  });
});

app.post('/api/world/create', (req, res) => {
  if (busy) {
    return res.status(409).json({ error: 'Otra operación está en curso, espera a que termine.' });
  }

  const {
    worldName,
    gamemode = 'survival',
    difficulty = 'normal',
    seed = '',
    allowCheats = true,
    playerPermission = 'member',
  } = req.body || {};

  if (!worldName || !String(worldName).trim()) {
    return res.status(400).json({ error: 'El nombre del mundo es obligatorio.' });
  }
  const newName = String(worldName).trim();
  if (/[\/\\]/.test(newName)) {
    return res.status(400).json({ error: 'El nombre del mundo no puede contener "/" ni "\\".' });
  }
  const validGamemodes = ['survival', 'creative', 'adventure'];
  const validDifficulties = ['peaceful', 'easy', 'normal', 'hard'];
  const validPermissions = ['visitor', 'member', 'operator'];
  if (!validGamemodes.includes(gamemode)) return res.status(400).json({ error: 'Modo de juego inválido.' });
  if (!validDifficulties.includes(difficulty)) return res.status(400).json({ error: 'Dificultad inválida.' });
  if (!validPermissions.includes(playerPermission)) return res.status(400).json({ error: 'Permiso por defecto inválido.' });

  busy = true;
  const jobId = createJob();
  const job = jobs.get(jobId);
  job.meta = { worldName: newName };

  res.json({ ok: true, jobId, worldName: newName });

  (async () => {
    try {
      const oldWorldPath = getCurrentWorldPath();
      const newWorldPath = path.join(WORLDS_DIR, newName);

      if (fs.existsSync(oldWorldPath)) {
        const backupZip = path.join(BACKUPS_DIR, `world-backup-${timestamp()}.zip`);
        await zipDirToFile(oldWorldPath, backupZip);
      }

      let wasRunning = false;
      const proc = findPm2Process();
      if (proc && proc.pm2_env.status === 'online') {
        wasRunning = true;
        pm2Action('stop');
        await sleep(1500);
      }

      updateProperties({
        'level-name': newName,
        'gamemode': gamemode,
        'difficulty': difficulty,
        'allow-cheats': allowCheats ? 'true' : 'false',
        'default-player-permission-level': playerPermission,
        'level-seed': seed && String(seed).trim() !== '' ? String(seed).trim() : '',
      });

      if (newWorldPath !== oldWorldPath && fs.existsSync(newWorldPath)) {
        const backupZip = path.join(BACKUPS_DIR, `world-backup-${newName}-${timestamp()}.zip`);
        await zipDirToFile(newWorldPath, backupZip);
        await rmrf(newWorldPath);
      }
      await rmrf(oldWorldPath);

      if (wasRunning) pm2Action('start');
      pendingRestart = false;

      job.status = 'done';
      job.finishedAt = Date.now();
    } catch (err) {
      console.error('Error en /api/world/create:', err);
      job.status = 'error';
      job.error = err.message || String(err);
      job.finishedAt = Date.now();
    } finally {
      busy = false;
    }
  })();
});

app.get('/api/backups', (req, res) => {
  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { name: f, sizeBytes: stat.size, createdAt: stat.mtime };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(files);
});

app.get('/api/backups/:file', (req, res) => {
  const safeName = path.basename(req.params.file);
  const filePath = path.join(BACKUPS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No existe ese backup.' });
  res.download(filePath);
});

app.delete('/api/backups/:file', (req, res) => {
  const safeName = path.basename(req.params.file);
  const filePath = path.join(BACKUPS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No existe ese backup.' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ---------- routes: addons ----------

app.get('/api/addons', (req, res) => {
  const globalResourcePacks = listInstalledPacks(RESOURCE_PACKS_DIR).map((p) => ({ ...p, location: 'global' }));
  const globalBehaviorPacks = listInstalledPacks(BEHAVIOR_PACKS_DIR).map((p) => ({ ...p, location: 'global' }));

  const worldPath = getCurrentWorldPath();
  const worldResourcePacks = listInstalledPacks(path.join(worldPath, 'resource_packs')).map((p) => ({
    ...p,
    location: 'world',
    builtIn: false,
  }));
  const worldBehaviorPacks = listInstalledPacks(path.join(worldPath, 'behavior_packs')).map((p) => ({
    ...p,
    location: 'world',
    builtIn: false,
  }));

  const appliedResources = readWorldPackList('world_resource_packs.json');
  const appliedBehaviors = readWorldPackList('world_behavior_packs.json');
  const appliedResourceUuids = new Set(appliedResources.map((p) => p.pack_id));
  const appliedBehaviorUuids = new Set(appliedBehaviors.map((p) => p.pack_id));
  const resourceOrder = new Map(appliedResources.map((p, i) => [p.pack_id, i]));
  const behaviorOrder = new Map(appliedBehaviors.map((p, i) => [p.pack_id, i]));

  const withApplied = (list, set, orderMap, total) =>
    list.map((p) => ({
      ...p,
      appliedToWorld: p.uuid ? set.has(p.uuid) : false,
      order: p.uuid && orderMap.has(p.uuid) ? orderMap.get(p.uuid) : null,
      isFirst: p.uuid && orderMap.get(p.uuid) === 0,
      isLast: p.uuid && orderMap.get(p.uuid) === total - 1,
    }));

  res.json({
    resourcePacks: [
      ...withApplied(globalResourcePacks, appliedResourceUuids, resourceOrder, appliedResources.length),
      ...withApplied(worldResourcePacks, appliedResourceUuids, resourceOrder, appliedResources.length),
    ],
    behaviorPacks: [
      ...withApplied(globalBehaviorPacks, appliedBehaviorUuids, behaviorOrder, appliedBehaviors.length),
      ...withApplied(worldBehaviorPacks, appliedBehaviorUuids, behaviorOrder, appliedBehaviors.length),
    ],
  });
});


// -----------------------------------------------------------------
// Extracción recursiva de zips anidados (.mcaddon → .mcpack → ...)
// -----------------------------------------------------------------

const MAX_NESTED_DEPTH = 6;

async function extractNestedZips(rootDir, depth = 0) {
  if (depth > MAX_NESTED_DEPTH) return;

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      await extractNestedZips(fullPath, depth);
      continue;
    }

    if (!entry.isFile()) continue;

    const lower = entry.name.toLowerCase();
    const isZipLike =
      lower.endsWith('.mcpack') ||
      lower.endsWith('.mcaddon') ||
      lower.endsWith('.mctemplate') ||
      lower.endsWith('.zip');

    if (!isZipLike) continue;

    // Extraer en una carpeta hermana con nombre único
    const baseName = path.basename(entry.name, path.extname(entry.name));
    const extractDir = path.join(
      rootDir,
      `__extracted_${baseName}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
    );

    try {
      const nestedZip = new AdmZip(fullPath);
      nestedZip.getEntries(); // valida que es un zip real (lanza si no lo es)
      await fsp.mkdir(extractDir, { recursive: true });
      nestedZip.extractAllTo(extractDir, true);
      await fsp.unlink(fullPath); // borrar el .mcpack original ya extraído
      await extractNestedZips(extractDir, depth + 1);
    } catch (e) {
      // No era un zip válido — limpiamos y dejamos el archivo como está
      await rmrf(extractDir).catch(() => {});
    }
  }
}

// Devuelve todos los directorios que contienen un manifest.json,
// sin descender más allá de un manifest ya encontrado (un pack es un árbol).
function findManifestDirs(rootDir) {
  const result = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    const hasManifest = entries.some((e) => e.isFile() && e.name === 'manifest.json');
    if (hasManifest) {
      result.push(dir);
      return; // no descendemos más: ya es un pack
    }

    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name));
      }
    }
  }

  walk(rootDir);
  return result;
}


app.post('/api/addons/upload', upload.single('addonfile'), (req, res) => {
  withLock(res, async () => {
    if (!req.file) throw new Error('No se recibió ningún archivo.');
    const uploadedPath = req.file.path;
    const extractTmp = path.join(
      UPLOAD_TMP,
      `addon-extract-${timestamp()}-${crypto.randomBytes(4).toString('hex')}`
    );
    await fsp.mkdir(extractTmp, { recursive: true });

    // 1. Extraer el archivo subido (puede ser .mcaddon, .mcpack o .zip)
    try {
      const outerZip = new AdmZip(uploadedPath);
      outerZip.getEntries(); // valida
      outerZip.extractAllTo(extractTmp, true);
    } catch (e) {
      await rmrf(extractTmp).catch(() => {});
      await rmrf(uploadedPath).catch(() => {});
      throw new Error('El archivo no es un ZIP válido (.mcaddon, .mcpack o .zip).');
    }
    await rmrf(uploadedPath).catch(() => {});

    // 2. Extraer recursivamente .mcpack / .mcaddon / .zip que haya dentro
    await extractNestedZips(extractTmp, 0);

    // 3. Buscar TODOS los manifest.json en el árbol resultante
    const manifestDirs = findManifestDirs(extractTmp);

    if (manifestDirs.length === 0) {
      await rmrf(extractTmp);
      throw new Error(
        'No se encontró ningún manifest.json dentro del archivo. No parece ser un addon válido.'
      );
    }

    const installed = [];
    const skipped = [];

    // Ordenar: primero resources, luego behavior (por dependencias cruzadas)
    const ordered = [...manifestDirs].sort((a, b) => {
      const ma = readManifest(a);
      const mb = readManifest(b);
      const order = { resources: 0, behavior: 1 };
      return (order[ma?.type] ?? 0) - (order[mb?.type] ?? 0);
    });

    for (const dir of ordered) {
      const manifest = readManifest(dir);

      if (!manifest) {
        skipped.push({
          dir: path.relative(extractTmp, dir) || '.',
          reason: 'manifest.json ilegible',
        });
        continue;
      }
      if (!manifest.uuid) {
        skipped.push({
          dir: path.relative(extractTmp, dir) || '.',
          reason: 'falta header.uuid',
        });
        continue;
      }

      const targetBase =
        manifest.type === 'behavior' ? BEHAVIOR_PACKS_DIR : RESOURCE_PACKS_DIR;
      const folderName = `${manifest.name.replace(/[^a-z0-9_\-]/gi, '_')}-${manifest.uuid}`;
      const targetDir = path.join(targetBase, folderName);

      try {
        await rmrf(targetDir);
        // cp en lugar de rename para evitar EXDEV entre /tmp (tmpfs) y el disco
        await fsp.cp(dir, targetDir, { recursive: true, force: true });
        await rmrf(dir);
      } catch (e) {
        skipped.push({
          dir: path.relative(extractTmp, dir) || '.',
          reason: `no se pudo mover a ${
            manifest.type === 'behavior' ? 'behavior_packs' : 'resource_packs'
          }: ${e.message}`,
        });
        continue;
      }

      // Aplicar al mundo actual
      const listFile =
        manifest.type === 'behavior'
          ? 'world_behavior_packs.json'
          : 'world_resource_packs.json';
      try {
        const list = readWorldPackList(listFile);
        const filtered = list.filter((p) => p.pack_id !== manifest.uuid);
        filtered.push({ pack_id: manifest.uuid, version: manifest.version });
        writeWorldPackList(listFile, filtered);
      } catch (e) {
        skipped.push({
          dir: path.relative(extractTmp, dir) || '.',
          reason: `instalado pero no se pudo aplicar al mundo: ${e.message}`,
        });
        continue;
      }

      installed.push({
        name: manifest.name,
        type: manifest.type,
        uuid: manifest.uuid,
        folder: folderName,
        minEngineVersion: manifest.minEngineVersion,
        hasScripts: manifest.hasScripts,
      });
    }

    await rmrf(extractTmp).catch(() => {});
    if (installed.length > 0) pendingRestart = true;

    res.json({ ok: true, installed, skipped });
  });
});

app.delete('/api/addons/:type/:folder', (req, res) => {
  withLock(res, async () => {
    const { type, folder } = req.params;
    const location = req.query.location === 'world' ? 'world' : 'global';
    if (!['resources', 'behavior'].includes(type)) throw new Error('Tipo inválido');
    const baseDir =
      location === 'world'
        ? path.join(getCurrentWorldPath(), type === 'behavior' ? 'behavior_packs' : 'resource_packs')
        : type === 'behavior'
        ? BEHAVIOR_PACKS_DIR
        : RESOURCE_PACKS_DIR;
    const safeFolder = path.basename(folder);
    const dir = path.join(baseDir, safeFolder);
    if (!fs.existsSync(dir)) throw new Error('No existe ese addon.');

    const manifest = readManifest(dir);
    await rmrf(dir);

    if (manifest && manifest.uuid) {
      const listFile = type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
      const list = readWorldPackList(listFile).filter((p) => p.pack_id !== manifest.uuid);
      writeWorldPackList(listFile, list);
    }

    pendingRestart = true;
    res.json({ ok: true });
  });
});

app.post('/api/addons/:type/:folder/toggle', (req, res) => {
  withLock(res, async () => {
    const { type, folder } = req.params;
    const { location, enabled } = req.body;
    if (!['resources', 'behavior'].includes(type)) throw new Error('Tipo inválido');
    const loc = location === 'world' ? 'world' : 'global';
    const baseDir =
      loc === 'world'
        ? path.join(getCurrentWorldPath(), type === 'behavior' ? 'behavior_packs' : 'resource_packs')
        : type === 'behavior'
        ? BEHAVIOR_PACKS_DIR
        : RESOURCE_PACKS_DIR;
    const safeFolder = path.basename(folder);
    const dir = path.join(baseDir, safeFolder);
    const manifest = readManifest(dir);
    if (!manifest || !manifest.uuid) throw new Error('No se pudo leer el manifest de ese addon.');

    const listFile = type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
    const list = readWorldPackList(listFile);
    const withoutThis = list.filter((p) => p.pack_id !== manifest.uuid);

    if (enabled) withoutThis.push({ pack_id: manifest.uuid, version: manifest.version });
    writeWorldPackList(listFile, withoutThis);
    pendingRestart = true;
    res.json({ ok: true });
  });
});

app.post('/api/addons/:type/reorder', (req, res) => {
  withLock(res, async () => {
    const { type } = req.params;
    const { uuid, direction } = req.body;
    if (!['resources', 'behavior'].includes(type)) throw new Error('Tipo inválido');
    if (!['up', 'down'].includes(direction)) throw new Error('Dirección inválida');

    const listFile = type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
    const list = readWorldPackList(listFile);
    const index = list.findIndex((p) => p.pack_id === uuid);
    if (index === -1) throw new Error('Ese pack no está aplicado al mundo actual.');

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return res.json({ ok: true });
    [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
    writeWorldPackList(listFile, list);
    pendingRestart = true;
    res.json({ ok: true });
  });
});

app.get('/api/addons/icon', (req, res) => {
  const { type, location, folder } = req.query;
  if (!['resources', 'behavior'].includes(type)) return res.status(400).end();
  const safeFolder = path.basename(folder || '');
  const baseDir =
    location === 'world'
      ? path.join(getCurrentWorldPath(), type === 'behavior' ? 'behavior_packs' : 'resource_packs')
      : type === 'behavior'
      ? BEHAVIOR_PACKS_DIR
      : RESOURCE_PACKS_DIR;
  const iconPath = path.join(baseDir, safeFolder, 'pack_icon.png');
  if (!fs.existsSync(iconPath)) return res.status(404).end();
  res.sendFile(iconPath);
});

// ---------- routes: console ----------

app.get('/api/console/log', (req, res) => {
  const logPaths = getPm2LogPaths();
  if (!logPaths) return res.json({ log: '', found: false });
  const outText = tailFile(logPaths.out, req.query.lines || 200);
  res.json({ log: outText, found: true });
});

app.post('/api/console/send', (req, res) => {
  try {
    const { command } = req.body;
    if (!command || !command.trim()) throw new Error('Comando vacío.');
    sendConsoleCommand(command);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- routes: players ----------

app.get('/api/players', (req, res) => {
  const players = loadPlayers();
  const banned = readJson(BANNED_PLAYERS_FILE, []);
  const allowlist = readJson(ALLOWLIST_FILE, []);
  const permissions = readJson(PERMISSIONS_FILE, []);
  const bannedNames = new Set(banned.map((b) => (b.name || '').toLowerCase()));
  const allowlistNames = new Set(allowlist.map((a) => (a.name || '').toLowerCase()));
  const opXuids = new Set(
    permissions.filter((p) => p.permission === 'operator').map((p) => String(p.xuid))
  );

  const rows = Object.values(players)
    .map((p) => ({
      ...p,
      online: onlineSet.has(p.xuid),
      banned: bannedNames.has((p.name || '').toLowerCase()),
      allowlisted: allowlistNames.has((p.name || '').toLowerCase()),
      isOp: p.xuid ? opXuids.has(String(p.xuid)) : false,
    }))
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  res.json(rows);
});

app.post('/api/players/:name/ban', (req, res) => {
  try {
    const { name } = req.params;
    const { reason } = req.body || {};
    sendConsoleCommand(reason ? `ban "${name}" ${reason}` : `ban "${name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players/:name/unban', (req, res) => {
  try {
    sendConsoleCommand(`unban "${req.params.name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players/:name/kick', (req, res) => {
  try {
    sendConsoleCommand(`kick "${req.params.name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players/:name/op', (req, res) => {
  try {
    sendConsoleCommand(`op "${req.params.name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players/:name/deop', (req, res) => {
  try {
    sendConsoleCommand(`deop "${req.params.name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players/:name/gamemode', (req, res) => {
  try {
    const { mode } = req.body || {};
    const validModes = ['survival', 'creative', 'adventure', 'spectator'];
    if (!validModes.includes(mode)) throw new Error('Modo de juego inválido.');
    sendConsoleCommand(`gamemode ${mode} "${req.params.name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Panel corriendo en http://0.0.0.0:${PORT}`);
  console.log(`BEDROCK_DIR: ${BEDROCK_DIR}`);
});