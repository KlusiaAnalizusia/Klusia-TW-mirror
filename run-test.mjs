/**
 * Test lokalny — podstawia sztuczne pliki świata zamiast sieci i przepuszcza
 * przez nie cały pipeline. Uruchom: node test/run-test.mjs
 */
import { gzipSync } from 'node:zlib';
import { readFile, rm, stat } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const WORLD = 'pl999';
const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');

/* ── sztuczne pliki świata ── */
const villages = [];
for (let i = 1; i <= 2000; i++) {
    const x = 400 + (i % 90), y = 480 + ((i * 7) % 90);
    const owner = i % 5 === 0 ? 0 : 1000 + (i % 300);
    villages.push([i, enc(i % 5 === 0 ? 'Wioska barbarzyńska' : `Wioska gracza ${i}`), x, y, owner, 1000 + (i % 9000), 0].join(','));
}
const players = [];
for (let i = 0; i < 300; i++) players.push([1000 + i, enc(`Gracz ${i} Ąćę`), i % 4 === 0 ? 0 : 500 + (i % 12), 1 + (i % 40), 3000 + i * 17, i + 1].join(','));
const tribes = [];
for (let i = 0; i < 12; i++) tribes.push([500 + i, enc(`Plemię ${i}`), enc(`P${i}`), 20, 300, 900000, 1200000, i + 1].join(','));
const conquers = [];
for (let i = 0; i < 80; i++) conquers.push([i + 1, 1757000000 + i * 900, 1000 + (i % 300), 1000 + ((i + 7) % 300)].join(','));
const kills = Array.from({ length: 300 }, (_, i) => [i + 1, 1000 + i, 5000000 - i * 1000].join(','));

const FILES = {
    'village.txt': villages.join('\n'),
    'player.txt': players.join('\n'),
    'ally.txt': tribes.join('\n'),
    'conquer.txt': conquers.join('\n'),
    'kill_att.txt': kills.join('\n'),
    'kill_def.txt': kills.join('\n'),
    'kill_all.txt': kills.join('\n'),
};
const XML = {
    get_config: '<config><speed>1.25</speed><unit_speed>0.8</unit_speed><snob><gold>0</gold></snob></config>',
    get_unit_info: '<config><spear><speed>18</speed></spear><snob><speed>35</speed></snob></config>',
};

/* ── podstawiona sieć ── */
let calls = 0;
globalThis.fetch = async (url) => {
    calls++;
    const u = String(url);
    const map = u.match(/\/map\/([a-z_]+\.txt)\.gz$/);
    if (map && FILES[map[1]] !== undefined) {
        // serwowane jako prawdziwy gzip — sprawdzamy też rozpakowywanie
        return new Response(gzipSync(Buffer.from(FILES[map[1]], 'utf8')), { status: 200 });
    }
    const xml = u.match(/func=(get_config|get_unit_info)/);
    if (xml) return new Response(XML[xml[1]], { status: 200 });
    if (u.startsWith('https://example.invalid')) return new Response('', { status: 404 });
    return new Response('not found', { status: 404 });
};

/* ── uruchomienie ── */
mkdirSync('test/tmp', { recursive: true });
writeFileSync('test/tmp/worlds.json', JSON.stringify({ worlds: [WORLD] }));
process.env.OUT_DIR = 'test/tmp/public';
process.env.WORLDS_FILE = 'test/tmp/worlds.json';
process.env.REQUEST_GAP_MS = '0';
process.env.SITE_URL = 'https://example.invalid/tw-mirror';
await rm('test/tmp/public', { recursive: true, force: true });

const { run } = await import('../scripts/fetch.mjs');
await run();

/* ── sprawdzenia ── */
let failed = 0;
const check = (label, cond, detail = '') => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? ' — ' + detail : ''}`);
    if (!cond) failed++;
};

const v = JSON.parse(await readFile(`test/tmp/public/${WORLD}/villages.json`, 'utf8'));
console.log('\nSprawdzenia:');
check('villages: liczba wierszy', v.rows.length === 2000, `${v.rows.length}`);
check('villages: nazwy kolumn', v.fields.join(',') === 'id,name,x,y,player,points,bonus', v.fields.join(','));
check('villages: nazwa rozkodowana', v.rows[0][1] === 'Wioska gracza 1', v.rows[0][1]);
check('villages: liczby są liczbami', typeof v.rows[0][2] === 'number' && typeof v.rows[0][5] === 'number');

const p = JSON.parse(await readFile(`test/tmp/public/${WORLD}/players.json`, 'utf8'));
check('players: polskie znaki w nickach', p.rows[0][1] === 'Gracz 0 Ąćę', p.rows[0][1]);

const t = JSON.parse(await readFile(`test/tmp/public/${WORLD}/tribes.json`, 'utf8'));
check('tribes: tag rozkodowany', t.rows[0][2] === 'P0', t.rows[0][2]);

const c = JSON.parse(await readFile(`test/tmp/public/${WORLD}/conquers.json`, 'utf8'));
check('conquers: 4 kolumny mimo schematu na 7', c.fields.length === 4, c.fields.join(','));

const cfg = await readFile(`test/tmp/public/${WORLD}/config.xml`, 'utf8');
check('config.xml zapisany bez zmian', cfg.includes('<unit_speed>0.8</unit_speed>'));

const meta = JSON.parse(await readFile(`test/tmp/public/${WORLD}/meta.json`, 'utf8'));
check('meta: nic nie jest przeterminowane', Object.values(meta.files).every(f => !f.stale));

const html = await readFile('test/tmp/public/index.html', 'utf8');
check('index.html zawiera świat', html.includes(WORLD));
check('index.html bez zewnętrznych zasobów', !/https?:\/\/(?!TWOJA)/.test(html.replace(/https:\/\/example\.invalid[^"'<\s]*/g, '')));

const sizes = await Promise.all(['villages', 'players', 'tribes'].map(async n => (await stat(`test/tmp/public/${WORLD}/${n}.json`)).size));
console.log(`\n2000 wiosek = ${(sizes[0] / 1024).toFixed(0)} kB JSON (realny świat ~60 tys. wiosek ≈ ${(sizes[0] / 1024 * 30 / 1024).toFixed(1)} MB, po kompresji HTTP ok. 4× mniej)`);
console.log(`Zapytań do serwera gry w jednym przebiegu: ${calls - 0} (w tym ${Object.keys(FILES).length} plików mapy + 2 XML)`);

/* ── awaria jednego pliku: dane nie znikają ── */
const orig = globalThis.fetch;
globalThis.fetch = async (url) => String(url).includes('village.txt') ? new Response('', { status: 503 }) : orig(url);
await import('node:fs/promises').then(fs => fs.writeFile('test/tmp/worlds.json', JSON.stringify({ worlds: [WORLD] })));
console.log('\nScenariusz awaryjny (village.txt zwraca 503, brak poprzedniej publikacji):');
try {
    const mod = await import('../scripts/fetch.mjs?v=2');
    await mod.run();
    const m2 = JSON.parse(await readFile(`test/tmp/public/${WORLD}/meta.json`, 'utf8'));
    check('przebieg nie przerywa się na jednym błędzie', true);
    check('meta oznacza villages jako nieudane', m2.files.villages.stale === true);
    check('reszta plików pobrana normalnie', m2.files.players.stale === false);
} catch (e) {
    check('przebieg nie przerywa się na jednym błędzie', false, e.message);
}

console.log(failed ? `\n${failed} sprawdzeń nie przeszło.` : '\nWszystkie sprawdzenia przeszły.');
process.exit(failed ? 1 : 0);
