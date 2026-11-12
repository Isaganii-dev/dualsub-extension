const $ = (id) => document.getElementById(id);
const FIELDS = ['enabled', 'primary', 'secondary', 'order', 'sizePrimary', 'sizeSecondary', 'colorPrimary', 'colorSecondary', 'bg', 'bottom', 'pauseOnHover'];
let settings = { ...DS_DEFAULTS };
let langSig = null;

function fillSelect(sel, fixed, langs, current) {
  sel.innerHTML = '';
  const seen = new Set();
  for (const [v, label] of fixed) { sel.add(new Option(label, v)); seen.add(v); }
  for (const l of langs) if (!seen.has(l.code)) { seen.add(l.code); sel.add(new Option(l.name + ' (' + l.code + ')', l.code)); }
  if (!seen.has(current)) sel.add(new Option(current, current));
  sel.value = current;
}

function fillLanguages(langs) {
  const sig = JSON.stringify(langs);
  if (sig === langSig) return;
  langSig = sig;
  fillSelect($('primary'), [['__original__', 'Original language']], langs, settings.primary);
  fillSelect($('secondary'), [['__none__', 'None']], langs, settings.secondary);
}

async function refresh() {
  let state = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state = await chrome.tabs.sendMessage(tab.id, { type: 'getState' });
  } catch (_) {}
  if (!state) {
    $('status').textContent = 'Open a YouTube or Netflix video, then reopen this popup.';
    fillLanguages([]);
    return;
  }
  $('status').textContent = state.status;
  fillLanguages((state.info && state.info.languages) || []);
}

(async function init() {
  settings = { ...DS_DEFAULTS, ...(await chrome.storage.local.get(DS_DEFAULTS)) };
  fillLanguages([]);
  for (const id of FIELDS) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!settings[id]; else el.value = settings[id];
    el.addEventListener('input', () => {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      settings[id] = v;
      chrome.storage.local.set({ [id]: v });
    });
  }
  refresh();
  setInterval(refresh, 1000);
})();
