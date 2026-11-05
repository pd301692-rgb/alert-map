const places = require('./gazetteer');

// Порядок важливий: перший збіг виграє.
const TYPES = [
  { id: 'ballistic', re: /баліст|баллист|іскандер|искандер|кинджал|кинжал|циркон|х-47|кн-23/ },
  { id: 'cruise', re: /крилат|крылат|х-101|х-555|х-22|х-59|х-31|калібр|калибр|ракет[аиу]? (?:типу|типа)|«оникс»|оникс/ },
  // \b у JS не працює з кирилицею, тому використовуємо lookaround
  { id: 'kab', re: /(?<![а-яіїєґ])каб(?:и|ів|ом|у|ами|ах)?(?![а-яіїєґ])|авіабомб|авиабомб|(?<![а-яіїєґ])фаб(?![а-яіїєґ])|умпк|керован\w* авіа/ },
  { id: 'shahed', re: /шахед|шахід|шахеди|шахидов|герань|geran|«герань»/ },
  { id: 'drone', re: /бпла|дрон|безпілот|беспилот|ударн\w* (?:бпла|дрон)|розвідувальн\w* бпла/ },
  { id: 'missile', re: /ракет|ракети|пуск/ },
  { id: 'mlrs', re: /рсзв|«град»|ураган|смерч|торнадо/ }
];

// Повідомлення про відбій / скасування — пропускаємо.
const CLEAR_RE = /відбій|отбой|відбою|загроза мин|минула загроза/;

function detectType(t) {
  for (const type of TYPES) if (type.re.test(t)) return type.id;
  return null;
}

function findPlaces(t) {
  const hits = [];
  for (const p of places) {
    for (const stem of p.stems) {
      // усі входження основи, а не лише перше
      let idx = t.indexOf(stem);
      while (idx !== -1) {
        hits.push({ place: p, idx, len: stem.length });
        idx = t.indexOf(stem, idx + 1);
      }
    }
  }
  // раніше в тексті → довший збіг
  hits.sort((a, b) => a.idx - b.idx || b.len - a.len);
  return hits;
}

function pickPlace(t) {
  const hits = findPlaces(t);
  if (!hits.length) return null;
  // "курсом на X", "у напрямку X" — беремо ціль
  const m = t.match(/курс(?:ом)?\s+на|у напрямку|в напрямку|напрямок|у бік|в сторону|на напрямку/);
  if (m) {
    const after = hits.find(h => h.idx > m.index);
    if (after) return after.place;
  }
  return hits[0].place;
}

function extractCount(t) {
  const m = t.match(/(\d{1,3})\s*(?:х\s*)?(?:ударн\w*\s*)?(?:шахед|шахід|бпла|дрон|ракет|каб|крилат|баліст)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseMessage(rawText) {
  const t = rawText.toLowerCase();
  if (CLEAR_RE.test(t)) return null;
  const type = detectType(t);
  if (!type) return null;
  const place = pickPlace(t);
  return {
    type,
    count: extractCount(t),
    place: place ? { name: place.name, lat: place.lat, lng: place.lng } : null
  };
}

// Для alerts.in.ua: знайти область за назвою
function findOblast(name) {
  const t = String(name || '').toLowerCase();
  if (t.includes('київ') && !t.includes('област') && !t.includes('київськ')) {
    return places.find(p => p.name === 'Київ');
  }
  return places.find(p => p.kind === 'oblast' && p.stems.some(s => t.includes(s))) || null;
}

module.exports = { parseMessage, findOblast };
