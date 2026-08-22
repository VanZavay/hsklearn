let DICTIONARY = [];
let SENTENCES = [];
let ETYMOLOGY_OVERRIDES = {words:{}, chars:{}};
let ETYMOLOGY_DB = {words:{}, chars:{}};
let speechVoiceList = [];
let preferredChineseVoice = null;

function parseSentenceList(text) {
  const entries = [];
  let currentLevel = 1;
  text.split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    const levelMatch = line.match(/^HSK\s+(\d+)/i);
    if (levelMatch) {
      currentLevel = parseInt(levelMatch[1], 10);
      return;
    }
    const sentenceMatch = line.match(/^\d+\.\s*(.+)$/);
    if (sentenceMatch) {
      entries.push({zh: sentenceMatch[1].trim(), l: currentLevel});
    }
  });
  return entries;
}

function mergeSentenceData(sentenceText, metaEntries) {
  if (Array.isArray(metaEntries) && metaEntries.length > 0) {
    return metaEntries.map(entry => ({
      zh: entry.zh,
      py: entry.py || '',
      t: entry.t || '',
      opts: Array.isArray(entry.opts) ? entry.opts.slice(0, 4) : [],
      l: entry.l || 1
    }));
  }

  const parsedSentences = parseSentenceList(sentenceText);
  return parsedSentences.map((entry, index) => {
    const distractors = parsedSentences
      .filter((candidate, candidateIndex) => candidateIndex !== index)
      .slice(0, 3)
      .map(candidate => candidate.zh);
    return {
      zh: entry.zh,
      py: '',
      t: entry.zh,
      opts: [entry.zh, ...distractors].slice(0, 4),
      l: entry.l
    };
  });
}

async function loadAppData() {
  // Data is embedded directly in data.js (loaded via a normal <script> tag
  // before this file), so the app works when opened straight from disk
  // (file://) with no server and no network requests required.
  if (typeof WORDS_DATA === 'undefined') {
    throw new Error('data.js failed to load — make sure data.js is present next to index.html and app.js.');
  }
  DICTIONARY = Array.isArray(WORDS_DATA) ? WORDS_DATA : [];
  ETYMOLOGY_OVERRIDES = MNEMONICS_DATA?.overrides || {words:{}, chars:{}};
  ETYMOLOGY_DB = buildEtymologyDb(MNEMONICS_DATA?.seed || {});
  SENTENCES = mergeSentenceData('', Array.isArray(SENTENCES_DATA) ? SENTENCES_DATA : []);
  tagSentenceWordRequirements();
  buildCharPinyinMap();
}

// Matches dictionary words (longest first) against each sentence's Chinese
// text so we know exactly which vocabulary a sentence actually requires.
// This lets sentence practice stay within words the learner has actually
// reached instead of just "same HSK level", which can include far more
// words than they've studied so far (e.g. lesson 2 of HSK1 only knows ~30
// of the 149 HSK1 words, but a same-level sentence could use any of them).
// The same segmentation also powers the tap-a-character lookup in sentences.
let WORDS_BY_LENGTH_DESC = [];

function buildWordLengthIndex() {
  WORDS_BY_LENGTH_DESC = DICTIONARY
    .map((w, idx) => ({ h: w.h, idx }))
    .filter(w => w.h && w.h.length > 0)
    .sort((a, b) => b.h.length - a.h.length);
}

// Greedy longest-match segmentation of Chinese text into dictionary words
// (falling back to single, untagged characters for anything not found, e.g.
// grammar particles not in the word list, punctuation, numerals).
function segmentSentenceText(text) {
  const segments = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const w of WORDS_BY_LENGTH_DESC) {
      if (w.h.length <= text.length - i && text.startsWith(w.h, i)) {
        segments.push({ text: w.h, wordIdx: w.idx });
        i += w.h.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      segments.push({ text: text[i], wordIdx: null });
      i++;
    }
  }
  return segments;
}

function tagSentenceWordRequirements() {
  buildWordLengthIndex();
  SENTENCES.forEach(s => {
    const segments = segmentSentenceText(s.zh || '');
    s.reqWords = [...new Set(segments.filter(seg => seg.wordIdx !== null).map(seg => seg.wordIdx))];
  });
}

// The highest dictionary index the learner has actually reached (i.e. every
// word before it has appeared in a lesson up to and including the current
// one), used to gate sentence practice by real progress rather than raw
// HSK level number.
function getUnlockedWordBound() {
  const lessons = getLessons();
  const cur = lessons[Math.min(STATE.currentLesson, lessons.length - 1)];
  return cur ? cur.blockEnd : DICTIONARY.length;
}

function sentencesWithinReach(pool, unlockedBound, maxUnknown) {
  return pool.filter(s => {
    if (!s.reqWords) return true;
    const unknown = s.reqWords.filter(idx => idx >= unlockedBound).length;
    return unknown <= maxUnknown;
  });
}

// Picks sentences for practice, preferring ones built entirely from words the
// learner has already reached. Progressively relaxes how many unfamiliar
// words are tolerated (0, then 1, 2...) until there's enough to practice
// with, so early lessons — where strict filtering would leave almost
// nothing — still get sentences that are as close to their level as
// possible instead of jumping straight to "any sentence at this HSK level".
function getSentencesForProgress(minCount = 5) {
  const lessons = getLessons();
  const curLesson = lessons[Math.min(STATE.currentLesson, lessons.length - 1)];
  const unlockedBound = getUnlockedWordBound();
  const levelCap = curLesson ? curLesson.lvl : 3;
  const basePool = SENTENCES.filter(s => s.l <= levelCap);

  for (let maxUnknown = 0; maxUnknown <= 5; maxUnknown++) {
    const pool = sentencesWithinReach(basePool, unlockedBound, maxUnknown);
    if (pool.length >= minCount) return pool;
  }
  return basePool;
}

function showBootstrapError(error) {
  console.error(error);
  alert('Не удалось загрузить данные приложения. Запустите проект через локальный сервер и попробуйте ещё раз.');
}

let STATE = {};

function loadState() {
  const saved = localStorage.getItem('hsk_state');
  if (!saved) {
    STATE = null;
    return;
  }
  try {
    STATE = JSON.parse(saved);
  } catch (_) {
    STATE = null;
  }
}

function saveState() {
  localStorage.setItem('hsk_state', JSON.stringify(STATE));
}

function getSkipCountForLevel(level) {
  return level === 'hsk2' ? 300 : level === 'hsk1' ? 150 : 0;
}

function initState(level, days) {
  const skipCount = getSkipCountForLevel(level);
  const totalWords = DICTIONARY.length - skipCount;
  const wordsPerDay = Math.max(10, Math.ceil(totalWords / days));
  STATE = {
    level, days, startDate: new Date().toDateString(),
    wordsPerDay, skipCount,
    progress: {},
    streak: 0,
    lastStudyDate: null,
    totalAnswers: 0,
    correctAnswers: 0,
    currentLesson: 0,
  };
  saveState();
}

function normalizeState() {
  if (!STATE || typeof STATE !== 'object') {
    STATE = null;
    return;
  }

  const level = typeof STATE.level === 'string' ? STATE.level : 'beginner';
  const days = Number.isFinite(Number(STATE.days)) ? Math.max(1, parseInt(STATE.days, 10)) : 90;
  const skipCount = getSkipCountForLevel(level);
  const totalWords = Math.max(0, DICTIONARY.length - skipCount);
  const wordsPerDay = Number.isFinite(Number(STATE.wordsPerDay))
    ? Math.max(10, parseInt(STATE.wordsPerDay, 10))
    : Math.max(10, Math.ceil(totalWords / days || 1));

  STATE = {
    level,
    days,
    startDate: STATE.startDate || new Date().toDateString(),
    wordsPerDay,
    skipCount,
    progress: STATE.progress && typeof STATE.progress === 'object' ? STATE.progress : {},
    streak: Number.isFinite(Number(STATE.streak)) ? Number(STATE.streak) : 0,
    lastStudyDate: STATE.lastStudyDate || null,
    totalAnswers: Number.isFinite(Number(STATE.totalAnswers)) ? Number(STATE.totalAnswers) : 0,
    correctAnswers: Number.isFinite(Number(STATE.correctAnswers)) ? Number(STATE.correctAnswers) : 0,
    currentLesson: Number.isFinite(Number(STATE.currentLesson)) ? Math.max(0, Number(STATE.currentLesson)) : 0,
    _streakUpdatedToday: STATE._streakUpdatedToday || null,
    _prevStudy: STATE._prevStudy || null
  };

  const lessonsCount = Math.max(1, Math.ceil(totalWords / STATE.wordsPerDay || 1));
  STATE.currentLesson = Math.min(STATE.currentLesson, Math.max(0, lessonsCount - 1));
  saveState();
}

function getLessons() {
  const wpd = STATE.wordsPerDay;
  const start = STATE.skipCount;
  const end = DICTIONARY.length;
  const lessons = [];
  let i = start;
  let lessonIdx = 0;
  while (i < end) {
    const blockStart = i;
    const blockEnd = Math.min(i + wpd, end);
    const wordIndices = [];
    for (let j = blockStart; j < blockEnd; j++) wordIndices.push(j);

    const lvl = DICTIONARY[blockStart]?.l || 1;

    const masteredInBlock = wordIndices.filter(wi => {
      const p = STATE.progress[wi];
      return p && p.totalRight >= 1;
    }).length;
    const pct = Math.round(masteredInBlock / wordIndices.length * 100);
    const isDone = pct >= 80;
    const isCurrent = lessonIdx === STATE.currentLesson;
    const isLocked = lessonIdx > STATE.currentLesson;

    const hasSentences = lessonIdx >= 2;
    lessons.push({ lessonIdx, blockStart, blockEnd, wordIndices, lvl, isDone, isCurrent, isLocked, pct, hasSentences });
    i = blockEnd;
    lessonIdx++;
  }

  while (
    STATE.currentLesson < lessons.length - 1 &&
    lessons[STATE.currentLesson] &&
    lessons[STATE.currentLesson].isDone
  ) {
    STATE.currentLesson++;
  }

  lessons.forEach((l, idx) => {
    l.isCurrent = idx === STATE.currentLesson;
    l.isLocked  = idx > STATE.currentLesson;
  });
  return lessons;
}

function getLessonTitle(lesson) {
  const lvlNames = {1:'HSK1', 2:'HSK2', 3:'HSK3'};
  return `Урок ${lesson.lessonIdx + 1} · ${lvlNames[lesson.lvl] || 'HSK'}`;
}

function getTodayStr() { return new Date().toDateString(); }
function getPrevDayStr() { const d = new Date(); d.setDate(d.getDate()-1); return d.toDateString(); }

function getWordsForCurrentLesson() {
  const lessons = getLessons();
  const lesson = lessons[STATE.currentLesson] || lessons[lessons.length-1];
  return lesson ? lesson.wordIndices : [];
}

function getWordsDue(indices) {
  const today = getTodayStr();
  return (indices || []).filter(i => {
    const p = STATE.progress[i];
    return p && (p.due <= today || p.interval === 0);
  });
}

function getNewWordsInBlock(indices) {
  return (indices || []).filter(i => !STATE.progress[i]);
}

// Graduated spaced-repetition steps (days). A right answer advances one step,
// a wrong answer softly demotes (never fully back to zero unless already low),
// so a single slip doesn't erase all prior progress on a word.
const SRS_STEPS = [0, 1, 3, 7, 16, 35, 75];

function intervalToStep(interval) {
  for (let i = SRS_STEPS.length - 1; i >= 0; i--) {
    if ((interval || 0) >= SRS_STEPS[i]) return i;
  }
  return 0;
}

function ensureProgressStep(p) {
  if (p.step === undefined || p.step === null || Number.isNaN(p.step)) {
    p.step = intervalToStep(p.interval);
  }
}

function updateStreak() {
  const today = getTodayStr();
  if (STATE._streakUpdatedToday === today) return; // already counted today
  const prevDay = getPrevDayStr();
  if (STATE._lastStreakDate === prevDay) {
    STATE.streak = (STATE.streak || 0) + 1;
  } else if (STATE._lastStreakDate !== today) {
    STATE.streak = 1;
  }
  STATE._lastStreakDate = today;
  STATE._streakUpdatedToday = today;
}

function rateWordSRS(wordIdx, knew) {

  if (!STATE.progress[wordIdx]) {
    STATE.progress[wordIdx] = { step: 0, interval: 0, due: getTodayStr(), totalRight: 0, totalWrong: 0 };
  }
  const p = STATE.progress[wordIdx];
  ensureProgressStep(p);
  STATE.totalAnswers++;
  if (knew) {
    STATE.correctAnswers++;
    p.totalRight++;
    p.step = Math.min(SRS_STEPS.length - 1, p.step + 1);
  } else {
    p.totalWrong++;
    p.step = Math.max(0, p.step - 2);
  }
  p.interval = SRS_STEPS[p.step];
  const due = new Date();
  due.setDate(due.getDate() + (p.interval || 0));
  p.due = due.toDateString();
  STATE.lastStudyDate = getTodayStr();

  updateStreak();

  getLessons();
  saveState();
}

const ETYMOLOGY_TYPE_META = {
  etymology: {label:'Этимология', className:'type-etymology'},
  pictograph: {label:'Пиктограмма', className:'type-pictograph'},
  ideograph: {label:'Идеограмма', className:'type-ideograph'},
  'phono-semantic': {label:'Фоноидеограмма', className:'type-phono-semantic'},
  mnemonic: {label:'Учебная мнемоника', className:'type-mnemonic'},
  fallback: {label:'Разбор в работе', className:'type-fallback'},
};

function inferLegacyEtymologyType(word, entry) {
  if (entry.type) return entry.type;
  const partsCount = Array.isArray(entry.chars) ? entry.chars.length : 0;
  if (word.length === 1 && partsCount <= 1) return 'pictograph';
  if (word.length === 1) return 'ideograph';
  return 'mnemonic';
}

function normalizeEtymologyParts(parts) {
  return Array.isArray(parts) ? parts.map(part => ({
    h: part.h || '',
    p: part.p || '',
    m: part.m || ''
  })) : [];
}

function getDictionaryExamplesForChar(char, limit = 3) {
  return DICTIONARY
    .filter(entry => entry.h.includes(char))
    .sort((a, b) => a.h.length - b.h.length || a.l - b.l)
    .slice(0, limit)
    .map(entry => ({h: entry.h, p: entry.p, m: entry.t}));
}

function buildCharFallbackFromDictionary(char) {
  const standalone = DICTIONARY.find(entry => entry.h === char);
  const examples = getDictionaryExamplesForChar(char, standalone ? 2 : 3);

  if (standalone) {
    return {
      type: 'fallback',
      summary: `Как самостоятельный иероглиф ${char} обычно значит «${standalone.t}».`,
      parts: [
        {h: standalone.h, p: standalone.p, m: standalone.t},
        ...examples.filter(example => example.h !== char)
      ],
      note: 'Это безопасная смысловая справка из словаря. Историческую этимологию можно добавить позже.'
    };
  }

  if (examples.length > 0) {
    return {
      type: 'fallback',
      summary: `Отдельная этимология для ${char} пока не добавлена, но ниже показаны словарные слова, в которых этот иероглиф встречается с проверенным переводом.`,
      parts: examples,
      note: 'Это не догадка о происхождении знака, а корректная смысловая опора по реальным словам из словаря.'
    };
  }

  return {
    type: 'fallback',
    summary: `Для иероглифа ${char} пока нет отдельной записи, но разбор будет добавлен позже.`,
    parts: [{h: char, p: '', m: 'Иероглиф из словаря HSK'}],
    note: 'Пока здесь только заглушка без исторической этимологии.'
  };
}

function mergeEtymologyEntry(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  return {
    ...base,
    ...extra,
    parts: normalizeEtymologyParts(extra.parts || base.parts || [])
  };
}

function buildEtymologyDb(seed) {
  const words = {};
  const chars = {};

  Object.entries(seed).forEach(([word, entry]) => {
    const type = inferLegacyEtymologyType(word, entry);
    const parts = normalizeEtymologyParts(entry.chars);
    const normalized = {
      type,
      summary: entry.summary || entry.memo || '',
      parts,
      note: entry.note || (type === 'mnemonic'
        ? 'Учебная мнемоника: помогает запомнить образ слова, не выдавая её за строгую историческую этимологию.'
        : 'Короткое учебное объяснение происхождения или структуры знака.'),
      chars: Array.from(word)
    };

    words[word] = normalized;

    if (word.length === 1) {
      chars[word] = {
        type: normalized.type,
        summary: normalized.summary,
        parts: normalized.parts,
        note: normalized.note
      };
    }
  });

  Object.entries(seed).forEach(([word, entry]) => {
    normalizeEtymologyParts(entry.chars).forEach(part => {
      if (!part.h || part.h.length !== 1 || chars[part.h]) return;
      chars[part.h] = {
        type: 'fallback',
        summary: `В уже добавленных учебных разборах этот знак связан с образом «${part.m}».`,
        parts: [part],
        note: `Промежуточное объяснение: выведено из слов, где встречается ${part.h}, например ${word}.`
      };
    });
  });

  Object.entries(ETYMOLOGY_OVERRIDES.words).forEach(([word, entry]) => {
    words[word] = mergeEtymologyEntry(words[word], entry);
  });

  Object.entries(ETYMOLOGY_OVERRIDES.chars).forEach(([char, entry]) => {
    chars[char] = mergeEtymologyEntry(chars[char], entry);
  });

  Array.from(new Set(DICTIONARY.flatMap(entry => Array.from(entry.h)))).forEach(char => {
    if (chars[char]) return;
    chars[char] = buildCharFallbackFromDictionary(char);
  });

  return {words, chars};
}

function getWordEtymology(word) {
  return ETYMOLOGY_DB.words[word] || null;
}

function getCharEtymology(char) {
  return ETYMOLOGY_DB.chars[char] || null;
}

function getEtymologyTypeMeta(type) {
  return ETYMOLOGY_TYPE_META[type] || ETYMOLOGY_TYPE_META.fallback;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEtymologyParts(parts) {
  if (!parts || parts.length === 0) return '';
  return `<div class="decomp-chars">${parts.map(part => `
    <div class="decomp-char" onclick="speakWord('${escapeHtml(part.h)}')">
      <div class="decomp-char-h">${escapeHtml(part.h)}</div>
      <div class="decomp-char-p">${escapeHtml(part.p)}</div>
      <div class="decomp-char-m">${escapeHtml(part.m)}</div>
    </div>
  `).join('')}</div>`;
}

function renderEtymologySection(title, entry, extraHtml = '') {
  const meta = getEtymologyTypeMeta(entry.type);
  return `
    <div class="etymology-section">
      <div class="etymology-section-head">
        <div class="decomp-title">${escapeHtml(title)}</div>
        <span class="etymology-type-badge ${meta.className}">${meta.label}</span>
      </div>
      ${entry.summary ? `<div class="etymology-summary">${escapeHtml(entry.summary)}</div>` : ''}
      ${renderEtymologyParts(entry.parts)}
      ${extraHtml}
      ${entry.note ? `<div class="etymology-note">${escapeHtml(entry.note)}</div>` : ''}
    </div>
  `;
}

function renderCharEtymologyCard(char, entry) {
  const meta = getEtymologyTypeMeta(entry.type);
  const leadPart = entry.parts.find(part => part.h === char) || entry.parts[0] || {};
  return `
    <div class="etymology-char-card">
      <div class="etymology-char-top">
        <div class="etymology-char-meta">
          <button class="etymology-char-main" onclick="speakWord('${escapeHtml(char)}')">${escapeHtml(char)}</button>
          <div class="etymology-char-pinyin">${escapeHtml(leadPart.p || '')}</div>
        </div>
        <span class="etymology-type-badge ${meta.className}">${meta.label}</span>
      </div>
      ${entry.summary ? `<div class="etymology-summary compact">${escapeHtml(entry.summary)}</div>` : ''}
      ${renderEtymologyParts(entry.parts)}
      ${entry.note ? `<div class="etymology-note">${escapeHtml(entry.note)}</div>` : ''}
    </div>
  `;
}

function buildEtymologyView(word) {
  const chars = Array.from(word || '');
  const wordEntry = getWordEtymology(word);
  const singleCharEntry = chars.length === 1 ? getCharEtymology(word) : null;
  const primary = chars.length === 1 ? (wordEntry || singleCharEntry) : wordEntry;
  const charEntries = chars
    .filter(char => chars.length > 1)
    .map(char => ({char, entry: getCharEtymology(char)}))
    .filter(item => item.entry);
  const hasContent = Boolean(primary) || charEntries.length > 0;
  const fallback = hasContent ? null : {
    type: 'fallback',
    summary: 'Полное объяснение происхождения этого слова ещё не добавлено.',
    parts: chars.map(char => ({h: char, p: '', m: 'Иероглиф из слова'})),
    note: 'Когда база пополнится, здесь появятся и общий смысл слова, и разбор по иероглифам.'
  };

  return {
    word,
    primary,
    charEntries,
    hasContent,
    isPartial: !wordEntry && charEntries.length > 0 && chars.length > 1,
    fallback
  };
}

function renderEtymologyContent(targetEl, word, options = {}) {
  if (!targetEl) return null;
  const view = buildEtymologyView(word);
  const sections = [];
  const mainTitle = Array.from(word || '').length > 1 ? 'Происхождение слова' : 'Происхождение иероглифа';

  if (view.primary) {
    sections.push(renderEtymologySection(mainTitle, view.primary));
  } else if (view.fallback) {
    sections.push(renderEtymologySection(mainTitle, view.fallback));
  }

  if (view.isPartial) {
    sections.push('<div class="etymology-empty">Полный разбор слова ещё не добавлен, поэтому ниже показаны доступные объяснения по отдельным иероглифам.</div>');
  }

  if (view.charEntries.length > 0) {
    sections.push(`
      <div class="etymology-section">
        <div class="etymology-section-head">
          <div class="decomp-title">Иероглифы внутри слова</div>
        </div>
        <div class="etymology-char-grid">${view.charEntries.map(item => renderCharEtymologyCard(item.char, item.entry)).join('')}</div>
      </div>
    `);
  }

  targetEl.innerHTML = sections.join('');
  targetEl.style.display = 'block';
  if (options.expandedClass) targetEl.classList.add(options.expandedClass);
  return view;
}

// Wraps each recognized dictionary word in a Chinese sentence with a tappable
// span, so a learner can tap any character/word mid-sentence to see its
// meaning without leaving the exercise. Segments that don't match a known
// word (particles, punctuation, numerals) render as plain text.
function buildSentenceCharSpansHtml(text) {
  const segments = segmentSentenceText(text || '');
  return segments.map(seg => {
    const escaped = escapeHtml(seg.text);
    if (seg.wordIdx !== null) {
      return `<span class="sent-char" data-action="explain-char" data-widx="${seg.wordIdx}">${escaped}</span>`;
    }
    // Characters that didn't match a dictionary word (grammar particles like
    // 的/了/吗, numerals, etc.) are still individually tappable if they're
    // real hanzi — etymology coverage now spans every character, not just
    // ones that happen to be standalone dictionary words.
    if (/[\u4e00-\u9fff]/.test(seg.text)) {
      return `<span class="sent-char" data-action="explain-char" data-char="${escaped}">${escaped}</span>`;
    }
    return escaped;
  }).join('');
}

// Best-effort pinyin lookup for a bare character with no dictionary word of
// its own — checked against every place we know a character's own reading:
// as a standalone dictionary word, or wherever it's listed as itself (not a
// sub-component) in the mnemonic data.
let CHAR_PINYIN_MAP = {};
function buildCharPinyinMap() {
  CHAR_PINYIN_MAP = {};
  DICTIONARY.forEach(w => {
    if (w.h.length === 1 && w.p && !CHAR_PINYIN_MAP[w.h]) CHAR_PINYIN_MAP[w.h] = w.p;
  });
  const scanEntries = obj => {
    Object.entries(obj || {}).forEach(([key, entry]) => {
      if (key.length === 1 && entry?.chars?.length === 1 && entry.chars[0]?.h === key && entry.chars[0]?.p) {
        if (!CHAR_PINYIN_MAP[key]) CHAR_PINYIN_MAP[key] = entry.chars[0].p;
      }
      (entry?.chars || entry?.parts || []).forEach(part => {
        if (part?.h?.length === 1 && part.h === key && part.p && !CHAR_PINYIN_MAP[key]) {
          CHAR_PINYIN_MAP[key] = part.p;
        }
      });
    });
  };
  scanEntries(MNEMONICS_DATA?.seed);
  scanEntries(MNEMONICS_DATA?.overrides?.chars);
}

function showCharExplainPopup(wordIdx) {
  const word = DICTIONARY[wordIdx];
  if (!word) return;
  openCharPopupModal(word.h, word.p, word.t);
}

function showCharExplainPopupForChar(char) {
  const pinyinGuess = CHAR_PINYIN_MAP[char] || '';
  openCharPopupModal(char, pinyinGuess, '');
}

function openCharPopupModal(hanzi, pinyin, translation) {
  let modal = document.getElementById('char-popup-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'char-popup-modal';
    modal.className = 'char-popup-backdrop';
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="char-popup-sheet">
      <div class="char-popup-head">
        <div>
          <div class="char-popup-hanzi">${escapeHtml(hanzi)}</div>
          ${pinyin ? `<div class="char-popup-pinyin">${escapeHtml(pinyin)}</div>` : ''}
          ${translation ? `<div class="char-popup-translation">${escapeHtml(translation)}</div>` : ''}
        </div>
        <button class="char-popup-close" data-action="close-char-popup">✕</button>
      </div>
      <button class="speak-btn" data-action="speak-popup-char" data-hanzi="${escapeHtml(hanzi)}" style="margin-bottom:12px;">🔊 Произнести</button>
      <div id="char-popup-etymology"></div>
    </div>
  `;
  renderEtymologyContent(document.getElementById('char-popup-etymology'), hanzi);
}

function getExamStageBanner() {
  if (!sessionMode || !sessionMode.startsWith('exam')) return '';
  if (sessionMode === 'exam_words') return '📝 Экзамен · Этап 1 из 2: Слова';
    if (sessionMode === 'exam_sentences') return '💬 Экзамен · Этап 2 из 2: Предложения';
  return '';
}

function updateExamBanner(screenId) {
  const banner = getExamStageBanner();
  let el = document.getElementById('exam-stage-banner-' + screenId);
  if (!el) {
    el = document.createElement('div');
    el.id = 'exam-stage-banner-' + screenId;
    el.style.cssText = 'text-align:center;font-size:12px;color:var(--accent);letter-spacing:1px;padding:6px 0 0 0;';
    const header = document.querySelector('#' + screenId + ' .card-header') ||
                   document.querySelector('#' + screenId + ' .card-progress') ||
                   document.getElementById(screenId)?.firstElementChild;
    if (header) header.parentNode.insertBefore(el, header.nextSibling);
  }
  el.textContent = banner;
  el.style.display = banner ? 'block' : 'none';
}

function showCurrentCard() {
  if (sessionIdx >= sessionQueue.length) {
    if (continueSessionFlow()) return;
    if (sessionMode === 'all_then_sentences') {
      const lessons = getLessons();
      const curLesson = lessons[STATE.currentLesson] || lessons[lessons.length-1];
      const sents = shuffle(getSentencesForProgress()).slice(0,8);
      document.getElementById('screen-card').classList.remove('active');
      if (sents.length > 0) { launchSentenceSession(sents); return; }
    }
    showSessionDone();
    return;
  }
  updateExamBanner('screen-card');
  answerRevealed = false;
  const aiBtn = document.getElementById('ai-explain-btn');
  const aiBox = document.getElementById('ai-explain-box');
  if (aiBtn) { aiBtn.style.display = 'none'; aiBtn.dataset.revealed = '0'; }
  if (aiBox) { aiBox.style.display = 'none'; aiBox.innerHTML = ''; }
  const wi = sessionQueue[sessionIdx];
  const word = DICTIONARY[wi];
  if (!word) { sessionIdx++; showCurrentCard(); return; }
  const p = STATE.progress[wi];
  const isNew = !p || (p.totalRight === 0 && p.totalWrong === 0);
  const isListening = sessionMode === 'words_listening';
  const isTyping = sessionMode === 'words_typing';
  const isRadical = sessionMode === 'words_radical';

  const mcOptionsEl = document.getElementById('mc-options');
  const typingAreaEl = document.getElementById('typing-input-area');
  if (mcOptionsEl) mcOptionsEl.style.display = isTyping ? 'none' : 'flex';
  if (typingAreaEl) typingAreaEl.style.display = isTyping ? 'flex' : 'none';

  if (isTyping) {
    const typingMode = getTypingMode();
    if (typingMode === 'pinyin') {
      document.getElementById('card-hanzi').textContent = word.h;
      document.getElementById('card-pinyin').textContent = word.t;
      document.getElementById('card-tag').textContent = '⌨️ ПИНЬИНЬ';
    } else {
      document.getElementById('card-hanzi').textContent = '⌨️';
      document.getElementById('card-pinyin').textContent = `${word.p} — ${word.t}`;
      document.getElementById('card-tag').textContent = '⌨️ ИЕРОГЛИФ';
    }
    document.getElementById('card-tag').className = 'flashcard-tag tag-review';
  } else if (isListening) {
    document.getElementById('card-hanzi').textContent = '🎧';
    document.getElementById('card-pinyin').textContent = 'Слушай и выбирай';
    document.getElementById('card-tag').textContent = '🎧 АУДИРОВАНИЕ';
    document.getElementById('card-tag').className = 'flashcard-tag tag-review';
  } else if (isRadical) {
    document.getElementById('card-hanzi').textContent = word.h;
    document.getElementById('card-pinyin').textContent = 'Какой элемент входит в этот иероглиф?';
    document.getElementById('card-tag').textContent = '🧩 РАДИКАЛ';
    document.getElementById('card-tag').className = 'flashcard-tag tag-review';
  } else {
    document.getElementById('card-hanzi').textContent = word.h;
    document.getElementById('card-pinyin').textContent = word.p;
    document.getElementById('card-tag').textContent = isNew ? 'NEW' : 'ПОВТОР';
    document.getElementById('card-tag').className = 'flashcard-tag '+(isNew?'tag-new':'tag-review');
  }

  const decompBtn = document.getElementById('decomp-btn');
  const decompPanel = document.getElementById('decomp-panel');
  decompPanel.style.display = 'none';
  decompPanel.innerHTML = '';
  decompBtn.textContent = '🧩 Разобрать слово';
  decompBtn.style.display = isRadical ? 'none' : 'inline-block';

  if (isTyping) {
    const input = document.getElementById('typing-input');
    if (input) {
      input.value = '';
      input.disabled = false;
      const typingMode = getTypingMode();
      if (typingMode === 'pinyin') {
        input.placeholder = 'Пиньинь латиницей, тона не обязательны';
        input.lang = 'en';
      } else {
        input.placeholder = 'Напиши иероглиф (нужна китайская раскладка)';
        input.lang = 'zh-CN';
      }
    }
    const submitBtn = document.getElementById('typing-submit-btn');
    if (submitBtn) submitBtn.style.display = 'inline-block';
  } else if (isListening) {
    const wrongHanzi = getWrongHanziOptions(wi, 3);
    const correctDisplay = `${word.h}  ${word.p}`;
    const allOptions = shuffle([correctDisplay, ...wrongHanzi]);
    currentCorrectIdx = allOptions.indexOf(correctDisplay);
    for (let i=0;i<4;i++) {
      const btn = document.getElementById('mc'+i);
      btn.textContent = allOptions[i];
      btn.className = 'mc-btn mc-btn-zh' + ((allOptions[i]||'').length > 14 ? ' mc-btn-long' : '');
      btn.disabled = false;
    }
  } else if (isRadical) {
    const radicalData = getRadicalQuizOptions(wi);
    if (!radicalData) { sessionIdx++; showCurrentCard(); return; }
    currentCorrectIdx = radicalData.correctIdx;
    window.__radicalCorrectChar = radicalData.correct;
    for (let i=0;i<4;i++) {
      const btn = document.getElementById('mc'+i);
      btn.textContent = radicalData.options[i];
      btn.className = 'mc-btn mc-btn-zh';
      btn.disabled = false;
    }
  } else {
    const wrongAnswers = getWrongOptions(wi, 3);
    const allOptions = shuffle([word.t, ...wrongAnswers]);
    currentCorrectIdx = allOptions.indexOf(word.t);
    for (let i=0;i<4;i++) {
      const btn = document.getElementById('mc'+i);
      btn.textContent = allOptions[i];
      btn.className = 'mc-btn' + ((allOptions[i]||'').length > 14 ? ' mc-btn-long' : '');
      btn.disabled = false;
    }
  }

  const hint = document.getElementById('result-hint');
  hint.style.display = 'none';
  document.getElementById('next-btn').style.display = 'none';
  document.getElementById('skip-btn').style.display = (isNew && !isListening && !isTyping && !isRadical) ? 'inline-block' : 'none';

  const pct = Math.round(sessionIdx/sessionQueue.length*100);
  document.getElementById('card-progress-fill').style.width = pct+'%';
  document.getElementById('card-progress-text').textContent = `${sessionIdx} / ${sessionQueue.length}`;

  speakWord(word.h);
  if (isTyping) setTimeout(() => document.getElementById('typing-input')?.focus(), 60);
}

function toggleDecomp() {
  const wi = sessionQueue[sessionIdx];
  if (wi === undefined) return;
  const word = DICTIONARY[wi];
  const panel = document.getElementById('decomp-panel');
  const btn = document.getElementById('decomp-btn');
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    btn.textContent = '🧩 Разобрать слово';
    return;
  }
  renderEtymologyContent(panel, word.h);
  btn.textContent = '🧩 Скрыть разбор';
}

let setupLevel = null;
let setupDays = 90;

function selectOption(group, val, el) {

  const btn = el.closest('.option-btn') || el;
  document.querySelectorAll('#level-options .option-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  if (group === 'level') { setupLevel = val; updatePlanInfo(); document.getElementById('btn-start-setup').disabled = false; }
}

function updateDaysSlider(val) {
  setupDays = parseInt(val);
  document.getElementById('days-val').textContent = `${val} дней (~${(val/30).toFixed(1)} мес.)`;
  updatePlanInfo();
}

function updatePlanInfo() {
  const info = document.getElementById('plan-info');
  if (!setupLevel) { info.textContent = 'Выберите уровень, чтобы увидеть план.'; return; }
  const skip = setupLevel === 'hsk2' ? 300 : setupLevel === 'hsk1' ? 150 : 0;
  const total = DICTIONARY.length - skip;
  const wpd = Math.max(10, Math.ceil(total / setupDays));
  const lessons = Math.ceil(total / wpd);
  info.innerHTML = `📚 Слов: <b style="color:var(--accent)">${total}</b> | Уроков: <b style="color:var(--accent)">${lessons}</b><br>📅 Норма: <b style="color:var(--accent)">${wpd} слов/урок</b> | Цель: <b style="color:var(--accent)">${setupDays} дн</b>`;
}

function startSetup() {
  if (!setupLevel) return;
  initState(setupLevel, setupDays);
  showMainScreen();
}

function showMainScreen() {
  ['screen-setup','screen-card','screen-done','screen-sentence'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  lessonPlanShowAllDone = false; // always land back on the collapsed, current-lesson-first view
  document.getElementById('screen-main').classList.add('active');
  showTab('today');
}

function showTab(tab) {
  document.getElementById('tab-today').style.display = tab === 'today' ? 'block' : 'none';
  document.getElementById('tab-stats').style.display = tab === 'stats' ? 'block' : 'none';
  document.getElementById('tab-dict').style.display  = tab === 'dict'  ? 'flex'  : 'none';
  document.querySelectorAll('.nav-btn').forEach((b,i) => b.classList.toggle('active',
    (i===0&&tab==='today')||(i===1&&tab==='dict')||(i===2&&tab==='stats')));
  if (tab === 'today') updateTodayTab();
  if (tab === 'stats') updateStatsTab();
  if (tab === 'dict')  initDictTab();
}

function bindStaticEvents() {
  document.addEventListener('click', unlockAudioOnFirstInteraction, { once: true, capture: true });
  document.addEventListener('touchstart', unlockAudioOnFirstInteraction, { once: true, capture: true, passive: true });

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const { action } = target.dataset;

    if (action === 'select-level') {
      selectOption('level', target.dataset.val, target);
      return;
    }
    if (action === 'start-setup') {
      startSetup();
      return;
    }
    if (action === 'show-tab') {
      showTab(target.dataset.tab);
      return;
    }
    if (action === 'start-session') {
      startSession(target.dataset.mode);
      return;
    }
    if (action === 'reset-data') {
      resetData();
      return;
    }
    if (action === 'open-pace-settings') {
      openPaceSettings();
      return;
    }
    if (action === 'close-pace-settings') {
      document.getElementById('pace-modal')?.remove();
      return;
    }
    if (action === 'save-pace-settings') {
      savePaceSettings();
      return;
    }
    if (action === 'test-voice') {
      speakWord('你好，很高兴认识你。');
      return;
    }
    if (action === 'ai-explain-word') {
      aiExplainWord();
      return;
    }
    if (action === 'ai-explain-sentence') {
      aiExplainSentence();
      return;
    }
    if (action === 'save-gemini-key') {
      saveGeminiKey();
      return;
    }
    if (action === 'change-gemini-key') {
      renderGeminiKeySettings(true);
      return;
    }
    if (action === 'remove-gemini-key') {
      removeGeminiKey();
      showToast('Ключ удалён, кнопка «Объяснить» отключена');
      return;
    }
    if (action === 'test-gemini-key') {
      testGeminiKey();
      return;
    }
    if (action === 'diagnose-audio') {
      diagnoseAudio();
      return;
    }
    if (action === 'set-typing-mode-hanzi') {
      setTypingMode('hanzi');
      renderTypingModeToggle();
      return;
    }
    if (action === 'set-typing-mode-pinyin') {
      setTypingMode('pinyin');
      renderTypingModeToggle();
      return;
    }
    if (action === 'close-char-popup') {
      document.getElementById('char-popup-modal')?.remove();
      return;
    }
    if (action === 'explain-char') {
      const widxRaw = target.dataset.widx;
      if (widxRaw !== undefined) {
        const widx = parseInt(widxRaw, 10);
        if (!Number.isNaN(widx)) showCharExplainPopup(widx);
      } else if (target.dataset.char) {
        showCharExplainPopupForChar(target.dataset.char);
      }
      return;
    }
    if (action === 'speak-popup-char') {
      speakWord(target.dataset.hanzi);
      return;
    }
    if (action === 'submit-typing') {
      submitTypingAnswer();
      return;
    }
    if (action === 'clear-dict-search') {
      clearDictSearch();
      return;
    }
    if (action === 'set-dict-filter') {
      setDictFilter(parseInt(target.dataset.lvl, 10), target);
      return;
    }
    if (action === 'set-dict-sort') {
      setDictSort(target.dataset.sort, target);
      return;
    }
    if (action === 'set-dict-mode') {
      setDictMode(target.dataset.mode);
      return;
    }
    if (action === 'listen-speak') {
      listenSpeak();
      return;
    }
    if (action === 'listen-reveal') {
      listenReveal();
      return;
    }
    if (action === 'listen-prev') {
      listenPrev();
      return;
    }
    if (action === 'listen-next') {
      listenNext();
      return;
    }
    if (action === 'start-listen-session') {
      startListenSession();
      return;
    }
    if (action === 'end-session') {
      endSession();
      return;
    }
    if (action === 'speak-current') {
      speakCurrent();
      return;
    }
    if (action === 'toggle-decomp') {
      toggleDecomp();
      return;
    }
    if (action === 'choose-answer') {
      chooseAnswer(parseInt(target.dataset.index, 10));
      return;
    }
    if (action === 'next-card') {
      nextCard();
      return;
    }
    if (action === 'skip-known') {
      skipKnown();
      return;
    }
    if (action === 'go-home') {
      goHome();
      return;
    }
    if (action === 'speak-sentence-current') {
      speakSentenceCurrent();
      return;
    }
    if (action === 'next-sentence') {
      nextSentence();
      return;
    }
    if (action === 'wo-place-tile') {
      const idx = parseInt(target.dataset.idx, 10);
      if (!Number.isNaN(idx)) woPlaceTile(idx);
      return;
    }
    if (action === 'wo-remove-tile') {
      const pos = parseInt(target.dataset.pos, 10);
      if (!Number.isNaN(pos)) woRemoveTile(pos);
      return;
    }
    if (action === 'next-wordorder') {
      nextWordOrder();
      return;
    }
    if (action === 'speak-wordorder-current') {
      speakWordOrderCurrent();
      return;
    }
    if (action === 'match-tap-tile') {
      const pos = parseInt(target.dataset.pos, 10);
      if (!Number.isNaN(pos)) matchTapTile(pos);
      return;
    }
  });

  const daysSlider = document.getElementById('days-slider');
  if (daysSlider) {
    daysSlider.addEventListener('input', event => updateDaysSlider(event.target.value));
  }

  const dictSearch = document.getElementById('dict-search');
  if (dictSearch) {
    dictSearch.addEventListener('input', () => renderDict());
  }

  bindKeyboardShortcuts();
}

// Keyboard shortcuts remove friction for desktop/keyboard users: 1-4 picks an
// option, Enter/Space moves on, Esc leaves the session. No effect on mobile.
function bindKeyboardShortcuts() {
  document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const cardActive = document.getElementById('screen-card')?.classList.contains('active');
    const sentActive = document.getElementById('screen-sentence')?.classList.contains('active');
    if (!cardActive && !sentActive) return;

    const typingInput = document.getElementById('typing-input');
    if (cardActive && document.activeElement === typingInput) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!answerRevealed) submitTypingAnswer();
        else nextCard();
      }
      return; // let the learner type freely otherwise — don't hijack 1-4/space
    }

    if (cardActive && sessionMode === 'words_typing') {
      if ((event.key === 'Enter' || event.key === ' ') && answerRevealed) {
        event.preventDefault();
        nextCard();
      }
      return;
    }

    if (['1', '2', '3', '4'].includes(event.key)) {
      const idx = parseInt(event.key, 10) - 1;
      if (cardActive && !answerRevealed) chooseAnswer(idx);
      else if (sentActive && !sentAnswerRevealed) document.getElementById('sent-mc' + idx)?.click();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (cardActive && answerRevealed) nextCard();
      else if (sentActive && sentAnswerRevealed) nextSentence();
      return;
    }
    if (event.key === 'Escape') {
      if (cardActive) endSession();
      else if (sentActive) goHome();
    }
  });
}

function scoreChineseVoice(voice) {
  const lang = String(voice?.lang || '').toLowerCase();
  const name = String(voice?.name || '').toLowerCase();
  let score = 0;

  if (lang === 'zh-cn') score += 80;
  else if (lang.startsWith('zh')) score += 60;

  // Cloud/neural voices (Google, and Microsoft's "Online"/"Natural" Edge
  // voices) sound natural with real intonation. These should always win
  // over older offline system voices, which tend to sound flat and robotic.
  if (name.includes('google')) score += 60;
  if (name.includes('online') || name.includes('natural') || name.includes('neural')) score += 50;
  if (name.includes('xiaoxiao') || name.includes('yunxi') || name.includes('yunyang') || name.includes('xiaoyi')) score += 15;
  if (name.includes('ting-ting') || name.includes('tingting') || name.includes('mei-jia')) score += 20; // decent built-in macOS voices

  // Older desktop/SAPI voices ("... Desktop", classic Huihui/Yaoyao without an
  // "Online" cloud counterpart) are the dated, robotic-sounding Windows
  // voices — de-prioritize them below any cloud voice.
  if (name.includes('desktop')) score -= 30;
  if ((name.includes('huihui') || name.includes('yaoyao')) && !name.includes('online')) score -= 15;

  if (voice?.default) score += 5;

  return score;
}

function refreshSpeechVoices() {
  if (!window.speechSynthesis) return;
  speechVoiceList = window.speechSynthesis.getVoices();
  const chineseVoices = speechVoiceList
    .filter(voice => String(voice.lang || '').toLowerCase().startsWith('zh'))
    .sort((left, right) => scoreChineseVoice(right) - scoreChineseVoice(left));

  const savedVoiceName = localStorage.getItem('hsk_voice_name');
  const savedVoice = savedVoiceName ? chineseVoices.find(v => v.name === savedVoiceName) : null;
  preferredChineseVoice = savedVoice || chineseVoices[0] || null;
  renderVoicePicker(chineseVoices);
}

// Lets a learner override the auto-picked voice from Settings — auto-detection
// is a good default but actual voice quality varies a lot by OS/browser, so a
// manual fallback avoids ever being stuck with a robotic-sounding voice.
function renderVoicePicker(chineseVoices) {
  const container = document.getElementById('voice-picker-container');
  if (!container) return;
  if (!chineseVoices || chineseVoices.length <= 1) {
    container.innerHTML = '';
    return;
  }
  const options = chineseVoices.map(v =>
    `<option value="${escapeHtml(v.name)}" ${preferredChineseVoice && v.name === preferredChineseVoice.name ? 'selected' : ''}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`
  ).join('');
  container.innerHTML = `
    <div style="font-size:11px;color:var(--text3);letter-spacing:1px;margin-bottom:8px;">ГОЛОС ОЗВУЧКИ</div>
    <select id="voice-select" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:var(--radius-sm);font-family:inherit;font-size:13px;margin-bottom:8px;">
      ${options}
    </select>
    <button data-action="test-voice" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:12px;">🔊 Проверить звучание</button>
  `;
  document.getElementById('voice-select').addEventListener('change', e => {
    const chosen = chineseVoices.find(v => v.name === e.target.value);
    if (chosen) {
      preferredChineseVoice = chosen;
      localStorage.setItem('hsk_voice_name', chosen.name);
    }
  });
}

function updateTodayTab() {
  const lessons = getLessons();
  const curLesson = lessons[Math.min(STATE.currentLesson, lessons.length-1)];
  if (!curLesson) return;

  const newCount = curLesson.wordIndices.filter(i => !STATE.progress[i]).length;

  const today = getTodayStr();
  const reviewCount = curLesson.wordIndices.filter(i => {
    const p = STATE.progress[i];
    return p && (p.interval === 0 || p.due <= today);
  }).length;
  const mastered = Object.values(STATE.progress).filter(p => p.totalRight >= 1).length;
  const introduced = Object.keys(STATE.progress).length;

  document.getElementById('today-new-count').textContent = newCount;
  document.getElementById('today-review-count').textContent = reviewCount;
  document.getElementById('today-mastered-count').textContent = mastered;
  document.getElementById('wpd-label').textContent = STATE.wordsPerDay;

  const h = new Date().getHours();
  document.getElementById('greeting-text').textContent = h<12?'Доброе утро!':h<17?'Добрый день!':'Добрый вечер!';
  document.getElementById('greeting-sub').textContent = `Урок ${(STATE.currentLesson||0)+1} · Введено ${introduced} слов`;
  document.getElementById('streak-display').textContent = `🔥 ${STATE.streak||0} дней`;

  updateExamCard();
  renderLessonPlan(lessons);
}

function getUnlockedExamCount() {
  return Math.floor((STATE.currentLesson || 0) / 5);
}

function updateExamCard() {
  const btn = document.getElementById('exam-mode-btn');
  const name = document.getElementById('exam-mode-name');
  const desc = document.getElementById('exam-mode-desc');
  if (!btn || !name || !desc) return;
  const exams = getUnlockedExamCount();
  if (exams <= 0) {
    name.textContent = 'Контрольный экзамен';
    desc.textContent = 'Откроется после 5 завершённых уроков';
    btn.style.opacity = '0.65';
    return;
  }
  name.textContent = `Экзамен ${exams}`;
  desc.textContent = 'Смешанная проверка: слова и предложения';
  btn.style.opacity = '1';
}

let lessonPlanShowAllDone = false;

function renderLessonPlan(lessons) {
  const container = document.getElementById('lesson-plan-list');
  container.innerHTML = '';

  const currentIdx = lessons.findIndex(l => l.isCurrent);
  const anchorIdx = currentIdx === -1 ? 0 : currentIdx;

  // Center the list on "where you are" — a couple of finished lessons for
  // context, the current one, and a few upcoming ones — instead of always
  // starting from lesson 1, which meant scrolling past every completed
  // lesson just to find today's after each session.
  const RECENT_DONE = 2;
  const UPCOMING = 4;
  const startIdx = lessonPlanShowAllDone ? 0 : Math.max(0, anchorIdx - RECENT_DONE);
  const endIdx = Math.min(lessons.length, anchorIdx + UPCOMING + 1);

  if (!lessonPlanShowAllDone && startIdx > 0) {
    const toggle = document.createElement('button');
    toggle.className = 'lesson-toggle-hidden';
    toggle.textContent = `▲ Показать пройденные уроки (${startIdx})`;
    toggle.onclick = () => { lessonPlanShowAllDone = true; renderLessonPlan(getLessons()); };
    container.appendChild(toggle);
  }

  for (let i = startIdx; i < endIdx; i++) {
    const l = lessons[i];
    const statusClass = l.isDone ? 'done' : l.isCurrent ? 'current' : 'locked';
    const numClass = l.isDone ? 'done' : l.isCurrent ? 'current' : 'locked';
    const badge = l.isDone ? '<span class="lesson-badge badge-done">✓ ГОТОВО</span>'
      : l.isCurrent ? '<span class="lesson-badge badge-current">▶ ТЕКУЩИЙ</span>'
      : '<span class="lesson-badge badge-locked">🔒</span>';
    const words = DICTIONARY[l.blockStart] ? `${DICTIONARY[l.blockStart].h}…${DICTIONARY[l.blockEnd-1]?.h||''}` : '';
    const sentMark = l.hasSentences ? ' · 💬' : '';
    const div = document.createElement('div');
    div.className = `lesson-item ${statusClass}`;
    div.innerHTML = `
      <div class="lesson-num ${numClass}">${i+1}</div>
      <div class="lesson-body">
        <div class="lesson-title">${getLessonTitle(l)}</div>
        <div class="lesson-sub">${l.wordIndices.length} слов · ${l.pct}% усвоено${sentMark} · ${words}</div>
      </div>
      ${badge}
    `;
    if (!l.isLocked) div.onclick = () => startLessonSession(l);
    if (l.isCurrent) div.id = 'lesson-item-current';
    container.appendChild(div);
  }
  if (endIdx < lessons.length) {
    const more = document.createElement('div');
    more.style.cssText = 'text-align:center;color:var(--text3);font-size:12px;padding:8px';
    more.textContent = `+ ещё ${lessons.length - endIdx} уроков`;
    container.appendChild(more);
  }
  if (lessonPlanShowAllDone) {
    const collapse = document.createElement('button');
    collapse.className = 'lesson-toggle-hidden';
    collapse.textContent = '▼ Свернуть пройденные уроки';
    collapse.onclick = () => { lessonPlanShowAllDone = false; renderLessonPlan(getLessons()); };
    container.insertBefore(collapse, container.firstChild);
  }
}

function updateStatsTab() {
  const allProg = Object.keys(STATE.progress).map(k => ({idx:parseInt(k),...STATE.progress[k]}));
  const mastered = allProg.filter(p => p.interval >= 16).length;
  const accuracy = STATE.totalAnswers > 0 ? Math.round(STATE.correctAnswers/STATE.totalAnswers*100) : 0;
  document.getElementById('stat-total').textContent = allProg.length;
  document.getElementById('stat-mastered').textContent = mastered;
  document.getElementById('stat-streak').textContent = STATE.streak||0;
  document.getElementById('stat-accuracy').textContent = accuracy+'%';
  const hsk1c=allProg.filter(p=>DICTIONARY[p.idx]?.l===1).length;
  const hsk2c=allProg.filter(p=>DICTIONARY[p.idx]?.l===2).length;
  const hsk3c=allProg.filter(p=>DICTIONARY[p.idx]?.l===3).length;
  const hsk1t=DICTIONARY.filter(w=>w.l===1).length;
  const hsk2t=DICTIONARY.filter(w=>w.l===2).length;
  const hsk3t=DICTIONARY.filter(w=>w.l===3).length;
  document.getElementById('hsk1-frac').textContent=`${hsk1c}/${hsk1t}`;
  document.getElementById('hsk2-frac').textContent=`${hsk2c}/${hsk2t}`;
  document.getElementById('hsk3-frac').textContent=`${hsk3c}/${hsk3t}`;
  document.getElementById('hsk1-bar').style.width=Math.round(hsk1c/hsk1t*100)+'%';
  document.getElementById('hsk2-bar').style.width=Math.round(hsk2c/hsk2t*100)+'%';
  document.getElementById('hsk3-bar').style.width=Math.round(hsk3c/hsk3t*100)+'%';
}

let sessionQueue = [];
let sentenceQueue = [];
let sentenceIdx = 0;
let sentKnow = 0;
let sentDontKnow = 0;
let sentAnswerRevealed = false;
let currentSentDir = 'zh2ru';
let sessionIdx = 0;
let sessionKnow = 0;
let sessionDontKnow = 0;
let sessionMode = 'words';
let currentCorrectIdx = -1;
let answerRevealed = false;
let sessionFlow = null;
let sessionCombo = 0;

function startLessonSession(lesson) {

  const notIntroduced = lesson.wordIndices.filter(i => !STATE.progress[i]);
  const batch = notIntroduced.slice(0, STATE.wordsPerDay);
  const introduced = lesson.wordIndices.filter(i => STATE.progress[i]);
  const due = introduced.filter(i => {
    const p = STATE.progress[i];
    return p.interval === 0 || p.due <= getTodayStr();
  });
  const queue = shuffle([...new Set([...batch, ...due])]);
  if (queue.length === 0) {
    showToast('Все слова урока изучены! 🎉');
    return;
  }
  launchWordSession(queue, 'words');
}

function startSession(mode) {
  const lessons = getLessons();
  sessionFlow = null;

  if (STATE.currentLesson >= lessons.length) STATE.currentLesson = lessons.length - 1;
  const curLesson = lessons[STATE.currentLesson];
  if (!curLesson) { showToast('Все уроки завершены! Вы прошли весь курс 🏆'); return; }

  if (mode === 'words_new') {

    const notIntroduced = curLesson.wordIndices.filter(i => !STATE.progress[i]);
    if (notIntroduced.length === 0) {

      const unlearned = curLesson.wordIndices.filter(i => {
        const p = STATE.progress[i];
        return p && p.totalRight === 0;
      });
      if (unlearned.length > 0) {
        showToast('Новых слов нет. Запускаю повторение невыученных...');
        setTimeout(() => launchWordSession(shuffle(unlearned), 'words'), 800);
      } else {
        showToast('Все слова урока изучены! 🎉 Переходите к следующему уроку.');
      }
      return;
    }

    const batch = notIntroduced.slice(0, STATE.wordsPerDay);
    launchWordSession(shuffle(batch), 'words');

  } else if (mode === 'words_listening') {

    const learned = Object.keys(STATE.progress).map(Number)
      .filter(i => DICTIONARY[i] && i < curLesson.blockEnd);
    if (learned.length < 4) {
      showToast('Выучите хотя бы несколько слов, чтобы включить аудирование.');
      return;
    }
    launchWordSession(shuffle(learned).slice(0, 15), 'words_listening');

  } else if (mode === 'words_typing') {

    const learnedForTyping = Object.keys(STATE.progress).map(Number)
      .filter(i => DICTIONARY[i] && i < curLesson.blockEnd);
    if (learnedForTyping.length < 4) {
      showToast('Выучите хотя бы несколько слов, чтобы включить написание иероглифов.');
      return;
    }
    launchWordSession(shuffle(learnedForTyping).slice(0, 15), 'words_typing');

  } else if (mode === 'words_radical') {

    const learnedIdx = Object.keys(STATE.progress).map(Number)
      .filter(i => DICTIONARY[i] && i < curLesson.blockEnd);
    const radicalPool = getRadicalQuizPool().filter(i => learnedIdx.includes(i));
    const pool = radicalPool.length >= 4 ? radicalPool : getRadicalQuizPool();
    if (pool.length < 4) {
      showToast('Пока недостаточно слов с разбором на компоненты для этой викторины.');
      return;
    }
    launchWordSession(shuffle(pool).slice(0, 15), 'words_radical');

  } else if (mode === 'wordorder') {

    const woSents = getSentencesForProgress();
    if (woSents.length === 0) { showToast('Пройдите хотя бы один урок для разблокировки предложений!'); return; }
    const withTiles = woSents.filter(s => getWordOrderTiles(s));
    if (withTiles.length < 3) { showToast('Пока маловато предложений для этого упражнения — пройдите ещё уроков.'); return; }
    launchWordOrderSession(shuffle([...withTiles]).slice(0, 8));

  } else if (mode === 'match') {

    const learnedForMatch = Object.keys(STATE.progress).map(Number)
      .filter(i => DICTIONARY[i] && i < curLesson.blockEnd);
    if (learnedForMatch.length < 6) {
      showToast('Выучите хотя бы 6 слов, чтобы играть в совпадения.');
      return;
    }
    launchMatchSession(shuffle(learnedForMatch).slice(0, 8));

  } else if (mode === 'words_review') {

    const introduced = curLesson.wordIndices.filter(i => STATE.progress[i]);
    if (introduced.length === 0) {
      showToast('Сначала изучите новые слова!');
      return;
    }

    const due = introduced.filter(i => {
      const p = STATE.progress[i];
      return p.interval === 0 || p.due <= getTodayStr();
    });
    const queue = due.length > 0 ? shuffle(due) : shuffle(introduced);
    launchWordSession(queue, 'words');

  } else if (mode === 'words_hard') {
    const hard = Object.keys(STATE.progress)
      .map(Number)
      .filter(i => { const p=STATE.progress[i]; return p && p.totalWrong > p.totalRight; });
    if (hard.length === 0) { showToast('Сложных слов нет — отличная работа! 🎉'); return; }
    launchWordSession(shuffle(hard), 'words');

  } else if (mode === 'sentences') {
    const sents = getSentencesForProgress();
    if (sents.length === 0) { showToast('Пройдите хотя бы один урок для разблокировки предложений!'); return; }
    launchSentenceSession(shuffle([...sents]));

  } else if (mode === 'exam') {
    const examNumber = getUnlockedExamCount();
    if (examNumber <= 0) {
      showToast('Первый экзамен откроется после 5 завершённых уроков.');
      return;
    }
    const examEndLesson = Math.min(examNumber * 5, lessons.length);
    const examStartLesson = Math.max(0, examEndLesson - 5);
    const examLessons = lessons.slice(examStartLesson, examEndLesson);
    const examWordPool = [...new Set(examLessons.flatMap(lesson => lesson.wordIndices))];
    const introducedPool = examWordPool.filter(i => STATE.progress[i]);
    const sourcePool = introducedPool.length >= 6 ? introducedPool : examWordPool;
    const examLevel = Math.max(...examLessons.map(lesson => lesson.lvl || 1), 1);

    const wordQueue = shuffle(sourcePool).slice(0, Math.min(10, sourcePool.length));
    const examUnlockedBound = Math.max(...examLessons.map(lesson => lesson.blockEnd), 1);
    const examBasePool = SENTENCES.filter(s => s.l <= examLevel);
    let examSentPool = examBasePool;
    for (let maxUnknown = 0; maxUnknown <= 5; maxUnknown++) {
      const pool = sentencesWithinReach(examBasePool, examUnlockedBound, maxUnknown);
      if (pool.length >= 5) { examSentPool = pool; break; }
    }
    const sentenceQueueForExam = shuffle(examSentPool).slice(0, 5);

    if (wordQueue.length === 0) {
      showToast('Для экзамена пока не хватает материала. Пройдите ещё немного дальше.');
      return;
    }

    sessionFlow = [];
    if (sentenceQueueForExam.length > 0) {
      sessionFlow.push({type:'sentences', queue:sentenceQueueForExam});
    }
    launchWordSession(wordQueue, 'exam_words');

  } else if (mode === 'all') {

    const notIntroduced = curLesson.wordIndices.filter(i => !STATE.progress[i]);
    const batch = notIntroduced.slice(0, STATE.wordsPerDay);
    const introduced = curLesson.wordIndices.filter(i => STATE.progress[i]);
    const due = introduced.filter(i => {
      const p = STATE.progress[i];
      return p.interval === 0 || p.due <= getTodayStr();
    });
    const allW = shuffle([...new Set([...batch, ...due])]);
    if (allW.length === 0) {
      showToast('Нет карточек! Все слова урока изучены. Молодец! 🏆');
      return;
    }
    launchWordSession(allW, 'all_then_sentences');
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

function launchWordSession(queue, mode) {
  if (queue.length === 0) { showToast('Нет карточек для этого режима.'); return; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  sessionQueue = queue;
  sessionIdx = 0;
  sessionKnow = 0;
  sessionDontKnow = 0;
  sessionMode = mode;
  answerRevealed = false;
  sessionCombo = 0;
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-card').classList.add('active');
  showCurrentCard();
}

function launchSentenceSession(sents, options = {}) {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  sentenceQueue = sents.slice(0, 10);
  sentenceIdx = 0;
  if (!options.preserveStats) {
    sentKnow = 0;
    sentDontKnow = 0;
  }
  sessionMode = options.modeLabel || 'sentences';
  document.getElementById('screen-main').classList.remove('active');
  const sc = document.getElementById('screen-sentence');
  if (sc) sc.classList.add('active');
  showCurrentSentence();
}

function getWrongOptions(correctWordIdx, count) {
  const correct = DICTIONARY[correctWordIdx];
  const seen = new Set([correct.t]);
  const sameLevel = [];
  const otherLevel = [];
  for (let i = 0; i < DICTIONARY.length; i++) {
    if (i === correctWordIdx) continue;
    const w = DICTIONARY[i];
    if (seen.has(w.t)) continue; // avoid two options with an identical translation
    seen.add(w.t);
    (w.l === correct.l ? sameLevel : otherLevel).push(w.t);
  }
  // Prefer distractors from the same HSK level so the quiz stays meaningfully
  // challenging instead of always pairing a hard word with three trivial ones.
  const picked = shuffle(sameLevel).slice(0, count);
  if (picked.length < count) picked.push(...shuffle(otherLevel).slice(0, count - picked.length));
  return picked;
}

let cardAutoAdvanceTimer = null;
let sentAutoAdvanceTimer = null;

function chooseAnswer(idx) {
  if (answerRevealed) return;
  answerRevealed = true;
  window.__lastCardChoice = idx;
  const wi = sessionQueue[sessionIdx];
  const word = DICTIONARY[wi];
  const knew = (idx === currentCorrectIdx);
  const isListening = sessionMode === 'words_listening';
  const isRadical = sessionMode === 'words_radical';

  for (let i=0;i<4;i++) {
    const btn = document.getElementById('mc'+i);
    btn.disabled = true;
    if (i === currentCorrectIdx) btn.classList.add('correct');
    else if (i === idx && !knew) btn.classList.add('wrong');
  }

  if (isListening) {
    document.getElementById('card-hanzi').textContent = word.h;
    document.getElementById('card-pinyin').textContent = word.p;
  }

  const hint = document.getElementById('result-hint');
  if (knew) {
    sessionCombo++;
    sessionKnow++;
    const comboSuffix = sessionCombo >= 3 ? ` 🔥 Серия: ${sessionCombo}` : '';
    hint.textContent = isListening ? `✓ Верно! ${word.t}${comboSuffix}` : `✓ Верно!${comboSuffix}`;
    hint.className = 'result-hint ok';
  } else {
    sessionCombo = 0;
    sessionDontKnow++;
    hint.textContent = isListening ? `✗ Это было: ${word.h} (${word.p}) — ${word.t}` : `✗ Правильно: ${word.t}`;
    hint.className = 'result-hint fail';
  }
  if (isRadical) {
    const seedEntry = MNEMONICS_DATA.seed[word.h];
    const memo = seedEntry?.memo || '';
    hint.textContent = (knew ? '✓ Верно! ' : `✗ Правильно: ${window.__radicalCorrectChar}. `) + memo;
    hint.className = knew ? 'result-hint ok' : 'result-hint fail';
  }
  hint.style.display = 'block';
  document.getElementById('skip-btn').style.display = 'none';

  const aiBtn = document.getElementById('ai-explain-btn');
  if (aiBtn) {
    aiBtn.dataset.revealed = '1';
    aiBtn.style.display = isAiExplainEnabled() ? 'inline-block' : 'none';
  }

  rateWordSRS(wi, knew);
  document.getElementById('next-btn').style.display = 'block';
  if (knew) cardAutoAdvanceTimer = setTimeout(() => { if (answerRevealed) nextCard(); }, 700);
}

// Learners who can type Chinese via their own IME want the exercise to test
// hanzi recall, not romanization — this compares the typed answer directly
// against the character(s), trimming incidental whitespace an IME might add.
function normalizeHanziAnswer(str) {
  return String(str || '').replace(/[\s\u3000]+/g, '').trim();
}

// For learners who'd rather type pinyin with a normal keyboard: strips tone
// marks/diacritics, digits and punctuation so "ni hao", "nǐ hǎo" or
// "ni3 hao3" all count the same — tones are shown in the reveal afterwards.
function normalizePinyinAnswer(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

function containsLatinLetters(str) {
  return /[a-zA-Z]/.test(String(str || ''));
}

// Settings toggle: 'hanzi' (default — write the character via IME) or
// 'pinyin' (type the romanization, tone-insensitive) for learners who don't
// have a Chinese keyboard set up.
function getTypingMode() {
  const v = localStorage.getItem('hsk_typing_mode');
  return v === 'pinyin' ? 'pinyin' : 'hanzi';
}

function setTypingMode(mode) {
  localStorage.setItem('hsk_typing_mode', mode === 'pinyin' ? 'pinyin' : 'hanzi');
}

function submitTypingAnswer() {
  if (answerRevealed) return;
  const wi = sessionQueue[sessionIdx];
  const word = DICTIONARY[wi];
  if (!word) return;
  answerRevealed = true;
  window.__lastCardChoice = null;
  const mode = getTypingMode();

  const input = document.getElementById('typing-input');
  const userVal = input ? input.value : '';
  window.__lastTypedAnswer = userVal;

  let knew, correctDisplay;
  if (mode === 'pinyin') {
    const normUser = normalizePinyinAnswer(userVal);
    knew = normUser.length > 0 && normUser === normalizePinyinAnswer(word.p);
    correctDisplay = word.p;
  } else {
    knew = normalizeHanziAnswer(userVal).length > 0 && normalizeHanziAnswer(userVal) === normalizeHanziAnswer(word.h);
    correctDisplay = word.h;
  }

  if (input) input.disabled = true;
  document.getElementById('card-hanzi').textContent = word.h;
  if (mode === 'pinyin') document.getElementById('card-pinyin').textContent = word.p;

  const hint = document.getElementById('result-hint');
  if (knew) {
    sessionCombo++;
    sessionKnow++;
    hint.textContent = sessionCombo >= 3 ? `✓ Верно! 🔥 Серия: ${sessionCombo}` : '✓ Верно!';
    hint.className = 'result-hint ok';
  } else {
    sessionCombo = 0;
    sessionDontKnow++;
    if (mode === 'hanzi' && userVal && containsLatinLetters(userVal) && !/[\u4e00-\u9fff]/.test(userVal)) {
      // Latin letters with no hanzi at all almost always means the Chinese
      // input method (IME) wasn't switched on — the pinyin was typed but
      // never converted to characters. Say so plainly instead of "wrong".
      hint.textContent = `✗ Похоже, китайская раскладка (IME) не включена — введена латиница вместо иероглифа. Правильно: ${correctDisplay}`;
    } else if (mode === 'pinyin' && /[\u4e00-\u9fff]/.test(userVal)) {
      hint.textContent = `✗ В поле попал иероглиф вместо пиньиня — похоже, включена китайская раскладка. Правильно: ${correctDisplay}`;
    } else {
      hint.textContent = userVal ? `✗ Правильно: ${correctDisplay}` : `Пропущено. Правильно: ${correctDisplay}`;
    }
    hint.className = 'result-hint fail';
  }
  hint.style.display = 'block';

  const aiBtn = document.getElementById('ai-explain-btn');
  if (aiBtn) {
    aiBtn.dataset.revealed = '1';
    aiBtn.style.display = isAiExplainEnabled() ? 'inline-block' : 'none';
  }

  rateWordSRS(wi, knew);
  const submitBtn = document.getElementById('typing-submit-btn');
  if (submitBtn) submitBtn.style.display = 'none';
  document.getElementById('next-btn').style.display = 'block';
  if (knew) cardAutoAdvanceTimer = setTimeout(() => { if (answerRevealed) nextCard(); }, 700);
}

function getWrongHanziOptions(correctWordIdx, count) {
  const correct = DICTIONARY[correctWordIdx];
  const seen = new Set([correct.h]);
  const sameLevel = [];
  const otherLevel = [];
  for (let i = 0; i < DICTIONARY.length; i++) {
    if (i === correctWordIdx) continue;
    const w = DICTIONARY[i];
    if (seen.has(w.h)) continue;
    seen.add(w.h);
    const display = `${w.h}  ${w.p}`;
    (w.l === correct.l ? sameLevel : otherLevel).push(display);
  }
  const picked = shuffle(sameLevel).slice(0, count);
  if (picked.length < count) picked.push(...shuffle(otherLevel).slice(0, count - picked.length));
  return picked;
}

// Pool for the "radical/component" quiz: single characters that have a real,
// authored component breakdown (not just a pictographic/atomic entry with no
// sub-parts) — asking "which part is inside this character" only makes
// sense when there's a genuine answer.
function getRadicalQuizPool() {
  return DICTIONARY
    .map((w, idx) => idx)
    .filter(idx => {
      const w = DICTIONARY[idx];
      if (w.h.length !== 1) return false;
      const seedEntry = MNEMONICS_DATA?.seed?.[w.h];
      return !!(seedEntry && Array.isArray(seedEntry.chars) && seedEntry.chars.length >= 1);
    });
}

function getRadicalQuizOptions(wordIdx) {
  const w = DICTIONARY[wordIdx];
  const seedEntry = MNEMONICS_DATA.seed[w.h];
  const realParts = [...new Set(seedEntry.chars.map(p => p.h).filter(h => h && h !== w.h))];
  if (realParts.length === 0) return null;
  const correct = shuffle([...realParts])[0];

  const allOtherParts = new Set();
  Object.entries(MNEMONICS_DATA.seed).forEach(([key, entry]) => {
    if (key === w.h) return;
    (entry.chars || []).forEach(p => {
      if (p.h && p.h !== w.h && !realParts.includes(p.h)) allOtherParts.add(p.h);
    });
  });
  const distractors = shuffle([...allOtherParts]).slice(0, 3);
  if (distractors.length < 3) return null;

  const options = shuffle([correct, ...distractors]);
  return { options, correctIdx: options.indexOf(correct), correct };
}


function nextCard() {
  if (cardAutoAdvanceTimer) { clearTimeout(cardAutoAdvanceTimer); cardAutoAdvanceTimer = null; }
  const card = document.querySelector('#screen-card .flashcard');
  if (card) {
    card.classList.add('card-out');
    setTimeout(() => {
      sessionIdx++;
      showCurrentCard();
      requestAnimationFrame(() => card.classList.remove('card-out'));
    }, 130);
  } else {
    sessionIdx++;
    showCurrentCard();
  }
}

function skipKnown() {
  const wi = sessionQueue[sessionIdx];
  if (!STATE.progress[wi]) STATE.progress[wi]={step:0,interval:0,due:getTodayStr(),totalRight:0,totalWrong:0};
  const p = STATE.progress[wi];
  ensureProgressStep(p);
  p.step = Math.max(p.step, 3); // treat as already-known: jump to the 7-day step
  p.interval = SRS_STEPS[p.step];
  const due=new Date(); due.setDate(due.getDate()+p.interval); p.due=due.toDateString();
  p.totalRight++;
  STATE.totalAnswers++; STATE.correctAnswers++;
  STATE.lastStudyDate = getTodayStr();
  updateStreak();
  saveState();
  sessionKnow++;
  sessionIdx++;
  showCurrentCard();
}

function endSession() {
  sessionFlow = null;
  showMainScreen();
}

function continueSessionFlow() {
  if (!sessionFlow || sessionFlow.length === 0) return false;
  const nextStage = sessionFlow.shift();
  if (!nextStage) return false;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  ['screen-card','screen-sentence'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  if (nextStage.type === 'sentences') {
    sentKnow = sessionKnow;
    sentDontKnow = sessionDontKnow;
    launchSentenceSession(nextStage.queue, {preserveStats:true, modeLabel:'exam_sentences'});
    return true;
  }
  return false;
}

function showSessionDone() {
  document.getElementById('screen-card').classList.remove('active');
  document.getElementById('screen-done').classList.add('active');
  const total = sessionKnow + sessionDontKnow;
  const pct = total>0 ? Math.round(sessionKnow/total*100) : 0;
  document.getElementById('done-know').textContent = sessionKnow;
  document.getElementById('done-dontknow').textContent = sessionDontKnow;
  document.getElementById('done-total-sess').textContent = total;
  document.getElementById('done-emoji').textContent = pct>=80?'🏆':pct>=50?'💪':'📚';
  document.getElementById('done-title').textContent = pct>=80?'Отличный результат!':pct>=50?'Хороший прогресс!':'Продолжайте практиковаться!';
  document.getElementById('done-msg').textContent = `Точность: ${pct}%. Слов: ${total}.`;
  sessionFlow = null;
}

// Distractor Chinese sentences for the reverse (translation -> hanzi) question
// direction. Pulled dynamically from the same-level sentence pool so no extra
// authoring is needed.
function getSentenceZhDistractors(correct, level, count) {
  const pool = SENTENCES.filter(s => s.zh !== correct.zh && s.l === level);
  let picked = shuffle(pool).slice(0, count).map(s => s.zh);
  if (picked.length < count) {
    const fallback = SENTENCES.filter(s => s.zh !== correct.zh && !picked.includes(s.zh));
    picked = picked.concat(shuffle(fallback).slice(0, count - picked.length).map(s => s.zh));
  }
  return picked;
}

// Picks one word actually present in the sentence to blank out, and builds
// the blanked-out HTML plus plausible wrong-word options — training
// vocabulary recall *in context* rather than in isolation.
function getClozeData(s) {
  if (!s.reqWords || s.reqWords.length === 0) return null;
  const segments = segmentSentenceText(s.zh);
  const candidates = s.reqWords.filter(idx => DICTIONARY[idx] && DICTIONARY[idx].h.length >= 1);
  if (candidates.length === 0) return null;
  const blankIdx = shuffle([...candidates])[0];
  const blankWord = DICTIONARY[blankIdx];

  let blanked = false;
  const html = segments.map(seg => {
    if (!blanked && seg.wordIdx === blankIdx) {
      blanked = true;
      return `<span class="cloze-blank">${'＿'.repeat(seg.text.length)}</span>`;
    }
    return escapeHtml(seg.text);
  }).join('');
  if (!blanked) return null;

  const wrongHanzi = getWrongHanziOptions(blankIdx, 3).map(display => display.split(/\s+/)[0]);
  return { html, correct: blankWord.h, distractors: wrongHanzi, blankIdx };
}

function showCurrentSentence() {
  updateExamBanner('screen-sentence');
  if (sentenceIdx >= sentenceQueue.length) {
    if (sessionFlow && sessionFlow.length > 0 && continueSessionFlow()) return;
    showSentenceDone();
    return;
  }
  sentAnswerRevealed = false;
  const sentAiBtn = document.getElementById('sent-ai-explain-btn');
  const sentAiBox = document.getElementById('sent-ai-explain-box');
  if (sentAiBtn) { sentAiBtn.style.display = 'none'; sentAiBtn.dataset.revealed = '0'; }
  if (sentAiBox) { sentAiBox.style.display = 'none'; sentAiBox.innerHTML = ''; }
  const s = sentenceQueue[sentenceIdx];

  const promptEl = document.getElementById('sent-zh');
  const pyEl = document.getElementById('sent-py');
  const speakBtn = document.querySelector('#screen-sentence .speak-btn');
  const instrEl = document.getElementById('sent-instruction');

  // Alternate the question type so the exercise trains recognition (read
  // Chinese, pick the meaning), production (read the meaning, find the
  // matching Chinese sentence), and vocabulary-in-context (fill the blank)
  // instead of always testing the same skill.
  const zhDistractors = getSentenceZhDistractors(s, s.l, 3);
  const clozeData = getClozeData(s);
  const roll = Math.random();
  if (clozeData && roll < 0.34) currentSentDir = 'cloze';
  else if (zhDistractors.length === 3 && roll < 0.67) currentSentDir = 'ru2zh';
  else currentSentDir = 'zh2ru';

  let opts, correctText;
  if (currentSentDir === 'cloze') {
    promptEl.className = 'sentence-zh';
    promptEl.innerHTML = clozeData.html;
    pyEl.style.display = 'block';
    pyEl.textContent = s.py;
    if (speakBtn) speakBtn.style.display = 'inline-block';
    if (instrEl) instrEl.textContent = 'КАКОЕ СЛОВО ПРОПУЩЕНО?';
    opts = shuffle([clozeData.correct, ...clozeData.distractors]);
    correctText = clozeData.correct;
  } else if (currentSentDir === 'zh2ru') {
    promptEl.className = 'sentence-zh';
    promptEl.innerHTML = buildSentenceCharSpansHtml(s.zh);
    pyEl.style.display = 'block';
    pyEl.textContent = s.py;
    if (speakBtn) speakBtn.style.display = 'inline-block';
    if (instrEl) instrEl.textContent = 'ВЫБЕРИТЕ ПЕРЕВОД';
    opts = shuffle([...s.opts]);
    correctText = s.t;
  } else {
    promptEl.className = 'sentence-zh sentence-prompt-ru';
    promptEl.textContent = s.t;
    pyEl.style.display = 'none';
    pyEl.textContent = '';
    if (speakBtn) speakBtn.style.display = 'none';
    if (instrEl) instrEl.textContent = 'ВЫБЕРИТЕ ПРЕДЛОЖЕНИЕ НА КИТАЙСКОМ';
    opts = shuffle([s.zh, ...zhDistractors]);
    correctText = s.zh;
  }

  const correctOptIdx = opts.indexOf(correctText);
  for (let i=0;i<4;i++) {
    const btn = document.getElementById('sent-mc'+i);
    btn.textContent = opts[i]||'';
    btn.className = 'mc-btn' + (currentSentDir === 'ru2zh' || currentSentDir === 'cloze' ? ' mc-btn-zh' : '') + ((opts[i]||'').length > 14 ? ' mc-btn-long' : '');
    btn.disabled = false;
    btn.onclick = () => chooseSentAnswer(i, correctOptIdx, correctText, s);
  }

  const hint = document.getElementById('sent-hint');
  hint.style.display='none';
  document.getElementById('sent-next-btn').style.display='none';

  const pct = Math.round(sentenceIdx/sentenceQueue.length*100);
  document.getElementById('sent-progress-fill').style.width=pct+'%';
  document.getElementById('sent-progress-text').textContent=`${sentenceIdx} / ${sentenceQueue.length}`;

  if (currentSentDir === 'zh2ru' || currentSentDir === 'cloze') speakWord(s.zh);
}

function chooseSentAnswer(idx, correctIdx, correctText, s) {
  if (sentAnswerRevealed) return;
  sentAnswerRevealed = true;
  window.__lastSentChoice = idx;
  const knew = idx === correctIdx;
  for (let i=0;i<4;i++) {
    const btn=document.getElementById('sent-mc'+i);
    btn.disabled=true;
    if(i===correctIdx) btn.classList.add('correct');
    else if(i===idx&&!knew) btn.classList.add('wrong');
  }
  const hint=document.getElementById('sent-hint');
  if(knew){
    sessionCombo++;
    sentKnow++;
    hint.textContent = sessionCombo >= 3 ? `✓ Верно! 🔥 Серия: ${sessionCombo}` : '✓ Верно!';
    hint.className='result-hint ok';
  } else {
    sessionCombo = 0;
    sentDontKnow++;
    hint.textContent=`✗ Правильно: ${correctText}`;
    hint.className='result-hint fail';
  }
  if (currentSentDir === 'cloze' && s) {
    document.getElementById('sent-zh').innerHTML = buildSentenceCharSpansHtml(s.zh);
  }
  hint.style.display='block';
  const sentAiBtn = document.getElementById('sent-ai-explain-btn');
  if (sentAiBtn) {
    sentAiBtn.dataset.revealed = '1';
    sentAiBtn.style.display = isAiExplainEnabled() ? 'inline-block' : 'none';
  }
  document.getElementById('sent-next-btn').style.display='block';

  // Always (re)play the correct sentence's audio on reveal — for the ru2zh
  // direction the learner hasn't heard it read aloud yet at all, and for
  // zh2ru they may have answered before the initial playback even finished.
  // Auto-advance only fires once this playback has actually completed (plus
  // a short pause) instead of a fixed delay that used to cut sentences off
  // partway through.
  const playPromise = s ? speakWord(s.zh) : Promise.resolve();
  if (knew) {
    playPromise.finally(() => {
      if (!sentAnswerRevealed) return; // already moved on some other way
      sentAutoAdvanceTimer = setTimeout(() => { if (sentAnswerRevealed) nextSentence(); }, 500);
    });
  }
}

function nextSentence() {
  if (sentAutoAdvanceTimer) { clearTimeout(sentAutoAdvanceTimer); sentAutoAdvanceTimer = null; }
  document.getElementById('char-popup-modal')?.remove();
  const card = document.querySelector('#screen-sentence .flashcard');
  if (card) {
    card.classList.add('card-out');
    setTimeout(() => {
      sentenceIdx++;
      showCurrentSentence();
      requestAnimationFrame(() => card.classList.remove('card-out'));
    }, 130);
  } else {
    sentenceIdx++;
    showCurrentSentence();
  }
}

function showSentenceDone(){
  const sc=document.getElementById('screen-sentence');
  if(sc)sc.classList.remove('active');
  document.getElementById('screen-done').classList.add('active');

  const total = sentKnow + sentDontKnow;
  const pct = total > 0 ? Math.round(sentKnow/total*100) : 0;
  document.getElementById('done-know').textContent = sentKnow;
  document.getElementById('done-dontknow').textContent = sentDontKnow;
  document.getElementById('done-total-sess').textContent = total;
  document.getElementById('done-emoji').textContent = pct>=80?'🏆':'💪';
  if (sessionMode === 'exam_sentences') {
    document.getElementById('done-title').textContent = 'Экзамен завершён!';
    document.getElementById('done-msg').textContent = `Все три этапа пройдены. Точность последнего этапа (предложения): ${pct}%.`;
  } else {
    document.getElementById('done-title').textContent = 'Предложения завершены!';
    document.getElementById('done-msg').textContent = `Точность: ${pct}%. Хорошая практика!`;
  }
  sessionFlow = null;
}

function goHome() {
  document.getElementById('char-popup-modal')?.remove();
  ['screen-done','screen-card','screen-sentence','screen-wordorder','screen-match'].forEach(id=>{
    const el=document.getElementById(id); if(el)el.classList.remove('active');
  });
  showMainScreen();
}

// ---- Word order exercise: given a translation, tap the shuffled Chinese
// word tiles in the correct order to rebuild the sentence — trains grammar
// and word order specifically, a skill none of the other exercises test.
let woQueue = [];
let woIdx = 0;
let woKnow = 0, woDontKnow = 0;
let woRevealed = false;
let woAutoAdvanceTimer = null;
let currentWoTiles = [];
let currentWoPlaced = [];
let currentWoPoolOrder = [];

const PUNCT_ONLY_REGEX = /^[，。？！、：；""''（）\s.,!?;:()"']+$/;

function getWordOrderTiles(s) {
  const segments = segmentSentenceText(s.zh);
  const filtered = segments.filter(seg => seg.text && !PUNCT_ONLY_REGEX.test(seg.text));
  if (filtered.length < 3) return null; // too short to be a meaningful ordering exercise
  return filtered.map((seg, i) => ({ text: seg.text, correctPos: i }));
}

function launchWordOrderSession(sentences) {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  woQueue = sentences;
  woIdx = 0;
  woKnow = 0;
  woDontKnow = 0;
  sessionCombo = 0;
  sessionMode = 'wordorder';
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-wordorder').classList.add('active');
  showCurrentWordOrder();
}

function showCurrentWordOrder() {
  if (woIdx >= woQueue.length) { showWordOrderDone(); return; }
  const s = woQueue[woIdx];
  const tiles = getWordOrderTiles(s);
  if (!tiles) { woIdx++; showCurrentWordOrder(); return; }

  woRevealed = false;
  currentWoTiles = tiles;
  currentWoPlaced = [];
  document.getElementById('wo-translation').textContent = s.t;
  document.getElementById('wo-hint').style.display = 'none';
  document.getElementById('wo-next-btn').style.display = 'none';
  document.getElementById('wo-speak-btn').style.display = 'none';
  renderWoTilePool(shuffle(tiles.map((t, i) => i)));
  renderWoBuildArea();

  const pct = Math.round(woIdx/woQueue.length*100);
  document.getElementById('wo-progress-fill').style.width = pct+'%';
  document.getElementById('wo-progress-text').textContent = `${woIdx} / ${woQueue.length}`;
}

function renderWoTilePool(poolIndices) {
  currentWoPoolOrder = poolIndices;
  const el = document.getElementById('wo-tile-pool');
  el.innerHTML = currentWoPoolOrder.map(idx =>
    `<button class="wo-tile" data-action="wo-place-tile" data-idx="${idx}">${escapeHtml(currentWoTiles[idx].text)}</button>`
  ).join('');
}

function renderWoBuildArea() {
  const el = document.getElementById('wo-build-area');
  if (currentWoPlaced.length === 0) {
    el.innerHTML = `<span style="color:var(--text3);font-size:12px;">Собери предложение здесь</span>`;
    return;
  }
  el.innerHTML = currentWoPlaced.map((idx, pos) =>
    `<button class="wo-tile placed" data-action="wo-remove-tile" data-pos="${pos}">${escapeHtml(currentWoTiles[idx].text)}</button>`
  ).join('');
}

function woPlaceTile(idx) {
  if (woRevealed) return;
  currentWoPlaced.push(idx);
  currentWoPoolOrder = currentWoPoolOrder.filter(i => i !== idx);
  renderWoTilePool(currentWoPoolOrder);
  renderWoBuildArea();
  if (currentWoPoolOrder.length === 0) checkWordOrder();
}

function woRemoveTile(pos) {
  if (woRevealed) return;
  const idx = currentWoPlaced[pos];
  currentWoPlaced.splice(pos, 1);
  currentWoPoolOrder.push(idx);
  renderWoTilePool(currentWoPoolOrder);
  renderWoBuildArea();
}

function checkWordOrder() {
  woRevealed = true;
  const s = woQueue[woIdx];
  const correct = currentWoPlaced.length === currentWoTiles.length &&
    currentWoPlaced.every((idx, pos) => currentWoTiles[idx].correctPos === pos);

  const buildEl = document.getElementById('wo-build-area');
  [...buildEl.children].forEach((btn, pos) => {
    const idx = currentWoPlaced[pos];
    btn.classList.remove('placed');
    btn.classList.add(currentWoTiles[idx].correctPos === pos ? 'correct-final' : 'wrong-final');
    btn.disabled = true;
  });

  const hint = document.getElementById('wo-hint');
  if (correct) {
    woKnow++;
    sessionCombo++;
    hint.textContent = sessionCombo >= 3 ? `✓ Верно! 🔥 Серия: ${sessionCombo}` : '✓ Верно!';
    hint.className = 'result-hint ok';
  } else {
    woDontKnow++;
    sessionCombo = 0;
    hint.textContent = `✗ Правильно: ${s.zh}`;
    hint.className = 'result-hint fail';
  }
  hint.style.display = 'block';
  document.getElementById('wo-next-btn').style.display = 'block';
  document.getElementById('wo-speak-btn').style.display = 'inline-block';

  const playPromise = speakWord(s.zh);
  if (correct) {
    playPromise.finally(() => {
      if (!woRevealed) return;
      woAutoAdvanceTimer = setTimeout(() => { if (woRevealed) nextWordOrder(); }, 600);
    });
  }
}

function nextWordOrder() {
  if (woAutoAdvanceTimer) { clearTimeout(woAutoAdvanceTimer); woAutoAdvanceTimer = null; }
  woIdx++;
  showCurrentWordOrder();
}

function speakWordOrderCurrent() {
  const s = woQueue[woIdx];
  if (s) speakWord(s.zh);
}

function showWordOrderDone() {
  document.getElementById('screen-wordorder').classList.remove('active');
  document.getElementById('screen-done').classList.add('active');
  const total = woKnow + woDontKnow;
  const pct = total > 0 ? Math.round(woKnow/total*100) : 0;
  document.getElementById('done-know').textContent = woKnow;
  document.getElementById('done-dontknow').textContent = woDontKnow;
  document.getElementById('done-total-sess').textContent = total;
  document.getElementById('done-emoji').textContent = pct>=80?'🏆':'💪';
  document.getElementById('done-title').textContent = 'Порядок слов завершён!';
  document.getElementById('done-msg').textContent = `Точность: ${pct}%. Так тренируется грамматика!`;
}

// ---- Matching pairs game: hanzi tiles and translation tiles scattered in a
// grid, tap two to check if they're the same word — a lower-pressure, more
// game-like way to review a batch of words versus the graded quizzes.
let matchWords = [];
let matchTiles = [];
let matchSelectedPos = null;
let matchPairsFound = 0;
let matchTotalPairs = 0;
let matchWrongCount = 0;

function launchMatchSession(wordIndices) {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  matchWords = wordIndices;
  matchTotalPairs = matchWords.length;
  matchPairsFound = 0;
  matchWrongCount = 0;
  matchSelectedPos = null;
  sessionMode = 'match';

  // Two independently-shuffled lists (hanzi, translations) interleaved as
  // [zh0, meaning0, zh1, meaning1, ...] — with a 2-column grid this renders
  // as a clean "hanzi on the left, translations on the right" layout
  // instead of one fully-mixed grid, while each side stays shuffled on its
  // own so pairs never trivially line up on the same row.
  const zhTiles = shuffle(matchWords.map(wi => ({ wordIdx: wi, text: DICTIONARY[wi].h, type: 'zh', matched: false })));
  const meaningTiles = shuffle(matchWords.map(wi => ({ wordIdx: wi, text: DICTIONARY[wi].t, type: 'meaning', matched: false })));
  matchTiles = [];
  for (let i = 0; i < matchWords.length; i++) {
    matchTiles.push(zhTiles[i]);
    matchTiles.push(meaningTiles[i]);
  }

  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-match').classList.add('active');
  renderMatchGrid();
  updateMatchProgress();
}

function renderMatchGrid() {
  const el = document.getElementById('match-grid');
  el.innerHTML = matchTiles.map((t, pos) => {
    const classes = ['match-tile'];
    if (t.type === 'zh') classes.push('zh');
    if (t.matched) classes.push('matched');
    if (pos === matchSelectedPos) classes.push('selected');
    return `<button class="${classes.join(' ')}" data-action="match-tap-tile" data-pos="${pos}" ${t.matched ? 'disabled' : ''}>${escapeHtml(t.text)}</button>`;
  }).join('');
}

function updateMatchProgress() {
  document.getElementById('match-progress-text').textContent = `${matchPairsFound} / ${matchTotalPairs} пар`;
  const pct = matchTotalPairs > 0 ? Math.round(matchPairsFound/matchTotalPairs*100) : 0;
  document.getElementById('match-progress-fill').style.width = pct + '%';
}

function matchTapTile(pos) {
  const tile = matchTiles[pos];
  if (!tile || tile.matched || pos === matchSelectedPos) return;

  if (matchSelectedPos === null) {
    matchSelectedPos = pos;
    renderMatchGrid();
    return;
  }

  const first = matchTiles[matchSelectedPos];
  const second = tile;
  const isMatch = first.wordIdx === second.wordIdx && first.type !== second.type;

  if (isMatch) {
    first.matched = true;
    second.matched = true;
    matchPairsFound++;
    matchSelectedPos = null;
    renderMatchGrid();
    updateMatchProgress();
    speakWord(DICTIONARY[first.wordIdx].h);
    if (matchPairsFound >= matchTotalPairs) {
      setTimeout(() => showMatchDone(), 500);
    }
  } else {
    matchWrongCount++;
    const firstPos = matchSelectedPos;
    const secondPos = pos;
    matchSelectedPos = null;
    renderMatchGrid();
    const grid = document.getElementById('match-grid');
    const btn1 = grid.children[firstPos];
    const btn2 = grid.children[secondPos];
    if (btn1) btn1.classList.add('wrong-flash');
    if (btn2) btn2.classList.add('wrong-flash');
    setTimeout(() => {
      if (btn1) btn1.classList.remove('wrong-flash');
      if (btn2) btn2.classList.remove('wrong-flash');
    }, 500);
  }
}

function showMatchDone() {
  document.getElementById('screen-match').classList.remove('active');
  document.getElementById('screen-done').classList.add('active');
  document.getElementById('done-know').textContent = matchTotalPairs;
  document.getElementById('done-dontknow').textContent = matchWrongCount;
  document.getElementById('done-total-sess').textContent = matchTotalPairs;
  document.getElementById('done-emoji').textContent = matchWrongCount === 0 ? '🏆' : '💪';
  document.getElementById('done-title').textContent = 'Игра завершена!';
  document.getElementById('done-msg').textContent =
    `Все ${matchTotalPairs} пар найдены${matchWrongCount > 0 ? ', ошибок: ' + matchWrongCount : ' без единой ошибки'}!`;
}

// Firefox (and some other browsers) only expose the OS's built-in system
// voices through the Web Speech API — on Windows that's the old, flat-sounding
// SAPI voices (Huihui/Yaoyao), with no access to Chrome/Edge's high-quality
// cloud voices. No amount of voice *selection* can fix that: the good voice
// simply isn't offered to the page. So instead of relying only on
// speechSynthesis, we first try a real cloud TTS audio clip — this sounds
// natural in every browser, Firefox included — and fall back to the
// browser's built-in speech synthesis if there's no internet connection or
// the request fails for any reason, so playback never breaks entirely.
function isCloudTtsEnabled() {
  const v = localStorage.getItem('hsk_cloud_tts');
  return v === null || v === '1';
}

// When enabled, never fall back to the browser's own (often robotic) voice —
// stay silent instead on a network hiccup rather than let a flat SAPI voice
// through. Off by default so a shaky connection still gets *some* audio.
function isForceCloudOnly() {
  return localStorage.getItem('hsk_force_cloud_only') === '1';
}

// Every call to stopAllAudioHard() bumps this — any in-flight speak attempt
// started before the bump is "stale" and must not touch the shared audio
// element anymore. Without this, a quick sentence-to-sentence switch could
// leave an old 5s timeout still pending; when it later fired it would yank
// the audio element out from under whichever *newer* request was already
// playing successfully and trigger a browser-TTS fallback on top of it —
// exactly the "robotic voice as a second layer" symptom.
let __ttsGeneration = 0;

function stopAllAudioHard() {
  __ttsGeneration++;
  const audio = window.__hskAudio;
  if (audio) {
    try {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) {}
  }
  if (window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
}

function speakWithCloudTTSOnce(text) {
  return new Promise((resolve, reject) => {
    try {
      const myGen = __ttsGeneration;
      const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=' + encodeURIComponent(text);
      if (!window.__hskAudio) window.__hskAudio = new Audio();
      const audio = window.__hskAudio;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      try { audio.currentTime = 0; } catch (e) {}
      audio.src = url;

      let settled = false;
      const isStale = () => myGen !== __ttsGeneration;
      // A late success arriving *after* we've already given up (timeout) or
      // failed used to keep playing anyway — that produced a second, robotic
      // voice layered on top once the fallback kicked in. Hard-stopping the
      // element on every non-success path prevents that race — but only if
      // this call still "owns" the shared audio element; if a newer speak
      // request has since taken over (isStale), touching it here would stop
      // *that* one instead, so we just quietly bow out.
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!isStale()) {
          try { audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {}
        }
        reject(err || new Error('cloud tts failed'));
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => fail(new Error('cloud tts timeout')), 5000);
      audio.onended = succeed;
      audio.onerror = () => fail(new Error('cloud tts audio error'));
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(err => fail(err));
      }
    } catch (e) {
      reject(e);
    }
  });
}

// One retry before giving up — the free translate_tts endpoint occasionally
// hiccups on the first request for no real reason, and a lot of "robotic
// voice slipped through" reports are really just that, not a real outage.
function speakWithCloudTTS(text) {
  return speakWithCloudTTSOnce(text).catch(() => speakWithCloudTTSOnce(text));
}

let __ttsFailureNotified = false;
function notifyTtsFailureOnce(msg) {
  if (__ttsFailureNotified) return;
  __ttsFailureNotified = true;
  showToast(msg);
}

function speakWithBrowserTTS(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) {
      notifyTtsFailureOnce('Озвучка недоступна в этом браузере (нет Web Speech API).');
      resolve();
      return;
    }
    if (!preferredChineseVoice) refreshSpeechVoices();
    window.speechSynthesis.cancel();
    // Mobile Safari has a long-documented quirk where calling speak()
    // immediately after cancel() can silently swallow the utterance (no
    // sound, no error) — a short delay before speaking works around it.
    // Harmless everywhere else since it's a single animation frame.
    requestAnimationFrame(() => {
      const utt = new SpeechSynthesisUtterance(text);
      if (preferredChineseVoice) {
        utt.voice = preferredChineseVoice;
        utt.lang = preferredChineseVoice.lang || 'zh-CN';
      } else {
        utt.lang = 'zh-CN';
      }
      utt.rate = 0.78;
      utt.pitch = 1;
      utt.volume = 1;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      utt.onend = finish;
      utt.onerror = finish;
      window.speechSynthesis.speak(utt);
      // Some Safari versions neither fire onend nor onerror and simply
      // produce no sound at all — surfacing that once (instead of leaving
      // it as unexplained silence) makes it possible to actually diagnose.
      setTimeout(() => {
        if (!settled && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
          notifyTtsFailureOnce('Озвучка молча не сработала — браузер её заблокировал. Попробуйте нажать 🔊 ещё раз, или в Статистике отключите «только облачный голос», если он включён.');
        }
        finish();
      }, 1200);
    });
  });
}

// Mobile browsers (iOS Safari especially, some Android browsers too) only
// allow audio to play programmatically after it's been "unlocked" by a
// direct user gesture at least once. Priming both the shared Audio element
// and SpeechSynthesis on the very first tap anywhere on the page means every
// *later* auto-play (e.g. a card's audio firing after a timed transition,
// which is no longer a direct gesture) has already been granted permission
// for this session, instead of silently failing with no sound and no error.
let __audioUnlocked = false;
function unlockAudioOnFirstInteraction() {
  if (__audioUnlocked) return;
  __audioUnlocked = true;
  try {
    if (!window.__hskAudio) window.__hskAudio = new Audio();
    const audio = window.__hskAudio;
    // A silent, near-instant WAV data URI — playing (and immediately
    // pausing) it counts as the required user-gesture-triggered playback
    // that unlocks the element for later programmatic use.
    audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    setTimeout(() => { try { audio.pause(); audio.currentTime = 0; } catch (e) {} }, 50);
  } catch (e) {}
  try {
    if (window.speechSynthesis) {
      const utt = new SpeechSynthesisUtterance(' ');
      utt.volume = 0;
      window.speechSynthesis.speak(utt);
    }
  } catch (e) {}
}

// Returns a Promise that resolves once playback has actually finished, so
// callers (e.g. auto-advancing after a sentence) can wait for the real
// audio to end instead of guessing with a fixed timer.
function speakWord(text) {
  if (!text) return Promise.resolve();
  stopAllAudioHard();
  const myGen = __ttsGeneration;
  if (isCloudTtsEnabled()) {
    return speakWithCloudTTS(text).catch(() => {
      // A newer speakWord() call has since started (e.g. the learner moved
      // to the next question before this one finished retrying) — don't
      // speak stale, superseded text over whatever's playing now.
      if (myGen !== __ttsGeneration) return Promise.resolve();
      if (isForceCloudOnly()) return Promise.resolve(); // stay silent rather than fall back to a robotic voice
      return speakWithBrowserTTS(text);
    });
  }
  return speakWithBrowserTTS(text);
}

// Manual toggle in Settings: cloud TTS needs internet and sends the word/
// sentence text to Google's translate endpoint to synthesize it, so a
// privacy-conscious learner (or anyone offline) can switch back to the
// browser's own local voice.
function renderCloudTtsToggle() {
  const container = document.getElementById('cloud-tts-toggle-container');
  if (!container) return;
  const enabled = isCloudTtsEnabled();
  const forceOnly = isForceCloudOnly();
  container.innerHTML = `
    <label style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text2);cursor:pointer;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:8px;">
      <input type="checkbox" id="cloud-tts-checkbox" ${enabled ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0;">
      <span>☁️ Облачная озвучка — звучит естественнее (особенно в Firefox), нужен интернет</span>
    </label>
    <label style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text2);cursor:pointer;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:8px;">
      <input type="checkbox" id="force-cloud-checkbox" ${forceOnly ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0;">
      <span>🚫 Никогда не использовать голос браузера — при сбое сети лучше тишина, чем роботоголос</span>
    </label>
    <button data-action="diagnose-audio" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:9px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:12px;">🔊 Диагностика звука</button>
    <div id="audio-diag-result" style="margin-top:8px;font-size:11px;line-height:1.6;font-family:'DM Mono',monospace;white-space:pre-wrap;display:none;background:var(--surface2);padding:10px;border-radius:var(--radius-sm);border:1px solid var(--border);"></div>
  `;
  document.getElementById('cloud-tts-checkbox').addEventListener('change', e => {
    localStorage.setItem('hsk_cloud_tts', e.target.checked ? '1' : '0');
  });
  document.getElementById('force-cloud-checkbox').addEventListener('change', e => {
    localStorage.setItem('hsk_force_cloud_only', e.target.checked ? '1' : '0');
  });
}

// Walks the whole audio pipeline step by step and prints exactly what
// happened at each stage, ON SCREEN — a console.log is useless if the
// person can't easily open devtools on their phone. This turns "no sound,
// no idea why" into a copy-pasteable diagnosis.
async function diagnoseAudio() {
  const out = document.getElementById('audio-diag-result');
  if (!out) return;
  out.style.display = 'block';
  const lines = [];
  const log = (s) => { lines.push(s); out.textContent = lines.join('\n'); };

  log('Браузер: ' + navigator.userAgent);
  log('Протокол страницы: ' + location.protocol);
  log('');

  // 1) Audio element + cloud endpoint
  log('[1/3] Облачная озвучка (Audio-элемент)...');
  try {
    if (!window.__hskAudio) window.__hskAudio = new Audio();
    const audio = window.__hskAudio;
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=' + encodeURIComponent('你好');
    audio.pause();
    audio.src = url;
    const result = await new Promise(resolve => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      audio.onended = () => finish('ok');
      audio.onerror = () => finish('audio-error');
      const p = audio.play();
      if (p && p.catch) p.catch(err => finish('play-rejected: ' + (err?.name || err?.message || err)));
      setTimeout(() => finish('timeout-5s'), 5000);
    });
    log('  → ' + result);
    if (result === 'ok') log('  ✓ Облачный звук ФАКТИЧЕСКИ проигрался.');
    else log('  ✗ Облачный звук НЕ проигрался.');
  } catch (e) {
    log('  → исключение: ' + (e?.message || e));
  }
  log('');

  // 2) Raw network reachability of the endpoint (separately from playback,
  // to tell apart "blocked by network/CORS" vs "blocked by autoplay policy")
  log('[2/3] Доступность endpoint (fetch, не для прослушивания)...');
  try {
    const testUrl = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=test';
    const res = await fetch(testUrl, { method: 'HEAD' }).catch(async e => {
      // HEAD may be rejected by the endpoint itself even when reachable — try GET as a fallback check
      return fetch(testUrl);
    });
    log('  → HTTP статус: ' + res.status + (res.ok ? ' (OK, сервер отвечает)' : ' (сервер ответил, но с ошибкой)'));
  } catch (e) {
    log('  → сетевая ошибка: ' + (e?.message || e) + ' (похоже на блокировку сети/расширением/DNS)');
  }
  log('');

  // 3) Browser speechSynthesis fallback
  log('[3/3] Голос браузера (speechSynthesis)...');
  if (!window.speechSynthesis) {
    log('  ✗ window.speechSynthesis отсутствует в этом браузере вовсе.');
  } else {
    const voices = window.speechSynthesis.getVoices();
    log('  Доступно голосов всего: ' + voices.length);
    const zhVoices = voices.filter(v => String(v.lang||'').toLowerCase().startsWith('zh'));
    log('  Китайских голосов: ' + zhVoices.length + (zhVoices.length ? ' (' + zhVoices.map(v=>v.name).join(', ') + ')' : ''));
    try {
      const result = await new Promise(resolve => {
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        const utt = new SpeechSynthesisUtterance('你好');
        utt.lang = 'zh-CN';
        utt.onend = () => finish('ok (onend fired)');
        utt.onerror = (e) => finish('error: ' + (e?.error || 'unknown'));
        window.speechSynthesis.speak(utt);
        setTimeout(() => {
          finish('timeout-1.5s (speaking=' + window.speechSynthesis.speaking + ', pending=' + window.speechSynthesis.pending + ')');
        }, 1500);
      });
      log('  → ' + result);
    } catch (e) {
      log('  → исключение: ' + (e?.message || e));
    }
  }
  log('');
  log('Скопируйте весь этот текст и отправьте — так будет видно, что именно не работает.');
}

function speakCurrent() {
  // Read the actual current session word, not whatever text happens to be
  // on screen — in listening mode the hanzi is deliberately hidden behind a
  // placeholder ("🎧") before answering, so reading the DOM text would try
  // to speak the placeholder itself and could come out as anything.
  const wi = sessionQueue[sessionIdx];
  const word = DICTIONARY[wi];
  if (word) { speakWord(word.h); return; }
  const t = document.getElementById('card-hanzi');
  if (t && t.textContent) speakWord(t.textContent);
}

// ---- AI explanations (bring-your-own Google Gemini API key). Used only
// when the learner explicitly taps "Объяснить" after answering, never
// automatically — nothing is sent anywhere unless the key is configured AND
// the button is tapped. The key lives only in this browser's localStorage
// and is sent only in direct requests from this page to Google's API, never
// anywhere else. Gemini's free tier needs no card and no separate login
// popup (unlike the Puter.js relay this replaced) — just an API key from
// https://aistudio.google.com/apikey.
const aiExplainCache = new Map();
// Google periodically retires specific dated model snapshots (gemini-1.5-flash
// and even gemini-2.5-flash have gone away or are scheduled to) — pinning an
// exact version number here would just break again on the next retirement.
// The "-latest" aliases are hot-swapped by Google to whatever the current
// release is, so they stay correct without needing an app update. A couple
// of concrete fallbacks are kept behind them just in case an alias itself
// has trouble on a given account/region.
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.0-flash'];

function getGeminiKey() {
  return (localStorage.getItem('hsk_gemini_key') || '').trim();
}

function isAiExplainEnabled() {
  if (!getGeminiKey()) return false;
  const v = localStorage.getItem('hsk_ai_explain');
  return v === null || v === '1';
}

function maskKey(key) {
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

// Lets a learner pick which typing exercise they get: writing the actual
// character via their own Chinese IME, or typing tone-insensitive pinyin on
// a plain keyboard — both are valid, it just depends on what they have set
// up on their device.
function renderTypingModeToggle() {
  const container = document.getElementById('typing-mode-toggle-container');
  if (!container) return;
  const mode = getTypingMode();
  container.innerHTML = `
    <div style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);">
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">⌨️ Упражнение «Написание» — что вводить:</div>
      <div style="display:flex;gap:8px;">
        <button data-action="set-typing-mode-hanzi" style="flex:1;padding:8px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:12px;border:1px solid ${mode==='hanzi'?'var(--accent)':'var(--border)'};background:${mode==='hanzi'?'rgba(124,158,248,0.12)':'var(--surface)'};color:${mode==='hanzi'?'var(--accent3)':'var(--text)'};">汉字 Иероглиф (IME)</button>
        <button data-action="set-typing-mode-pinyin" style="flex:1;padding:8px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:12px;border:1px solid ${mode==='pinyin'?'var(--accent)':'var(--border)'};background:${mode==='pinyin'?'rgba(124,158,248,0.12)':'var(--surface)'};color:${mode==='pinyin'?'var(--accent3)':'var(--text)'};">Пиньинь (латиница)</button>
      </div>
    </div>
  `;
}

function renderGeminiKeySettings(forceEdit) {
  const container = document.getElementById('gemini-key-container');
  if (!container) return;
  const key = getGeminiKey();

  if (!key || forceEdit) {
    container.innerHTML = `
      <div style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);">
        <div style="font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:10px;">
          🤖 Кнопка «Объяснить» использует ваш собственный бесплатный ключ Google Gemini —
          без карты, без входа в сторонние сервисы. Получить ключ:
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--accent3);">aistudio.google.com/apikey</a>
        </div>
        <input type="password" id="gemini-key-input" placeholder="Вставьте ключ (AIza…)" autocomplete="off" spellcheck="false" value="${escapeHtml(key)}"
          style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:inherit;font-size:13px;">
        <button data-action="save-gemini-key" style="width:100%;background:var(--accent);color:#0d0d10;border:none;padding:10px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-weight:700;font-size:13px;">Сохранить ключ</button>
      </div>
    `;
    return;
  }

  const enabled = isAiExplainEnabled();
  container.innerHTML = `
    <div style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);">
      <label style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text2);cursor:pointer;margin-bottom:10px;">
        <input type="checkbox" id="ai-explain-checkbox" ${enabled ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0;">
        <span>🤖 Кнопка «Объяснить» включена — ключ Gemini: <code>${escapeHtml(maskKey(key))}</code></span>
      </label>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <button data-action="change-gemini-key" style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:12px;">Изменить ключ</button>
        <button data-action="remove-gemini-key" style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--danger,#e6807a);padding:8px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:12px;">Удалить ключ</button>
      </div>
      <button data-action="test-gemini-key" style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:8px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:12px;">🔍 Проверить ключ</button>
      <div id="gemini-test-result" style="margin-top:8px;font-size:12px;line-height:1.5;display:none;"></div>
    </div>
  `;
  document.getElementById('ai-explain-checkbox').addEventListener('change', e => {
    localStorage.setItem('hsk_ai_explain', e.target.checked ? '1' : '0');
    updateAiExplainButtonsVisibility();
  });
}

// Runs a minimal real request and reports exactly what went wrong — network/
// CORS failure vs a specific HTTP status — instead of the generic in-session
// message, so a learner can actually diagnose a stuck "Объяснить" button.
function testGeminiKey() {
  const resultEl = document.getElementById('gemini-test-result');
  if (!resultEl) return;
  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text3)';
  resultEl.textContent = 'Проверяю…';
  callAi('Ответь одним словом: работает?')
    .then(text => {
      resultEl.style.color = 'var(--accent)';
      resultEl.textContent = '✓ Ключ работает. Ответ Gemini: ' + text.slice(0, 80);
    })
    .catch(err => {
      resultEl.style.color = 'var(--danger, #e6807a)';
      if (err && err.status) {
        resultEl.textContent = `✗ Ошибка HTTP ${err.status}. ${err.body ? String(err.body).slice(0, 200) : ''}`;
      } else if (err && err.message === 'timeout') {
        resultEl.textContent = '✗ Не дождались ответа (таймаут 28с) — попробуйте ещё раз.';
      } else {
        resultEl.textContent = `✗ Запрос не дошёл до Google (${err?.message || 'сетевая ошибка'}). Часто это блокировка CORS при открытии файла напрямую — попробуйте открыть приложение через локальный сервер или разместить на хостинге, либо проверьте консоль браузера (F12) на слово "CORS".`;
      }
      console.error('Gemini test failed:', err);
    });
}

function saveGeminiKey() {
  const input = document.getElementById('gemini-key-input');
  const val = input ? input.value.trim() : '';
  if (!val) return;
  localStorage.setItem('hsk_gemini_key', val);
  localStorage.setItem('hsk_ai_explain', '1');
  renderGeminiKeySettings();
  updateAiExplainButtonsVisibility();
  showToast('Ключ Gemini сохранён');
}

function removeGeminiKey() {
  localStorage.removeItem('hsk_gemini_key');
  aiExplainCache.clear();
  renderGeminiKeySettings();
  updateAiExplainButtonsVisibility();
}

function updateAiExplainButtonsVisibility() {
  // Only relevant once an answer has already been revealed; if the button
  // was already shown for the current question, respect the current toggle.
  const wordBtn = document.getElementById('ai-explain-btn');
  const sentBtn = document.getElementById('sent-ai-explain-btn');
  if (wordBtn && wordBtn.dataset.revealed === '1') wordBtn.style.display = isAiExplainEnabled() ? 'inline-block' : 'none';
  if (sentBtn && sentBtn.dataset.revealed === '1') sentBtn.style.display = isAiExplainEnabled() ? 'inline-block' : 'none';
}

function fetchGeminiModelOnce(prompt, key, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  }).then(async res => {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error('gemini-http-' + res.status);
      err.status = res.status;
      err.body = body;
      // A model name going stale (404) is the most likely long-term failure
      // mode here; a still-overloaded model (5xx) is also worth trying a
      // different model for — both are worth advancing to the next
      // candidate model for. transient marks ones worth an in-place retry
      // on this SAME model first (see fetchGeminiModel below).
      err.retryable = (res.status === 404 || res.status === 400 || res.status >= 500);
      err.transient = res.status >= 500;
      throw err;
    }
    return res.json();
  }).then(data => {
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('empty-response');
    return text;
  });
}

function fetchGeminiModel(prompt, key, model, attempt = 0) {
  // fetchGeminiModelOnce always resolves to the final parsed text or rejects
  // with a fully-formed error — this wrapper only ever adds retry timing
  // around it, never re-parses an already-resolved value (that double-parse
  // was an earlier bug: a retry's plain-text result got fed back into the
  // JSON response parser and always came out "empty").
  return fetchGeminiModelOnce(prompt, key, model).catch(err => {
    // 503 "model overloaded" is explicitly described by Google as usually
    // temporary — worth one quick automatic retry on the SAME model before
    // falling through to the next model / bothering the learner to tap the
    // button again. Kept to a single retry so the total delay across the
    // whole model chain can't creep close to the overall 28s timeout.
    if (err && err.transient && attempt < 1) {
      return new Promise(resolve => setTimeout(resolve, 1500))
        .then(() => fetchGeminiModel(prompt, key, model, attempt + 1));
    }
    throw err;
  });
}

function callGeminiOnce(prompt, key, modelIdx) {
  if (modelIdx >= GEMINI_MODELS.length) return Promise.reject(new Error('all-models-failed'));
  const model = GEMINI_MODELS[modelIdx];
  return fetchGeminiModel(prompt, key, model).catch(err => {
    if (err && err.retryable && modelIdx + 1 < GEMINI_MODELS.length) {
      return callGeminiOnce(prompt, key, modelIdx + 1);
    }
    throw err;
  });
}

function callAi(prompt) {
  const key = getGeminiKey();
  if (!key) return Promise.reject(new Error('no-key'));
  return Promise.race([
    callGeminiOnce(prompt, key, 0),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 28000))
  ]);
}

function renderAiExplainResult(boxEl, state, text, error) {
  if (state === 'loading') {
    boxEl.innerHTML = `<div class="ai-explain-loading">🤖 Думаю над объяснением…</div>`;
  } else if (state === 'error') {
    let msg;
    if (error?.status === 400 || error?.status === 403) {
      msg = 'Google Gemini отклонил запрос — проверьте, что ключ скопирован верно и активен, в Статистике.';
    } else if (error?.status === 429) {
      msg = 'Достигнут лимит бесплатных запросов Gemini на сейчас — попробуйте через минуту.';
    } else if (error?.status && error.status >= 500) {
      msg = 'Сервис Google Gemini временно недоступен (сбой на их стороне) — попробуйте ещё раз через минуту.';
    } else if (error?.message === 'timeout') {
      // Distinct from a network/CORS failure: the request DID go through
      // (the key works, as confirmed by "Проверить ключ") — Gemini just
      // hasn't answered within 28s, usually because this prompt is longer
      // than the quick test prompt and takes longer to generate.
      msg = 'Google Gemini не ответил за 28 секунд — не проблема с интернетом, просто долгая генерация или перегрузка сервиса. Попробуйте ещё раз.';
    } else if (error?.status) {
      msg = `Google Gemini вернул ошибку (HTTP ${error.status}).`;
    } else {
      msg = 'Запрос не дошёл до Google — часто это блокировка CORS (например, при открытии файла напрямую) или сбой сети. Нажмите «🔍 Проверить ключ» в Статистике для точной причины.';
    }
    const rawDetail = error ? (error.message || error.name || String(error)) : '';
    const bodyDetail = error?.body ? String(error.body).slice(0, 200) : '';
    const detail = [rawDetail, bodyDetail].filter(Boolean).join(' — ');
    boxEl.innerHTML = `<div class="ai-explain-error">${escapeHtml(msg)}</div>` +
      (detail ? `<div class="ai-explain-error-detail">${escapeHtml(detail)}</div>` : '');
    console.error('AI explain failed:', error);
  } else {
    boxEl.innerHTML = `<div class="ai-explain-text">${escapeHtml(text).replace(/\n+/g,'<br>')}</div>`;
  }
  boxEl.style.display = 'block';
}

function aiExplainWord() {
  if (!isAiExplainEnabled()) return;
  const wi = sessionQueue[sessionIdx];
  if (wi === undefined) return;
  const word = DICTIONARY[wi];
  const isTyping = sessionMode === 'words_typing';
  const isListening = sessionMode === 'words_listening';

  let wrongNote = '';
  let cacheSuffix;
  if (isTyping) {
    const typed = window.__lastTypedAnswer || '';
    const mode = getTypingMode();
    cacheSuffix = 'typed:' + mode + ':' + typed;
    if (mode === 'pinyin') {
      if (typed && normalizePinyinAnswer(typed) !== normalizePinyinAnswer(word.p)) {
        wrongNote = ` Ученик ввёл пиньинь «${typed}» вместо правильного «${word.p}» — объясни коротко разницу в произношении/слогах.`;
      } else if (!typed) {
        wrongNote = ` Ученик не смог вспомнить пиньинь.`;
      }
    } else {
      if (typed && normalizeHanziAnswer(typed) !== normalizeHanziAnswer(word.h)) {
        wrongNote = ` Ученик написал «${typed}» вместо правильного иероглифа «${word.h}» — объясни коротко, в чём разница (или почему он мог перепутать это со своим вариантом).`;
      } else if (!typed) {
        wrongNote = ` Ученик не смог вспомнить, как пишется иероглиф.`;
      }
    }
  } else {
    const chosenIdx = window.__lastCardChoice;
    const chosenText = chosenIdx !== undefined && chosenIdx !== null
      ? document.getElementById('mc' + chosenIdx)?.textContent
      : null;
    cacheSuffix = ':' + chosenIdx;
    const correctDisplay = isListening ? word.h : word.t;
    if (chosenText && chosenText !== correctDisplay && !isListening) {
      wrongNote = ` Ученик выбрал вариант «${chosenText}» — это неверно, объясни коротко, чем он отличается по смыслу.`;
    }
  }

  const cacheKey = 'word:' + wi + ':' + cacheSuffix;
  const box = document.getElementById('ai-explain-box');
  if (aiExplainCache.has(cacheKey)) {
    renderAiExplainResult(box, 'ok', aiExplainCache.get(cacheKey));
    return;
  }
  renderAiExplainResult(box, 'loading');
  const prompt = `Ты — преподаватель китайского для русскоязычных учеников уровня HSK${word.l}. ` +
    `Слово: ${word.h} (пиньинь: ${word.p}), перевод: «${word.t}».` + wrongNote +
    ` Объясни по-русски просто и кратко (3-5 предложений, без списков и заголовков), почему перевод именно такой: затронь смысл иероглифов, оттенки значения и с чем это слово легко перепутать. Не используй markdown-разметку.`;
  callAi(prompt)
    .then(text => { aiExplainCache.set(cacheKey, text); renderAiExplainResult(box, 'ok', text); })
    .catch(err => renderAiExplainResult(box, 'error', null, err));
}

function aiExplainSentence() {
  if (!isAiExplainEnabled()) return;
  const s = sentenceQueue[sentenceIdx];
  if (!s) return;
  const chosenIdx = window.__lastSentChoice;
  const chosenText = chosenIdx !== undefined && chosenIdx !== null
    ? document.getElementById('sent-mc' + chosenIdx)?.textContent
    : null;
  const correctText = currentSentDir === 'zh2ru' ? s.t : s.zh;
  const cacheKey = 'sent:' + s.zh + ':' + currentSentDir + ':' + chosenIdx;
  const box = document.getElementById('sent-ai-explain-box');
  if (aiExplainCache.has(cacheKey)) {
    renderAiExplainResult(box, 'ok', aiExplainCache.get(cacheKey));
    return;
  }
  renderAiExplainResult(box, 'loading');
  const wrongNote = chosenText && chosenText !== correctText
    ? ` Ученик выбрал вариант «${chosenText}» — это неверно, объясни коротко, в чём разница.`
    : '';
  const prompt = `Ты — преподаватель китайского для русскоязычных учеников уровня HSK${s.l}. ` +
    `Предложение: ${s.zh} (пиньинь: ${s.py}), перевод: «${s.t}».` + wrongNote +
    ` Объясни по-русски просто и кратко (3-5 предложений, без списков и заголовков), какая грамматическая конструкция или порядок слов здесь используется и почему именно так, а не иначе. Не используй markdown-разметку.`;
  callAi(prompt)
    .then(text => { aiExplainCache.set(cacheKey, text); renderAiExplainResult(box, 'ok', text); })
    .catch(err => renderAiExplainResult(box, 'error', null, err));
}

function speakSentenceCurrent() {
  const sentence = document.getElementById('sent-zh');
  if (sentence) speakWord(sentence.textContent);
}

function showToast(msg) {
  let t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.style.cssText='position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:12px 20px;border-radius:var(--radius-sm);font-size:13px;z-index:9999;max-width:300px;text-align:center;box-shadow:var(--shadow)';document.body.appendChild(t);}
  t.textContent=msg; t.style.opacity='1';
  clearTimeout(t._timer); t._timer=setTimeout(()=>t.style.opacity='0',2500);
}

function resetData() {
  if (!confirm('Вы уверены? Весь прогресс будет удалён.')) return;
  localStorage.removeItem('hsk_state'); location.reload();
}

// Lets a learner speed up or slow down the daily word count without wiping
// their existing progress — previously the only way to change pace was to
// reset the whole app.
function openPaceSettings() {
  let modal = document.getElementById('pace-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pace-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);';
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:28px;max-width:380px;width:min(90vw,380px);box-shadow:var(--shadow);text-align:center;">
      <h3 style="color:var(--accent);font-size:14px;letter-spacing:1px;margin-bottom:16px;">ТЕМП ОБУЧЕНИЯ</h3>
      <div style="font-size:13px;color:var(--text2);margin-bottom:14px;">Новых слов в уроке: <b id="pace-val" style="color:var(--accent)">${STATE.wordsPerDay}</b></div>
      <input type="range" class="slider" id="pace-slider" min="5" max="30" value="${STATE.wordsPerDay}" style="width:100%;margin-bottom:8px;">
      <div style="font-size:11px;color:var(--text3);margin-bottom:20px;">Меньше слов — спокойнее темп, меньше усталости. Больше — быстрее пройдёте курс.</div>
      <div style="display:flex;gap:8px;">
        <button data-action="close-pace-settings" style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;">Отмена</button>
        <button data-action="save-pace-settings" style="flex:1;background:var(--accent);color:#0d0d10;border:none;padding:10px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-weight:700;">Сохранить</button>
      </div>
    </div>
  `;
  document.getElementById('pace-slider').addEventListener('input', e => {
    document.getElementById('pace-val').textContent = e.target.value;
  });
}

function savePaceSettings() {
  const slider = document.getElementById('pace-slider');
  if (!slider) return;
  const val = parseInt(slider.value, 10);
  const newWpd = Math.max(5, Math.min(30, Number.isFinite(val) ? val : STATE.wordsPerDay));

  if (newWpd !== STATE.wordsPerDay) {
    // Lesson boundaries are entirely re-sliced whenever wordsPerDay changes, so
    // STATE.currentLesson (a plain index into that slicing) points at a
    // different, unrelated range of words after the change — silently
    // skipping some words or re-showing already-mastered ones as new. Convert
    // progress into an absolute "words reached" position under the OLD
    // grouping first, then find the lesson that contains that same position
    // under the NEW grouping, so progress carries over correctly.
    const oldLessons = getLessons();
    const oldCurrent = oldLessons[Math.min(STATE.currentLesson, oldLessons.length - 1)];
    const wordsReached = oldCurrent ? oldCurrent.blockStart : STATE.skipCount;

    STATE.wordsPerDay = newWpd;
    const newLessons = getLessons();
    let newIdx = newLessons.findIndex(l => wordsReached < l.blockEnd);
    if (newIdx === -1) newIdx = newLessons.length - 1;
    STATE.currentLesson = Math.max(0, newIdx);
  }

  saveState();
  document.getElementById('pace-modal')?.remove();
  showToast(`Темп обновлён: ${STATE.wordsPerDay} слов/урок`);
  updateTodayTab();
}

let dictFilter = 0;   // 0=all, 1/2/3=HSK level, 10=known
let dictSort   = 'level';
let dictMode   = 'list';
let listenQueue = [];
let listenIdx   = 0;

function initDictTab() {
  renderDict();
}

function setDictFilter(lvl, el) {
  dictFilter = lvl;
  document.querySelectorAll('.dict-filter').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderDict();
}

function setDictSort(sort, el) {
  dictSort = sort;
  document.querySelectorAll('.dict-sort').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderDict();
}

function setDictMode(mode) {
  dictMode = mode;
  document.getElementById('dmode-list').classList.toggle('active', mode==='list');
  document.getElementById('dmode-listen').classList.toggle('active', mode==='listen');
  document.getElementById('dict-list-view').style.display   = mode==='list'   ? 'block' : 'none';
  document.getElementById('dict-listen-view').style.display = mode==='listen' ? 'flex'  : 'none';
  if (mode==='listen') initListenMode();
}

function clearDictSearch() {
  document.getElementById('dict-search').value = '';
  document.getElementById('dict-clear').style.display = 'none';
  renderDict();
}

function getWordStatus(wi) {
  const p = STATE.progress[wi];
  if (!p) return 'new';
  if (p.totalWrong > p.totalRight) return 'hard';
  if (p.totalRight >= 1) return 'known';
  return 'learning';
}

function renderDict() {
  const q = document.getElementById('dict-search').value.trim().toLowerCase();
  document.getElementById('dict-clear').style.display = q ? 'inline-block' : 'none';

  let words = DICTIONARY.map((w, i) => ({...w, wi: i}));
  if (dictFilter === 10) {
    words = words.filter(w => getWordStatus(w.wi) === 'known');
  } else if (dictFilter > 0) {
    words = words.filter(w => w.l === dictFilter);
  }
  if (q) {
    words = words.filter(w =>
      w.h.includes(q) ||
      w.p.toLowerCase().includes(q) ||
      w.t.toLowerCase().includes(q)
    );
  }

  if (dictSort === 'alpha') {
    words.sort((a,b) => a.p.localeCompare(b.p));
  } else if (dictSort === 'status') {
    const order = {hard:0, learning:1, new:2, known:3};
    words.sort((a,b) => (order[getWordStatus(a.wi)]||0) - (order[getWordStatus(b.wi)]||0));
  } else {
    words.sort((a,b) => a.l - b.l || a.wi - b.wi);
  }

  document.getElementById('dict-count').textContent = `${words.length} слов`;
  const container = document.getElementById('dict-words');
  container.innerHTML = '';

  if (words.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text3);padding:40px;font-size:14px;">Ничего не найдено</div>';
    return;
  }

  if (dictSort === 'level' && !q && dictFilter === 0) {
    [1,2,3].forEach(lvl => {
      const group = words.filter(w => w.l === lvl);
      if (!group.length) return;
      const hdr = document.createElement('div');
      hdr.className = 'dict-level-group';
      hdr.innerHTML = `<div class="dict-level-header">HSK${lvl} · ${group.length} слов</div>`;
      group.forEach(w => hdr.appendChild(makeWordRow(w)));
      container.appendChild(hdr);
    });
  } else {
    words.forEach(w => container.appendChild(makeWordRow(w)));
  }
}

function makeWordRow(w) {
  const status = getWordStatus(w.wi);
  const dotClass = {new:'dot-new', learning:'dot-learning', known:'dot-known', hard:'dot-hard'}[status];
  const rowClass = status === 'known' ? 'known' : status === 'hard' ? 'hard' : '';
  const div = document.createElement('div');
  div.className = `dict-word-row ${rowClass}`;
  div.innerHTML = `
    <div>
      <div class="dict-hanzi">${w.h}</div>
    </div>
    <div>
      <div class="dict-pinyin">${w.p}</div>
    </div>
    <div class="dict-translation">${w.t}</div>
    <div class="dict-status">
      <span class="dict-status-dot ${dotClass}" title="${status}"></span>
      <span class="dict-speak-icon" title="Произнести">🔊</span>
    </div>
  `;
  div.querySelector('.dict-speak-icon').onclick = (e) => { e.stopPropagation(); speakWord(w.h); };
  div.onclick = () => showWordDetail(w);
  return div;
}

function showWordDetail(w) {
  const status = getWordStatus(w.wi);
  const p = STATE.progress[w.wi];
  const statusLabel = {new:'Новое',learning:'Изучается',known:'Изучено ✓',hard:'Сложное ⚠️'}[status];
  const details = p ? `Правильно: ${p.totalRight} · Ошибок: ${p.totalWrong} · Интервал: ${p.interval} дн` : 'Ещё не изучалось';

  let modal = document.getElementById('word-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'word-detail-modal';
    modal.style.cssText = `position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);`;
    modal.onclick = (e) => { if(e.target===modal) modal.remove(); };
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:32px 28px;max-width:560px;width:min(92vw,560px);box-shadow:var(--shadow);">
      <div style="text-align:center;">
        <div style="font-family:'Noto Sans SC',serif;font-size:72px;color:var(--text);cursor:pointer;line-height:1" onclick="speakWord('${w.h}')">${w.h}</div>
        <div style="font-size:20px;color:var(--accent2);font-style:italic;margin:10px 0">${w.p}</div>
        <div style="font-size:16px;color:var(--text);margin-bottom:12px">${w.t}</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px">HSK${w.l} · ${statusLabel}</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:20px">${details}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="speakWord('${w.h}')" style="flex:1 1 150px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:13px;">🔊 Озвучить</button>
        <button id="word-detail-etymology-btn" onclick="toggleWordDetailEtymology('${w.h}')" style="flex:1 1 170px;background:none;border:1px dashed rgba(124,158,248,0.4);color:var(--accent3);padding:10px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:13px;">🧩 Происхождение</button>
        <button onclick="document.getElementById('word-detail-modal').remove()" style="flex:1 1 120px;background:var(--accent);color:#0d0d10;border:none;padding:10px;border-radius:var(--radius-sm);cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;">Закрыть</button>
      </div>
      <div id="word-detail-etymology" class="decomp-panel" style="display:none;margin-top:14px;"></div>
    </div>
  `;
}

function toggleWordDetailEtymology(word) {
  const panel = document.getElementById('word-detail-etymology');
  const btn = document.getElementById('word-detail-etymology-btn');
  if (!panel || !btn) return;
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    btn.textContent = '🧩 Происхождение';
    return;
  }
  renderEtymologyContent(panel, word);
  btn.textContent = '🧩 Скрыть разбор';
}

function initListenMode() {

  let words = DICTIONARY.map((w,i) => ({...w,wi:i}));
  if (dictFilter === 10) words = words.filter(w => getWordStatus(w.wi)==='known');
  else if (dictFilter > 0) words = words.filter(w => w.l === dictFilter);
  else {

    words = words.filter(w => STATE.progress[w.wi]);
    if (words.length === 0) words = DICTIONARY.slice(0, 20).map((w,i)=>({...w,wi:i}));
  }
  listenQueue = words;
  listenIdx = 0;
  const startBtn = document.getElementById('listen-start-btn');
  startBtn.style.display = 'block';
  document.getElementById('listen-hanzi').textContent = '';
  document.getElementById('listen-pinyin').textContent = '';
  document.getElementById('listen-translation').style.display = 'none';
  document.getElementById('listen-pos').textContent = `0 / ${listenQueue.length}`;
  document.getElementById('listen-status').textContent =
    `${listenQueue.length} слов выбрано · Нажмите "Начать"`;
}

function startListenSession() {
  if (listenQueue.length === 0) { showToast('Нет слов для тренировки.'); return; }
  listenQueue = shuffle([...listenQueue]);
  listenIdx = 0;
  document.getElementById('listen-start-btn').style.display = 'none';
  showListenCard();
}

function showListenCard() {
  if (listenIdx >= listenQueue.length) {
    document.getElementById('listen-status').textContent = '✓ Тренировка завершена!';
    document.getElementById('listen-hanzi').textContent = '🎉';
    document.getElementById('listen-pinyin').textContent = '';
    document.getElementById('listen-translation').style.display = 'none';
    document.getElementById('listen-start-btn').textContent = '▶ Повторить';
    document.getElementById('listen-start-btn').style.display = 'block';
    return;
  }
  const w = listenQueue[listenIdx];
  document.getElementById('listen-hanzi').textContent = w.h;
  document.getElementById('listen-pinyin').textContent = w.p;
  document.getElementById('listen-translation').style.display = 'none';
  document.getElementById('listen-translation').textContent = w.t;
  document.getElementById('listen-pos').textContent = `${listenIdx+1} / ${listenQueue.length}`;
  document.getElementById('listen-status').textContent = `HSK${w.l} · слушай и повторяй`;
  speakWord(w.h);
}

function listenReveal() {
  document.getElementById('listen-translation').style.display = 'block';
}

function listenSpeak() {
  const w = listenQueue[listenIdx];
  if (w) speakWord(w.h);
}

function listenNext() {
  listenIdx = Math.min(listenIdx+1, listenQueue.length);
  showListenCard();
}

function listenPrev() {
  listenIdx = Math.max(0, listenIdx-1);
  showListenCard();
}

async function init() {
  try {
    await loadAppData();
  } catch (error) {
    showBootstrapError(error);
    return;
  }

  loadState();
  normalizeState();
  bindStaticEvents();
  refreshSpeechVoices();
  renderCloudTtsToggle();
  renderGeminiKeySettings();
  renderTypingModeToggle();
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = refreshSpeechVoices;
  }
  updateDaysSlider(setupDays);

  if (STATE) {
    showMainScreen();
    return;
  }

  document.getElementById('screen-setup').classList.add('active');
  document.getElementById('screen-main').classList.remove('active');
}

init();
