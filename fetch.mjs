/**
 * Kopia danych świata Plemion — pobieranie i konwersja.
 *
 * Uruchamiane raz na godzinę przez GitHub Actions. Dla każdego świata z
 * worlds.json pobiera pliki /map/*.txt.gz oraz dwa pliki konfiguracyjne,
 * przerabia je na kompaktowy JSON i zapisuje do katalogu public/, który
 * Actions publikuje na GitHub Pages.
 *
 * Zero zależności — wszystko na wbudowanych modułach Node 20+.
 */

import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/* ─────────────────────────── Konfiguracja ─────────────────────────── */

const OUT_DIR = process.env.OUT_DIR || 'public';
const WORLDS_FILE = process.env.WORLDS_FILE || 'worlds.json';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const CONTACT = process.env.CONTACT || '';

const REQUEST_GAP_MS = Number(process.env.REQUEST_GAP_MS || 1500);   // odstęp między zapytaniami do serwera gry
const TIMEOUT_MS = 45000;
const ATTEMPTS = 3;

/**
 * Pliki mapy. `text` wskazuje kolumny, które są nazwami zakodowanymi
 * URL-em; reszta jest zamieniana na liczby. `min` to minimalna sensowna
 * liczba wierszy — poniżej niej uznajemy pobranie za nieudane.
 */
const SOURCES = [
    {
        out: 'villages', file: 'village.txt',
        fields: ['id', 'name', 'x', 'y', 'player', 'points', 'bonus'],
        text: ['name'], min: 100,
        check: (rows) => rows.every(r => r[2] >= 0 && r[2] <= 1000 && r[3] >= 0 && r[3] <= 1000),
        checkMsg: 'współrzędne poza zakresem 0–1000 — układ kolumn się zmienił',
    },
    {
        out: 'players', file: 'player.txt',
        fields: ['id', 'name', 'tribe', 'villages', 'points', 'rank'],
        text: ['name'], min: 10,
    },
    {
        out: 'tribes', file: 'ally.txt',
        fields: ['id', 'name', 'tag', 'members', 'villages', 'points', 'allPoints', 'rank'],
        text: ['name', 'tag'], min: 1, allowEmpty: true,
    },
    {
        out: 'conquers', file: 'conquer.txt',
        fields: ['village', 'ts', 'newOwner', 'oldOwner', 'oldTribe', 'newTribe', 'points'],
        text: [], min: 0, allowEmpty: true,
    },
    { out: 'kills_att', file: 'kill_att.txt', fields: ['rank', 'id', 'score'], text: [], min: 0, allowEmpty: true },
    { out: 'kills_def', file: 'kill_def.txt', fields: ['rank', 'id', 'score'], text: [], min: 0, allowEmpty: true },
    { out: 'kills_all', file: 'kill_all.txt', fields: ['rank', 'id', 'score'], text: [], min: 0, allowEmpty: true },
];

/** Pliki XML kopiowane bez zmian — skrypt w przeglądarce sparsuje je DOMParserem. */
const RAW_XML = [
    { out: 'config.xml', path: '/interface.php?func=get_config' },
    { out: 'unit_info.xml', path: '/interface.php?func=get_unit_info' },
];

/* ─────────────────────────── Pobieranie ─────────────────────────── */

function userAgent() {
    const parts = ['TW-Mirror/1.0'];
    const extra = [SITE_URL && `+${SITE_URL}`, CONTACT && `kontakt: ${CONTACT}`].filter(Boolean);
    if (extra.length) parts.push(`(${extra.join('; ')})`);
    return parts.join(' ');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function httpGet(url) {
    let lastErr;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': userAgent() },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            let buf = Buffer.from(await res.arrayBuffer());
            // .gz bywa podane albo jako surowy gzip, albo już rozpakowane przez
            // warstwę HTTP — rozpoznajemy po sygnaturze pliku.
            if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
            return buf;
        } catch (e) {
            lastErr = e;
            if (attempt < ATTEMPTS) await sleep(attempt * 4000);
        }
    }
    throw new Error(`${url} — ${lastErr && lastErr.message}`);
}

/* ─────────────────────────── Parsowanie ─────────────────────────── */

function decodeName(v) {
    try { return decodeURIComponent(v.replace(/\+/g, ' ')); }
    catch { return v.replace(/\+/g, ' '); }
}

function parseCsv(text, source) {
    const lines = text.split('\n');
    const textIdx = new Set(source.fields.map((f, i) => source.text.includes(f) ? i : -1).filter(i => i >= 0));
    const rows = [];
    let maxCols = 0;
    for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        const cols = s.split(',');
        if (cols.length > maxCols) maxCols = cols.length;
        rows.push(cols.map((v, i) => {
            if (textIdx.has(i)) return decodeName(v);
            if (v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : v;
        }));
    }
    const fields = [];
    for (let i = 0; i < maxCols; i++) fields.push(source.fields[i] || `col${i}`);
    return { fields, rows };
}

function validate(parsed, source) {
    if (!parsed.rows.length && !source.allowEmpty) throw new Error('pusty plik');
    if (parsed.rows.length < source.min) throw new Error(`tylko ${parsed.rows.length} wierszy, oczekiwano ≥ ${source.min}`);
    if (source.check && parsed.rows.length && !source.check(parsed.rows)) throw new Error(source.checkMsg);
}

/* ─────────────────── Awaryjne przepisanie poprzedniej wersji ─────────────────── */

/**
 * Gdy pobranie jednego pliku padnie, bierzemy wersję już opublikowaną na
 * stronie i publikujemy ją ponownie ze znacznikiem `stale`. Dzięki temu jeden
 * chwilowy błąd nie kasuje działających danych całego świata.
 */
async function reusePublished(world, name) {
    if (!SITE_URL) return null;
    try {
        const res = await fetch(`${SITE_URL}/${world}/${name}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch { return null; }
}

/* ─────────────────────────── Świat ─────────────────────────── */

async function buildWorld(world) {
    const base = `https://${world}.plemiona.pl`;
    const dir = join(OUT_DIR, world);
    await mkdir(dir, { recursive: true });

    const meta = { world, fetchedAt: new Date().toISOString(), files: {} };
    let anyFresh = false;

    for (const source of SOURCES) {
        const name = `${source.out}.json`;
        try {
            const buf = await httpGet(`${base}/map/${source.file}.gz`);
            const parsed = parseCsv(buf.toString('utf8'), source);
            validate(parsed, source);
            const body = JSON.stringify({
                world, source: source.file, fetchedAt: meta.fetchedAt,
                fields: parsed.fields, rows: parsed.rows,
            });
            await writeFile(join(dir, name), body);
            meta.files[source.out] = { rows: parsed.rows.length, bytes: Buffer.byteLength(body), stale: false };
            anyFresh = true;
            console.log(`  ✓ ${world}/${name} — ${parsed.rows.length} wierszy`);
        } catch (e) {
            const old = await reusePublished(world, name);
            if (old) {
                await writeFile(join(dir, name), old);
                meta.files[source.out] = { rows: null, bytes: old.length, stale: true, error: String(e.message || e) };
                console.log(`  ! ${world}/${name} — błąd, zostawiam poprzednie dane (${e.message})`);
            } else {
                meta.files[source.out] = { rows: null, bytes: 0, stale: true, error: String(e.message || e) };
                console.log(`  ✗ ${world}/${name} — ${e.message}`);
            }
        }
        await sleep(REQUEST_GAP_MS);
    }

    for (const xml of RAW_XML) {
        try {
            const buf = await httpGet(base + xml.path);
            if (!/<config|<unit/i.test(buf.toString('utf8').slice(0, 400))) throw new Error('to nie jest XML konfiguracji');
            await writeFile(join(dir, xml.out), buf);
            meta.files[xml.out] = { rows: null, bytes: buf.length, stale: false };
            anyFresh = true;
            console.log(`  ✓ ${world}/${xml.out}`);
        } catch (e) {
            const old = await reusePublished(world, xml.out);
            if (old) {
                await writeFile(join(dir, xml.out), old);
                meta.files[xml.out] = { rows: null, bytes: old.length, stale: true, error: String(e.message || e) };
            } else {
                meta.files[xml.out] = { rows: null, bytes: 0, stale: true, error: String(e.message || e) };
            }
            console.log(`  ✗ ${world}/${xml.out} — ${e.message}`);
        }
        await sleep(REQUEST_GAP_MS);
    }

    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
    return { meta, anyFresh };
}

/* ─────────────────────────── Strona statusu ─────────────────────────── */

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtBytes(b) {
    if (!b) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} kB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtRows(n) {
    return n == null ? '—' : n.toLocaleString('pl-PL');
}

function statusPage(index) {
    const stamp = new Date(index.generatedAt);
    const hhmm = stamp.toISOString().slice(11, 16);
    const date = stamp.toISOString().slice(0, 10);
    const stale = index.worlds.flatMap(w => Object.entries(w.files).filter(([, f]) => f.stale).map(([k]) => `${w.world}/${k}`));

    const worlds = index.worlds.map(w => {
        const rows = Object.entries(w.files).map(([name, f]) => `
            <tr${f.stale ? ' class="stale"' : ''}>
              <td><a href="${esc(w.world)}/${esc(name.endsWith('.xml') ? name : name + '.json')}">${esc(name)}</a></td>
              <td class="num">${fmtRows(f.rows)}</td>
              <td class="num">${fmtBytes(f.bytes)}</td>
              <td class="state">${f.stale ? 'poprzednie dane' : 'aktualne'}</td>
            </tr>`).join('');
        return `
        <section class="world">
          <header>
            <h2>${esc(w.world)}</h2>
            <span class="ts">pobrano ${esc(w.fetchedAt.slice(11, 16))} UTC</span>
          </header>
          <table>
            <thead><tr><th>plik</th><th class="num">wierszy</th><th class="num">rozmiar</th><th>stan</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>`;
    }).join('');

    return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Kopia danych świata</title>
<style>
  :root{
    --graphite:#1c2027; --graphite-2:#252b34; --parchment:#e8e0cd;
    --parchment-2:#f2ecdd; --cyan:#00d7ff; --magenta:#ff2c92; --ink:#0f1216;
    --mono:ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:32px 20px 64px; background:var(--parchment); color:var(--ink);
    font:15px/1.55 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
    background-image:
      radial-gradient(circle at 18% 12%, rgba(0,0,0,.05), transparent 55%),
      radial-gradient(circle at 82% 78%, rgba(120,90,40,.07), transparent 60%);
  }
  main{max-width:820px; margin:0 auto}
  .hero{
    background:linear-gradient(160deg,var(--graphite-2),var(--graphite));
    color:var(--parchment-2); padding:26px 28px; margin-bottom:28px;
    clip-path:polygon(14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%,0 14px);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07), 0 10px 24px rgba(15,18,22,.22);
  }
  .hero h1{margin:0 0 14px; font-size:13px; font-weight:600; letter-spacing:.14em; color:var(--cyan)}
  .clock{font:400 46px/1 var(--mono); letter-spacing:-.02em}
  .clock small{font-size:16px; opacity:.55; margin-left:10px; letter-spacing:0}
  .hero p{margin:14px 0 0; max-width:56ch; font-size:14px; color:rgba(232,224,205,.72)}
  .alert{
    margin-top:16px; padding:10px 12px; font:12px/1.5 var(--mono);
    border-left:3px solid var(--magenta); background:rgba(255,44,146,.1); color:#ffd7e9;
  }
  .world{
    background:var(--parchment-2); margin-bottom:18px; padding:18px 20px 6px;
    border:1px solid rgba(28,32,39,.16);
    clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);
  }
  .world header{display:flex; align-items:baseline; gap:12px; border-bottom:1px solid rgba(28,32,39,.14); padding-bottom:10px}
  .world h2{margin:0; font:600 20px/1 var(--mono)}
  .ts{font:12px/1 var(--mono); color:rgba(15,18,22,.5)}
  table{width:100%; border-collapse:collapse; font:13px/1 var(--mono)}
  th{
    text-align:left; font-weight:500; font-size:11px; letter-spacing:.06em;
    color:rgba(15,18,22,.5); padding:12px 8px 8px; border-bottom:1px solid rgba(0,215,255,.45);
  }
  td{padding:8px; border-bottom:1px solid rgba(28,32,39,.08)}
  .num{text-align:right; font-variant-numeric:tabular-nums}
  .state{color:rgba(15,18,22,.55)}
  tr.stale .state{color:var(--magenta)}
  a{color:#0a5f78; text-decoration:none; border-bottom:1px solid rgba(10,95,120,.3)}
  a:hover{border-bottom-color:currentColor}
  a:focus-visible{outline:2px solid var(--cyan); outline-offset:2px}
  .use{margin-top:26px; font-size:13px; color:rgba(15,18,22,.72)}
  .use code{font:12px/1.6 var(--mono); background:rgba(28,32,39,.07); padding:2px 5px}
  @media (max-width:520px){ .clock{font-size:34px} body{padding:20px 12px 48px} }
</style>
</head>
<body>
<main>
  <div class="hero">
    <h1>KOPIA DANYCH ŚWIATA</h1>
    <div class="clock">${esc(hhmm)}<small>UTC · ${esc(date)}</small></div>
    <p>Pliki mapy pobierane raz na godzinę i udostępniane tutaj, żeby skrypty nie musiały odpytywać serwera gry.</p>
    ${stale.length ? `<div class="alert">Ostatnie pobranie nie objęło: ${esc(stale.join(', '))} — pokazane są poprzednie dane.</div>` : ''}
  </div>
  ${worlds}
  <p class="use">Adres bazowy dla skryptów: <code>${esc(SITE_URL || 'https://TWOJA-NAZWA.github.io/tw-mirror')}</code>.
  Każdy plik JSON ma pola <code>fields</code> i <code>rows</code>, więc kolejność kolumn odczytujesz z pliku, a nie z pamięci.</p>
</main>
</body>
</html>`;
}

/* ─────────────────────────── Główna pętla ─────────────────────────── */

export async function run() {
    const cfg = JSON.parse(await readFile(WORLDS_FILE, 'utf8'));
    const worlds = cfg.worlds || [];
    if (!worlds.length) throw new Error('worlds.json nie zawiera żadnego świata');

    await mkdir(OUT_DIR, { recursive: true });
    const index = { generatedAt: new Date().toISOString(), worlds: [] };
    let ok = 0;

    for (const world of worlds) {
        console.log(`▸ ${world}`);
        const { meta, anyFresh } = await buildWorld(world);
        index.worlds.push(meta);
        if (anyFresh) ok++;
    }

    await writeFile(join(OUT_DIR, 'index.json'), JSON.stringify(index));
    await writeFile(join(OUT_DIR, 'index.html'), statusPage(index));

    if (!ok) throw new Error('żaden świat nie został pobrany — zostawiam poprzednią publikację bez zmian');
    console.log(`\nGotowe: ${ok}/${worlds.length} światów.`);
}

if (process.argv[1] && process.argv[1].endsWith('fetch.mjs')) {
    run().catch(e => { console.error('BŁĄD:', e.message); process.exit(1); });
}
