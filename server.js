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

// A simple in-memory lock so two operations don't collide (e.g. two uploads at once)
let busy = false;
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

const upload = multer({
  dest: UPLOAD_TMP,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
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

// Packs shipped by default inside the official Bedrock Dedicated Server download
// (vanilla assets, level editor, chemistry, experimental features, etc).
// We hide these by default since the user only cares about packs they installed themselves.
const BUILTIN_FOLDER_PATTERN = /^(vanilla|chemistry|editor|experimental_|server_editor_library|server_ui_library|image_experiment|physics)/i;
const BUILTIN_NAME_PATTERN = /^(resourcePack|behaviorPack)\./i;

function isBuiltInPack(folderName, builtInByName) {
  return BUILTIN_FOLDER_PATTERN.test(folderName) || builtInByName;
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
  } catch (e) {
    // ignore malformed lang files
  }
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
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const headerUuid = data.header && data.header.uuid;
    const headerVersion = normalizeVersion(data.header && data.header.version);
    const langMap = loadLangMap(dir);
    const rawName = (data.header && data.header.name) || path.basename(dir);
    const rawDescription = (data.header && data.header.description) || '';
    const name = resolveText(rawName, langMap);
    const description = resolveText(rawDescription, langMap);
    const modules = data.modules || [];
    let type = 'resources';
    if (modules.some((m) => m.type === 'data')) type = 'behavior';
    else if (modules.some((m) => m.type === 'resources')) type = 'resources';
    const builtInByName = BUILTIN_NAME_PATTERN.test(rawName || '');
    return { uuid: headerUuid, version: headerVersion, name, description, type, builtInByName };
  } catch (e) {
    return null;
  }
}

function listInstalledPacks(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return entries
    .map((e) => {
      const dir = path.join(baseDir, e.name);
      const manifest = readManifest(dir);
      if (!manifest) return null;
      const builtIn = isBuiltInPack(e.name, manifest.builtInByName);
      const { builtInByName, ...rest } = manifest;
      return { folder: e.name, builtIn, ...rest };
    })
    .filter(Boolean);
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

// ---------- helpers: generic JSON read/write ----------

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

// ---------- helpers: console / FIFO ----------

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
      'No se encontró el FIFO de consola (console.fifo). El servidor debe arrancar con el script start.sh para poder recibir comandos — revisa la guía de instalación de la consola.'
    );
  }
  // Writing to a FIFO that already has a reader open (see start.sh) is non-blocking.
  fs.appendFileSync(CONSOLE_FIFO, command.trim() + '\n');
}

// ---------- helpers: player tracking ----------

let onlineSet = new Set();
let logReadOffset = null; // set on first poll to current EOF, so we don't replay old history

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
  existing.name = name; // keep latest-seen casing/name
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
    // First run: don't replay the entire historical log, just start tracking from now.
    logReadOffset = size;
    return;
  }

  if (size < logReadOffset) {
    // Log file was rotated/truncated.
    logReadOffset = 0;
  }
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
  });
});

app.post('/api/server/:action', (req, res) => {
  withLock(res, async () => {
    pm2Action(req.params.action);
    res.json({ ok: true });
  });
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

    // 1. Backup current world
    if (fs.existsSync(worldPath)) {
      const backupZip = path.join(BACKUPS_DIR, `world-backup-${timestamp()}.zip`);
      await zipDirToFile(worldPath, backupZip);
    }

    // 2. Stop server
    let wasRunning = false;
    const proc = findPm2Process();
    if (proc && proc.pm2_env.status === 'online') {
      wasRunning = true;
      pm2Action('stop');
      await sleep(1500);
    }

    try {
      // 3. Replace world contents
      await rmrf(worldPath);
      await fsp.mkdir(worldPath, { recursive: true });
      const zip = new AdmZip(uploadedPath);
      zip.extractAllTo(worldPath, true);

      // Handle case where the zip has a single top-level folder wrapping the world
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

    // 4. Restart server if it was running
    if (wasRunning) {
      pm2Action('start');
    }

    res.json({ ok: true });
  });
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

// ---------- routes: addons / texture packs ----------

app.get('/api/addons', (req, res) => {
  const globalResourcePacks = listInstalledPacks(RESOURCE_PACKS_DIR).map((p) => ({ ...p, location: 'global' }));
  const globalBehaviorPacks = listInstalledPacks(BEHAVIOR_PACKS_DIR).map((p) => ({ ...p, location: 'global' }));

  const worldPath = getCurrentWorldPath();
  const worldResourcePacks = listInstalledPacks(path.join(worldPath, 'resource_packs')).map((p) => ({
    ...p,
    location: 'world',
    builtIn: false, // packs embedded in a world are never the server's built-in vanilla packs
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
      appliedToWorld: set.has(p.uuid),
      order: orderMap.has(p.uuid) ? orderMap.get(p.uuid) : null,
      isFirst: orderMap.get(p.uuid) === 0,
      isLast: orderMap.get(p.uuid) === total - 1,
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

app.post('/api/addons/upload', upload.single('addonfile'), (req, res) => {
  withLock(res, async () => {
    if (!req.file) throw new Error('No se recibió ningún archivo.');
    const uploadedPath = req.file.path;
    const extractTmp = path.join(UPLOAD_TMP, `addon-extract-${timestamp()}`);
    await fsp.mkdir(extractTmp, { recursive: true });

    const zip = new AdmZip(uploadedPath);
    zip.extractAllTo(extractTmp, true);
    await rmrf(uploadedPath);

    // Find every manifest.json inside (handles both .mcpack single-pack and .mcaddon multi-pack)
    const manifestDirs = [];
    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && e.name === 'manifest.json')) {
        manifestDirs.push(dir);
        return; // don't descend further into a pack we already found
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
      }
    }
    walk(extractTmp);

    if (manifestDirs.length === 0) {
      await rmrf(extractTmp);
      throw new Error('No se encontró ningún manifest.json — el archivo no parece ser un addon/texture pack válido.');
    }

    const installed = [];
    for (const dir of manifestDirs) {
      const manifest = readManifest(dir);
      if (!manifest || !manifest.uuid) continue;
      const targetBase = manifest.type === 'behavior' ? BEHAVIOR_PACKS_DIR : RESOURCE_PACKS_DIR;
      const folderName = `${manifest.name.replace(/[^a-z0-9_\-]/gi, '_')}-${manifest.uuid}`;
      const targetDir = path.join(targetBase, folderName);
      await rmrf(targetDir);
      await fsp.rename(dir, targetDir);

      // Apply to current world automatically
      const listFile = manifest.type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
      const list = readWorldPackList(listFile);
      const filtered = list.filter((p) => p.pack_id !== manifest.uuid);
      filtered.push({ pack_id: manifest.uuid, version: manifest.version });
      writeWorldPackList(listFile, filtered);

      installed.push({ name: manifest.name, type: manifest.type, uuid: manifest.uuid });
    }

    await rmrf(extractTmp);
    res.json({ ok: true, installed });
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

    res.json({ ok: true });
  });
});

// Enable/disable a pack for the current world without deleting it from disk.
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

    if (enabled) {
      withoutThis.push({ pack_id: manifest.uuid, version: manifest.version });
    }
    writeWorldPackList(listFile, withoutThis);
    res.json({ ok: true });
  });
});

// Move a pack up/down in priority order within the current world's pack list.
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
    if (targetIndex < 0 || targetIndex >= list.length) {
      return res.json({ ok: true }); // already at the edge, nothing to do
    }
    [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
    writeWorldPackList(listFile, list);
    res.json({ ok: true });
  });
});

// Serve a pack's icon (pack_icon.png), falling back to 404 if it doesn't have one.
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
  const bannedNames = new Set(banned.map((b) => (b.name || '').toLowerCase()));
  const allowlistNames = new Set(allowlist.map((a) => (a.name || '').toLowerCase()));

  const rows = Object.values(players)
    .map((p) => ({
      ...p,
      online: onlineSet.has(p.xuid),
      banned: bannedNames.has((p.name || '').toLowerCase()),
      allowlisted: allowlistNames.has((p.name || '').toLowerCase()),
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

app.listen(PORT, () => {
  console.log(`Panel corriendo en http://0.0.0.0:${PORT}`);
  console.log(`BEDROCK_DIR: ${BEDROCK_DIR}`);
});
