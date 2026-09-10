/**
 * snapshot.mjs — dobowa migawka punktów + wykrywanie burzenia.
 *
 * Uruchamiane RAZ NA DOBĘ o 07:50 czasu polskiego, czyli tuż przed typowym oknem
 * uderzeń. Dzięki temu doba "od migawki do migawki" obejmuje całą akcję.
 *
 * Co robi:
 *   1. czyta świeże villages.json / players.json / conquers.json (te, które
 *      pobrał zwykły fetch.mjs kilka minut wcześniej),
 *   2. zapisuje migawkę punktów  ->  <świat>/points/RRRR-MM-DD.json
 *   3. porównuje z migawką z poprzedniej doby i zapisuje spadki
 *                                 ->  <świat>/drops/RRRR-MM-DD.json
 *   4. odświeża <świat>/drops/latest.json oraz <świat>/drops/index.json
 *
 * Przejęcia NIE są burzeniem: wioska, która w tym oknie zmieniła właściciela,
 * jest pomijana (sprawdzane w conquers.json).
 *
 * Migawka to same pary [id, punkty] — dla pl230 (21 tys. wiosek) około 250 kB.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORLDS = JSON.parse(await readFile(path.join(ROOT, 'worlds.json'), 'utf8'));

// próg: poniżej tylu punktów spadek traktujemy jako szum (pałac, drobny budynek)
const MIN_DROP = Number(process.env.MIN_DROP || 0);

/** Data w strefie polskiej — migawka ma nazwę doby, w której powstała. */
function todayPL() {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return f.format(new Date());            // RRRR-MM-DD
}

/** Zamienia {fields, rows} na mapę wg wskazanej kolumny klucza. */
function toMap(doc, keyCol, pick) {
  const idx = {};
  doc.fields.forEach((f, i) => { idx[f] = i; });
  const out = new Map();
  for (const row of doc.rows) out.set(row[idx[keyCol]], pick(row, idx));
  return out;
}

async function readJSON(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

/** Poprzednia migawka: najświeższa o nazwie mniejszej niż dzisiejsza. */
async function previousSnapshot(dir, today) {
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir))
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.slice(0, 10))
    .filter(d => d < today)
    .sort();
  if (!files.length) return null;
  const day = files[files.length - 1];
  return { day, data: await readJSON(path.join(dir, `${day}.json`)) };
}

for (const world of WORLDS.worlds ?? WORLDS) {
  const code = typeof world === 'string' ? world : world.code;
  const base = path.join(ROOT, code);
  if (!existsSync(path.join(base, 'villages.json'))) {
    console.log(`[${code}] brak villages.json — pomijam`);
    continue;
  }

  const today = todayPL();
  const villages = await readJSON(path.join(base, 'villages.json'));
  const players = existsSync(path.join(base, 'players.json'))
    ? await readJSON(path.join(base, 'players.json')) : null;
  const conquers = existsSync(path.join(base, 'conquers.json'))
    ? await readJSON(path.join(base, 'conquers.json')) : null;

  // --- 1. migawka punktów ---
  const vi = {};
  villages.fields.forEach((f, i) => { vi[f] = i; });
  const points = villages.rows.map(r => [r[vi.id], r[vi.points]]);
  const snapDir = path.join(base, 'points');
  await mkdir(snapDir, { recursive: true });
  await writeFile(path.join(snapDir, `${today}.json`),
    JSON.stringify({ world: code, day: today, fields: ['id', 'points'], rows: points }));
  console.log(`[${code}] migawka ${today}: ${points.length} wiosek`);

  // --- 2. porównanie z poprzednią dobą ---
  const prev = await previousSnapshot(snapDir, today);
  if (!prev) { console.log(`[${code}] brak poprzedniej migawki — pierwszy przebieg`); continue; }

  const before = new Map(prev.data.rows);

  // wioski przejęte w oknie między migawkami — spadek punktów to nie burzenie
  const conquered = new Set();
  if (conquers) {
    const ci = {};
    conquers.fields.forEach((f, i) => { ci[f] = i; });
    const fromTs = Date.parse(`${prev.day}T05:50:00Z`) / 1000;   // 07:50 PL ≈ 05:50 UTC
    for (const r of conquers.rows) {
      if (Number(r[ci.timestamp]) >= fromTs) conquered.add(r[ci.village_id]);
    }
  }

  const nameOf = new Map();
  const ownerOf = new Map();
  for (const r of villages.rows) {
    nameOf.set(r[vi.id], decodeURIComponent(String(r[vi.name]).replace(/\+/g, ' ')));
    ownerOf.set(r[vi.id], r[vi.player]);
  }
  const playerName = players
    ? toMap(players, 'id', (r, i) => decodeURIComponent(String(r[i.name]).replace(/\+/g, ' ')))
    : new Map();

  const drops = [];
  for (const r of villages.rows) {
    const id = r[vi.id];
    const now = r[vi.points];
    const was = before.get(id);
    if (was === undefined) continue;                 // nowa wioska
    if (conquered.has(id)) continue;                 // przejęcie, nie burzenie
    const drop = was - now;
    if (drop > MIN_DROP) {
      drops.push([
        `${r[vi.x]}|${r[vi.y]}`, id, nameOf.get(id) || '',
        playerName.get(ownerOf.get(id)) || '', was, now, drop
      ]);
    }
  }
  drops.sort((a, b) => b[6] - a[6]);

  const dropDir = path.join(base, 'drops');
  await mkdir(dropDir, { recursive: true });
  const doc = {
    world: code,
    day: today,
    from: prev.day,
    note: 'spadek punktów między migawkami 07:50 PL; przejęcia pominięte',
    fields: ['coord', 'villageId', 'villageName', 'player', 'pointsBefore', 'pointsAfter', 'drop'],
    rows: drops
  };
  await writeFile(path.join(dropDir, `${today}.json`), JSON.stringify(doc));
  await writeFile(path.join(dropDir, 'latest.json'), JSON.stringify(doc));

  const days = (await readdir(dropDir))
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.slice(0, 10)).sort();
  await writeFile(path.join(dropDir, 'index.json'), JSON.stringify({ world: code, days }));

  const total = drops.reduce((s, d) => s + d[6], 0);
  console.log(`[${code}] burzenie ${prev.day} → ${today}: ${drops.length} wiosek, ${total} pkt`);
}
