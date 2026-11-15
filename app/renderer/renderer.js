'use strict';
/* Renderer: presentation only. Talks to the Core through window.vvc
   (invoke(channel, payload) -> {ok, data|error}, onEvent(cb), windowControl(action)).
   No inference and no application logic here. All visible text comes from
   strings.js so the UI language is independent of the conversation language. */
(() => {
  const api = window.vvc;
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const model = {
    conv: { state: 'LISTENING', hearing: false, transcribing: false, micMode: 'off', historyTurns: 0, maxHistoryTurns: 10, sessionId: 1 },
    statuses: {},
    config: null,
    language: null,
    languages: [],
    characters: null,
    turns: [],
    definitions: [],
    summary: null,
    devices: null,
    devicesLoading: false,
    page: 'chat',
    resourceTimer: null,
    logLines: [],
    avatar: null,     // avatarInfo(): photo, animation engine, where speech is heard
    photoKey: null,   // which photo the stage shows (path|exists)
  };

  // ----------------------------------------------------------------- i18n --
  let dict = window.VVC_STRINGS.ru;
  function t(key, vars) {
    let s = dict[key];
    if (s === undefined) s = window.VVC_STRINGS.ru[key];
    if (s === undefined) return key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  }
  function applyI18n() {
    for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
    for (const n of document.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
    for (const n of document.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
    $('transcript').dataset.empty = t('chat.empty');
  }
  function setUiLanguage(code) {
    dict = window.VVC_STRINGS[code] || window.VVC_STRINGS.ru;
    document.documentElement.lang = window.VVC_STRINGS[code] ? code : 'ru';
    applyI18n();
  }

  // ---------------------------------------------------------------- theme --
  const THEMES = ['system', 'light', 'dark'];
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  let theme = 'system';
  function applyTheme(next) {
    theme = THEMES.includes(next) ? next : 'system';
    const light = theme === 'light' || (theme === 'system' && systemLight.matches);
    document.body.classList.toggle('light', light);
    document.body.dataset.theme = theme;
    $('themeToggle').textContent = t(`theme.${theme}`);
  }
  systemLight.addEventListener('change', () => applyTheme(theme));

  // -------------------------------------------------------------- helpers --
  let bannerTimer = null;
  function showBanner(text, ms = 9000) {
    const b = $('banner');
    b.textContent = text;
    b.classList.remove('hidden');
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
  }

  async function call(channel, payload) {
    let res;
    try {
      res = await api.invoke(channel, payload);
    } catch (err) {
      showBanner(t('error.request', { channel, error: err.message }));
      return null;
    }
    if (!res || !res.ok) {
      showBanner(res && res.error ? res.error : t('error.noResponse', { channel }));
      return null;
    }
    return res.data;
  }

  function fmt(value, key) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    if (key === 'llmTokensPerSec') return value.toFixed(1);
    return String(Math.round(value));
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function combined(...list) {
    const present = list.filter(Boolean);
    if (!present.length) return { state: 'loading', detail: '' };
    for (const state of ['error', 'loading', 'stopped']) {
      const hit = present.find((s) => s.state === state);
      if (hit) return hit;
    }
    return present[0];
  }

  const stateText = (state) => t(`status.${state}`);

  // -------------------------------------------------- state + status strip --
  /** Canonical display state (spec names); captions are localized separately. */
  function displayState() {
    const c = model.conv;
    if (c.state !== 'LISTENING') return c.state;
    if (c.micMode === 'off') return 'MIC OFF';
    if (c.hearing) return 'HEARING SPEECH';
    if (c.transcribing) return 'TRANSCRIBING';
    return 'LISTENING';
  }

  function renderState() {
    const shown = displayState();
    const badge = $('stateBadge');
    badge.textContent = shown === 'MIC OFF' ? 'READY · MIC OFF' : shown;
    badge.dataset.state = shown;
    badge.title = `core: ${model.conv.state}`;
    const pill = $('statePill');
    pill.textContent = t(`state.caption.${shown}`);
    pill.dataset.state = shown;

    const busy = model.conv.state !== 'LISTENING';
    $('sendBtn').disabled = busy || model.conv.transcribing;
    $('stopBtn').disabled = !busy;
    if ($('micMode').value !== model.conv.micMode) $('micMode').value = model.conv.micMode;
    $('sessionInfo').textContent = t('chat.session', { id: model.conv.sessionId, n: model.conv.historyTurns, max: model.conv.maxHistoryTurns });

    let hint = t('chat.hint.off');
    if (model.conv.micMode === 'full') hint = busy ? t('chat.hint.busy') : t('chat.hint.full');
    if (model.conv.micMode === 'stt_only') hint = t('chat.hint.stt_only');
    $('micHint').textContent = hint;
    if (model.conv.micMode === 'off' || busy) $('micLevel').style.width = '0%';
    // the photo stage shows the conversation state (the animation engine will animate it)
    $('photoStage').dataset.state = shown;
    renderStatusStrip();
  }

  function chip(name, status, textOverride) {
    const c = el('div', 'chip');
    c.dataset.state = status.state;
    c.dataset.component = name;
    c.title = status.detail || '';
    c.append(el('span', 'dot'), el('span', 'name', name), el('span', 'text', textOverride || stateText(status.state)));
    return c;
  }

  function renderStatusStrip() {
    const s = model.statuses;
    const strip = $('statusStrip');
    strip.textContent = '';
    const mic = combined(s.mic, s.vad);
    let micText;
    if (mic.state === 'ready') {
      if (model.conv.micMode === 'off') micText = t('status.mic.off');
      else if (model.conv.state === 'LISTENING') micText = model.conv.hearing ? t('status.mic.hearing') : t('status.mic.listening');
      else micText = t('status.mic.paused');
    }
    strip.append(
      chip('MIC', mic, micText),
      chip('STT', s.stt || { state: 'loading' }),
      chip('LLM', s.llm || { state: 'loading' }),
      chip('TTS', combined(s.tts, s.output)),
      chip('AVATAR', s.avatar || { state: 'not_configured', detail: '' }),
    );
  }

  // ----------------------------------------------------------------- chat --
  function whoLabel(m) {
    if (m.role === 'assistant') return assistantName();
    if (m.role === 'system') return t('chat.who.system');
    if (m.route === 'stt_only' || m.route === 'tts_only' || m.route === 'llm_only') return t(`chat.who.${m.route}`);
    return m.source === 'voice' ? t('chat.who.voice') : t('chat.who.typed');
  }

  function scrollTranscript() {
    const tr = $('transcript');
    tr.scrollTop = tr.scrollHeight;
  }

  function addMessage(m) {
    const tr = $('transcript');
    if (m.role === 'assistant') {
      const partial = tr.querySelector(`[data-partial="${m.turnId}"]`);
      if (partial) {
        partial.querySelector('.body').textContent = m.text;
        partial.classList.remove('partial');
        partial.removeAttribute('data-partial');
        scrollTranscript();
        return;
      }
    }
    const node = el('div', `msg ${m.role}`);
    node.append(el('span', 'who', whoLabel(m)), el('span', 'body', m.text));
    tr.append(node);
    scrollTranscript();
  }

  // --------------------------------------------------------------- avatar --
  // The photo the user talks to and the animation engine (none yet: the photo is static).
  const SPEECH_REASON_RU = [
    [/no photo-animation engine/, 'движок анимации не подключён'],
    [/cannot return/, 'голосовой сервис не умеет отдавать звук'],
  ];

  function renderAvatar() {
    const a = model.avatar;
    if (!a) return;
    const photo = a.photo;
    $('avatarPhotoName').textContent = photo ? photo.name : t('avatar.photo.none');
    $('avatarPhotoName').title = photo ? photo.path : '';
    $('avatarClearBtn').disabled = !photo;
    $('photoChooseBtn').textContent = t(photo ? 'photo.change' : 'photo.choose');
    const engine = a.engine || { state: 'not_configured', detail: '' };
    statusLine('avatarEngineState', engine, engine.state === 'not_configured' ? t('avatar.engine.none') : undefined);
    const sp = a.speech;
    if (sp) {
      put('cfgTtsOutput', sp.configured);
      let text = t('avatar.speech.state.local');
      if (sp.configured === 'avatar') {
        const reason = sp.blocker ? (SPEECH_REASON_RU.find(([re]) => re.test(sp.blocker)) || [null, sp.blocker])[1] : '';
        text = sp.blocker ? `${t('avatar.speech.state.fallback')}: ${reason}` : t('avatar.speech.state.avatar');
      }
      $('avatarSpeechState').textContent = text;
    }
    const key = photo ? `${photo.path}|${photo.exists}` : '';
    if (key !== model.photoKey) {
      model.photoKey = key;
      loadPhoto();
    }
  }

  /** Show the chosen photo on the stage (read by the core, passed as a data URL). */
  async function loadPhoto() {
    const img = $('photoImg');
    const photo = model.avatar && model.avatar.photo;
    const showEmpty = (text) => {
      img.removeAttribute('src');
      img.classList.add('hidden');
      $('photoEmpty').classList.remove('hidden');
      $('photoEmptyText').textContent = text;
    };
    if (!photo) { showEmpty(t('photo.empty')); return; }
    const data = await call('avatar:photo');
    if (!data || !data.dataUrl) { showEmpty(t('photo.missing', { path: photo.path })); return; }
    img.src = data.dataUrl;
    img.alt = photo.name;
    img.classList.remove('hidden');
    $('photoEmpty').classList.add('hidden');
  }

  async function choosePhoto() {
    const res = await call('avatar:choosePhoto');
    if (res && res.avatar) { model.avatar = res.avatar; renderAvatar(); }
  }

  async function clearPhoto() {
    const res = await call('avatar:clearPhoto');
    if (res) { model.avatar = res; renderAvatar(); }
  }

  function addDelta(d) {
    const tr = $('transcript');
    let node = tr.querySelector(`[data-partial="${d.turnId}"]`);
    if (!node) {
      node = el('div', 'msg assistant partial');
      node.dataset.partial = d.turnId;
      node.append(el('span', 'who', assistantName()), el('span', 'body', ''));
      tr.append(node);
    }
    node.querySelector('.body').textContent += d.text;
    scrollTranscript();
  }

  function settlePartial(turn) {
    const node = $('transcript').querySelector(`[data-partial="${turn.turnId}"]`);
    if (!node) return;
    node.classList.remove('partial');
    node.removeAttribute('data-partial');
    if (turn.outcome !== 'ok') node.querySelector('.who').textContent = `${assistantName()} (${turn.outcome})`;
  }

  function renderStt(s) {
    const text = $('sttText');
    if (!s) { text.textContent = '—'; text.classList.remove('rejected'); $('sttMeta').textContent = ''; return; }
    text.textContent = s.text || t('chat.recognized.none');
    text.classList.toggle('rejected', !s.accepted);
    const parts = [];
    if (Number.isFinite(s.sttMs)) parts.push(`${Math.round(s.sttMs)} мс`);
    if (!s.accepted && s.reason) parts.push(`${t('chat.recognized.ignored')}: ${s.reason}`);
    $('sttMeta').textContent = parts.length ? `(${parts.join(', ')})` : '';
  }

  function renderLastTurn() {
    const turn = model.turns[model.turns.length - 1];
    if (!turn) { $('lastTurn').textContent = t('chat.last.none'); return; }
    const d = turn.derived;
    $('lastTurn').textContent = t('chat.last', {
      perceived: fmt(d.perceivedLatencyMs), stt: fmt(d.sttFinalizeMs), ttft: fmt(d.llmTtftMs), tts: fmt(d.ttsFirstAudioMs),
    });
  }

  async function send() {
    const input = $('textInput');
    const text = input.value.trim();
    if (!text) return;
    const res = await call('chat:send', { text, route: $('routeSelect').value });
    if (!res) return;
    if (res.accepted) input.value = '';
    else showBanner(t('chat.notSent', { reason: res.reason }), 5000);
  }

  // ---------------------------------------------------- models + settings --
  function setOptions(select, options, value) {
    select.textContent = '';
    for (const [val, label] of options) {
      const o = el('option', '', label);
      o.value = val;
      select.append(o);
    }
    if (value !== undefined && value !== null && !options.some(([v]) => v === value)) {
      const o = el('option', '', `${value} (${t('models.unavailable')})`);
      o.value = value;
      select.append(o);
    }
    if (value !== undefined && value !== null) select.value = value;
  }

  function statusLine(id, status, text) {
    const node = $(id);
    const s = status || { state: 'loading', detail: '' };
    node.dataset.state = s.state;
    node.textContent = text || (s.state === 'ready' ? stateText('ready') : `${stateText(s.state)}${s.detail ? ` — ${s.detail}` : ''}`);
    node.title = s.detail || '';
  }

  function renderModelStatuses() {
    const s = model.statuses;
    statusLine('sttStatus', s.stt);
    statusLine('llmStatus', s.llm, s.llm && s.llm.state === 'ready' ? s.llm.selectedModel : undefined);
    statusLine('ttsStatus', combined(s.tts));
    const audio = combined(s.mic, s.output);
    statusLine('audioStatus', audio, audio.state === 'ready' && s.mic && s.mic.info && s.mic.info.hostApi ? `${stateText('ready')} · ${s.mic.info.hostApi}` : undefined);
    const name = model.language ? model.language.conversation.name : '';
    const note = name ? t('models.languageFrom', { name }) : '';
    $('sttLanguageNote').textContent = note;
    $('ttsLanguageNote').textContent = note;
  }

  function fillLlmModels() {
    const llm = model.statuses.llm || {};
    const options = [['', t('models.llm.auto')]];
    for (const m of llm.models || []) {
      if (m.type === 'embeddings' || /embed/i.test(m.id)) continue;
      options.push([m.id, `${m.id}${m.loaded ? ` (${t('models.llm.loaded')})` : ''}`]);
    }
    setOptions($('cfgLlmModel'), options, model.config.llm.model);
  }

  const voiceLabel = (v) => `${v.id} (${t(`models.voice.${v.gender}`)})`;

  /** Models page: the TTS model and the voice in use (the voice itself is chosen in the character profile). */
  function fillTts() {
    if (!model.language) return;
    $('cfgTtsModel').textContent = model.language.tts.modelId;
    const voice = (model.language.tts.voices || []).find((v) => v.id === model.language.tts.voice);
    const a = activeCharacter();
    $('ttsVoiceValue').textContent = `${voice ? voiceLabel(voice) : model.language.tts.voice}${a ? ` · ${a.displayName}` : ''}`;
  }

  function fillDevices() {
    const cfg = model.config;
    const d = model.devices || { inputs: [], outputs: [] };
    const opts = (list) => [['', t('settings.default')], ...list.map((x) => [x.name, `${x.name}${x.isDefault ? ` (${t('settings.isDefault')})` : ''}`])];
    setOptions($('cfgMic'), opts(d.inputs), cfg.audio.inputDevice);
    setOptions($('cfgOut'), opts(d.outputs), cfg.audio.outputDevice);
  }

  // ------------------------------------------------------------ character --
  // Settings → «Персонаж»: the form always shows the ACTIVE profile. Edits are
  // a draft until «Сохранить»; while there is a draft, the profile cannot be
  // switched, created, duplicated or deleted, so nothing is lost silently.
  const CHAR_FIELDS = ['charDisplayName', 'charName', 'charDescription', 'charVoice'];
  const charUi = { draftFor: null, note: null, previewing: false, deleteArmed: null, deleteArmedAt: 0, deleteTimer: null };
  const DELETE_CONFIRM_MIN_MS = 600;   // a double-click must not arm and confirm in one gesture
  const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();

  function activeCharacter() {
    const c = model.characters;
    if (!c) return null;
    return c.profiles.find((p) => p.id === c.activeId) || c.profiles[0] || null;
  }
  /** Who speaks in the transcript: the character's own name when she has one. */
  function assistantName() {
    const a = activeCharacter();
    return (a && a.characterName) || t('chat.who.assistant');
  }

  function characterDraft() {
    return {
      displayName: oneLine($('charDisplayName').value),
      characterName: oneLine($('charName').value),
      description: $('charDescription').value.trim(),
      voice: $('charVoice').value,
    };
  }

  /** What differs between the form and the stored active profile. */
  function characterDirty() {
    const c = model.characters;
    const a = activeCharacter();
    if (!c || !a || charUi.draftFor !== a.id) return { any: false, identity: false };
    const d = characterDraft();
    // a text field holds \n line ends only; compare like with like
    const identity = d.characterName !== a.characterName || (d.description || c.defaults.description) !== a.description.replace(/\r\n?/g, '\n').trim();
    const other = d.displayName !== a.displayName || d.voice !== a.voice.id;
    return { any: identity || other, identity };
  }

  function characterVoiceOptions(selected) {
    const c = model.characters;
    const voices = c.voices || [];
    const order = [...voices.filter((v) => v.gender === 'female'), ...voices.filter((v) => v.gender !== 'female')];
    const select = $('charVoice');
    setOptions(select, order.map((v) => [v.id, `${voiceLabel(v)}${v.id === c.defaults.voice ? ` · ${t('character.voice.default')}` : ''}`]), selected);
    // a voice the loaded model does not have cannot be chosen
    if (Array.isArray(c.voicesLoaded)) {
      for (const o of select.options) {
        if (c.voicesLoaded.includes(o.value)) continue;
        o.disabled = o.value !== selected;
        if (!o.textContent.includes(t('models.unavailable'))) o.textContent = `${o.textContent} (${t('models.unavailable')})`;
      }
    }
  }

  function setCharacterNote(text, state = '') {
    charUi.note = text ? { text, state } : null;
    updateCharacterControls();
  }

  function updateCharacterControls() {
    const c = model.characters;
    const a = activeCharacter();
    if (!c || !a) return;
    const dirty = characterDirty();
    const draft = characterDraft();
    $('charProfile').disabled = dirty.any;
    $('charNewBtn').disabled = dirty.any || c.profiles.length >= c.limits.profiles;
    $('charDuplicateBtn').disabled = dirty.any || c.profiles.length >= c.limits.profiles;
    $('charDeleteBtn').disabled = dirty.any || a.builtIn;
    $('charDeleteBtn').title = a.builtIn ? t('character.note.builtIn') : '';
    $('charDeleteBtn').textContent = t(charUi.deleteArmed === a.id ? 'character.delete.confirm' : 'character.delete');
    $('charSaveBtn').disabled = !dirty.any;
    $('charCancelBtn').disabled = !dirty.any;
    $('charResetDescriptionBtn').disabled = draft.description === '' || draft.description === c.defaults.description;
    $('charPreviewBtn').disabled = charUi.previewing || !draft.voice;
    $('charPreviewBtn').textContent = t(charUi.previewing ? 'character.previewing' : 'character.preview');
    const pill = $('characterState');
    pill.textContent = dirty.any ? t('character.state.dirty') : '';
    pill.dataset.state = dirty.any ? 'dirty' : 'saved';
    const note = $('characterNote');
    // the result of the last action; otherwise what the unsaved changes mean
    let shown = charUi.note;
    if (!shown && dirty.any) shown = { text: t(dirty.identity ? 'character.note.identity' : 'character.note.dirty'), state: '' };
    note.textContent = shown ? shown.text : '';
    note.dataset.state = shown ? shown.state : '';
  }

  /**
   * Show the stored profiles. The form is (re)filled from the active profile
   * when it is another profile than the one being edited, when asked to
   * (`force`: after save / cancel), or when there is no draft; a draft in
   * progress is never overwritten by an update from the Core.
   */
  function renderCharacters(force = false) {
    const c = model.characters;
    const a = activeCharacter();
    if (!c || !a) return;
    $('coreRules').textContent = c.coreInstructions;
    setOptions($('charProfile'), c.profiles.map((p) => [p.id, p.builtIn ? `${p.displayName} (${t('character.builtIn')})` : p.displayName]), a.id);
    $('charDisplayName').maxLength = c.limits.displayName;
    $('charName').maxLength = c.limits.characterName;
    $('charDescription').maxLength = c.limits.description;
    const sameProfile = charUi.draftFor === a.id;
    if (force || !sameProfile || !characterDirty().any) {
      const editing = (id) => !force && sameProfile && document.activeElement === $(id);
      if (!editing('charDisplayName')) $('charDisplayName').value = a.displayName;
      if (!editing('charName')) $('charName').value = a.characterName;
      if (!editing('charDescription')) $('charDescription').value = a.description;
      characterVoiceOptions(a.voice.id);
      charUi.draftFor = a.id;
      if (!sameProfile) charUi.deleteArmed = null;
    } else {
      characterVoiceOptions($('charVoice').value);
    }
    updateCharacterControls();
    fillTts();
  }

  /** Run a profile operation of the Core and show its result. Returns the result or null. */
  async function characterAction(channel, payload, noteOf) {
    const res = await call(channel, payload);
    if (!res) return null;
    model.characters = res.characters;
    charUi.note = null;
    renderCharacters(true);
    const a = activeCharacter();
    if (noteOf) setCharacterNote(noteOf(res, a));
    $('settingsNote').textContent = t('saved', { time: fmtTime(Date.now()).slice(0, 8) });
    return res;
  }

  async function saveCharacter() {
    const a = activeCharacter();
    if (!a) return;
    const d = characterDraft();
    if (!d.displayName && !a.builtIn) {
      setCharacterNote(t('character.error.name'), 'error');
      $('charDisplayName').focus();
      return;
    }
    const time = () => fmtTime(Date.now()).slice(0, 8);
    await characterAction('characters:save', { id: a.id, fields: { displayName: d.displayName, characterName: d.characterName, description: d.description, voice: d.voice } },
      (res) => t(res.sessionCleared ? 'character.note.savedNewSession' : 'character.note.saved', { time: time() }));
  }

  async function deleteCharacter() {
    const a = activeCharacter();
    if (!a || a.builtIn) return;
    clearTimeout(charUi.deleteTimer);
    if (charUi.deleteArmed !== a.id) {
      // first click only arms the button; the second one deletes
      charUi.deleteArmed = a.id;
      charUi.deleteArmedAt = Date.now();
      charUi.deleteTimer = setTimeout(() => { charUi.deleteArmed = null; updateCharacterControls(); }, 5000);
      updateCharacterControls();
      return;
    }
    if (Date.now() - charUi.deleteArmedAt < DELETE_CONFIRM_MIN_MS) {
      // the second half of a double-click: stay armed, the question has not been readable yet
      charUi.deleteTimer = setTimeout(() => { charUi.deleteArmed = null; updateCharacterControls(); }, 5000);
      return;
    }
    charUi.deleteArmed = null;
    await characterAction('characters:delete', { id: a.id }, (res, now) => t(res.sessionCleared ? 'character.note.deletedActive' : 'character.note.deleted', { name: now.displayName }));
  }

  async function previewCharacterVoice() {
    const voice = $('charVoice').value;
    if (!voice || charUi.previewing) return;
    charUi.previewing = true;
    charUi.note = null;
    updateCharacterControls();
    const res = await call('characters:previewVoice', { voice });
    charUi.previewing = false;
    if (!res) { updateCharacterControls(); return; }
    if (res.ok) setCharacterNote(t('character.note.preview', { voice: res.voice }));
    else if (res.busy) setCharacterNote(t('character.error.previewBusy'), 'error');
    else if (res.stopped) setCharacterNote('');
    else setCharacterNote(t('character.error.preview', { voice, error: res.error }), 'error');
  }

  /** Write a value into a control unless the user is editing it right now. */
  function put(id, value, prop = 'value') {
    const node = $(id);
    if (document.activeElement === node) return;
    node[prop] = value;
  }

  function fillForm() {
    const cfg = model.config;
    if (!cfg) return;
    put('cfgSttModel', cfg.stt.model);
    put('cfgSttDevice', cfg.stt.device);
    put('cfgSttCompute', cfg.stt.computeType);
    put('cfgLlmEndpoint', cfg.llm.endpoint);
    put('cfgLlmTemp', cfg.llm.temperature);
    put('cfgLlmMaxTokens', cfg.llm.maxTokens);
    put('cfgLlmNoThink', cfg.llm.disableThinking, 'checked');
    put('cfgTtsDevice', cfg.tts.device);
    put('cfgTtsStreaming', cfg.tts.sentenceStreaming, 'checked');
    put('cfgHistory', cfg.session.historyTurns);
    put('cfgVadSilence', cfg.vad.minSilenceMs);
    put('cfgPremiseCheck', cfg.conversation.premiseCheck === true, 'checked');
    put('cfgLengthVariation', cfg.conversation.lengthVariation === true, 'checked');
    put('cfgVadThreshold', cfg.vad.threshold);
    put('cfgVadMinSpeech', cfg.vad.minSpeechMs);
    setOptions($('cfgLanguage'), model.languages.map((l) => [l.code, l.name]), cfg.conversation.language);
    fillLlmModels();
    fillTts();
    fillDevices();
    renderCharacters();
  }

  /** Settings apply immediately: one control = one configuration key. */
  const SETTINGS = {
    cfgSttModel: (v) => ({ stt: { model: v } }),
    cfgSttDevice: (v) => ({ stt: { device: v } }),
    cfgSttCompute: (v) => ({ stt: { computeType: v } }),
    cfgLlmEndpoint: (v) => ({ llm: { endpoint: v.trim() } }),
    cfgLlmModel: (v) => ({ llm: { model: v } }),
    cfgLlmTemp: (v) => ({ llm: { temperature: Number(v) } }),
    cfgLlmMaxTokens: (v) => ({ llm: { maxTokens: Number(v) } }),
    cfgLlmNoThink: (v) => ({ llm: { disableThinking: v } }),
    cfgTtsDevice: (v) => ({ tts: { device: v } }),
    cfgTtsStreaming: (v) => ({ tts: { sentenceStreaming: v } }),
    cfgLanguage: (v) => ({ conversation: { language: v } }),
    cfgHistory: (v) => ({ session: { historyTurns: Number(v) } }),
    cfgPremiseCheck: (v) => ({ conversation: { premiseCheck: Boolean(v) } }),
    cfgLengthVariation: (v) => ({ conversation: { lengthVariation: Boolean(v) } }),
    cfgTtsOutput: (v) => ({ tts: { output: v } }),
    cfgVadSilence: (v) => ({ vad: { minSilenceMs: Number(v) } }),
    cfgVadThreshold: (v) => ({ vad: { threshold: Number(v) } }),
    cfgVadMinSpeech: (v) => ({ vad: { minSpeechMs: Number(v) } }),
    cfgMic: (v) => ({ audio: { inputDevice: v } }),
    cfgOut: (v) => ({ audio: { outputDevice: v } }),
  };

  async function applySetting(id) {
    const node = $(id);
    const value = node.type === 'checkbox' ? node.checked : node.value;
    const cfg = await call('config:update', SETTINGS[id](value));
    if (!cfg) return;
    model.config = cfg;
    node.blur();
    fillForm();
    const note = t('saved', { time: fmtTime(Date.now()).slice(0, 8) });
    $('modelsNote').textContent = note;
    $('settingsNote').textContent = note;
  }

  async function loadDevices(force = false) {
    if (model.devicesLoading || (model.devices && !force)) return;
    const mic = model.statuses.mic;
    const out = model.statuses.output;
    const serviceUp = [mic, out].some((s) => s && (s.state === 'ready' || (s.state === 'error' && !/not started|exited|not found|Cannot start|did not start/i.test(s.detail || ''))));
    if (!serviceUp && !force) return;
    model.devicesLoading = true;
    const res = await call('devices:list');
    model.devicesLoading = false;
    if (res) {
      model.devices = res;
      if (model.config) fillDevices();
    }
  }

  // ---------------------------------------------------------- diagnostics --
  const DEFAULT_COLUMNS = ['speechDurationMs', 'speechEndToSttFinalMs', 'llmFirstContentMs', 'ttsFirstAudioMs', 'perceivedLatencyMs', 'turnDurationMs'];
  const ALL_COLUMNS = ['speechDurationMs', 'vadEndDelayMs', 'sttFinalizeMs', 'llmTtftMs', 'llmFirstContentMs', 'llmTotalMs', 'llmTokensPerSec', 'ttsFirstAudioMs', 'ttsSynthTotalMs', 'playbackStartDelayMs', 'perceivedLatencyMs', 'turnDurationMs'];

  function stateCell(status) {
    const td = el('td', 'state-cell');
    td.dataset.state = status.state;
    td.append(el('span', 'dot'), document.createTextNode(stateText(status.state)));
    return td;
  }

  function renderRuntime() {
    const table = $('runtimeTable');
    table.textContent = '';
    for (const key of ['mic', 'vad', 'stt', 'llm', 'tts', 'output', 'avatar']) {
      const s = model.statuses[key] || { state: 'loading', detail: '' };
      const tr = el('tr');
      tr.append(el('td', '', t(`diag.rt.${key}`)), stateCell(s), el('td', 'detail', s.detail || ''));
      table.append(tr);
    }
    const c = model.conv;
    const tr = el('tr');
    const shown = displayState();
    tr.append(el('td', '', t('diag.rt.conversation')), el('td', 'state-cell', shown), el('td', 'detail', t('diag.rt.conv', { state: c.state, mic: c.micMode, n: c.rejectedInputs || 0 })));
    table.append(tr);
  }

  function renderLanguage() {
    const table = $('languageTable');
    table.textContent = '';
    const l = model.language;
    if (!l) return;
    const loaded = (v) => (v === null || v === undefined ? t('diag.lang.notLoaded') : `${t('diag.lang.loaded')}: ${v}`);
    const rows = [
      [t('diag.lang.conversation'), `${l.conversation.code}`, l.conversation.name],
      [t('diag.lang.stt'), l.stt.configured, loaded(l.stt.loaded)],
      [t('diag.lang.llm'), l.llm.instruction, ''],
      [t('diag.lang.tts'), `${l.tts.configured} / ${l.tts.voice}`, loaded(l.tts.loaded === null ? null : `${l.tts.loaded} / ${l.tts.voiceLoaded}`)],
    ];
    for (const [k, v, d] of rows) {
      const tr = el('tr');
      tr.append(el('td', '', k), el('td', 'state-cell', v), el('td', 'detail', d));
      table.append(tr);
    }
    const state = $('languageState');
    state.dataset.state = l.coherent ? 'ready' : 'error';
    state.textContent = l.coherent ? t('diag.lang.ok') : `${t('diag.lang.mismatch')}: ${l.mismatches.join('; ')}`;
    state.title = [...l.mismatches, ...l.notes].join('\n');
  }

  function renderSummary() {
    const mode = $('diagMode').value;
    const table = $('summaryTable');
    table.textContent = '';
    const data = model.summary && model.summary[mode];
    $('diagCount').textContent = data ? t('diag.count', { n: data.turns }) : '';
    const head = el('tr');
    for (const h of ['metric', 'n', 'median', 'min', 'max']) head.append(el('th', '', t(`diag.col.${h}`)));
    table.append(head);
    let rows = 0;
    if (data) {
      for (const def of model.definitions) {
        const s = data.intervals[def.key];
        if (!s || !s.n) continue;
        const key = def.key === 'perceivedLatencyMs';
        const unit = def.key === 'llmTokensPerSec' ? '' : ' мс';
        const tr = el('tr');
        tr.append(
          el('td', key ? 'key' : '', t(`metric.${def.key}`)),
          el('td', '', String(s.n)),
          el('td', key ? 'key' : '', fmt(s.median, def.key) + unit),
          el('td', '', fmt(s.min, def.key) + unit),
          el('td', '', fmt(s.max, def.key) + unit),
        );
        tr.title = def.def;
        table.append(tr);
        rows += 1;
      }
    }
    if (!rows) {
      const tr = el('tr');
      const td = el('td', 'muted', t('diag.noTurns'));
      td.colSpan = 5;
      tr.append(td);
      table.append(tr);
    }
  }

  function languageCell(turn) {
    const l = turn.counters.language;
    if (!l) return '—';
    return l.coherent ? l.conversation : `${l.conversation} ≠ STT ${l.stt} / TTS ${l.tts}`;
  }

  function renderTurns() {
    const columns = $('allColumns').checked ? ALL_COLUMNS : DEFAULT_COLUMNS;
    const table = $('turnTable');
    table.textContent = '';
    const head = el('tr');
    for (const h of ['turn', 'pipeline', 'result', 'language']) head.append(el('th', '', t(`diag.col.${h}`)));
    for (const key of columns) head.append(el('th', key === 'perceivedLatencyMs' ? 'key' : '', t(`metric.short.${key}`)));
    table.append(head);
    const turns = model.turns.slice(-60).reverse();
    for (const turn of turns) {
      const tr = el('tr', turn.outcome === 'ok' ? '' : 'bad');
      tr.dataset.turn = turn.turnId;
      tr.append(el('td', '', turn.turnId), el('td', '', t(`diag.mode.short.${turn.mode}`)), el('td', '', turn.outcome), el('td', '', languageCell(turn)));
      for (const key of columns) {
        let text = fmt(turn.derived[key], key);
        if (key === 'llmTokensPerSec' && turn.counters.llmTokensApproximate && text !== '—') text = `~${text}`;
        tr.append(el('td', key === 'perceivedLatencyMs' ? 'key' : '', text));
      }
      const hintLine = turn.counters.turnHints ? [t('diag.turnHints', { hints: turn.counters.turnHints })] : [];
      if (turn.notes.length || hintLine.length) tr.title = [...hintLine, ...turn.notes].join('\n');
      table.append(tr);
    }
    const notes = $('turnNotes');
    notes.textContent = '';
    const specific = (turn) => turn.notes.filter((n) => !n.startsWith('Playback start is approximate'));
    for (const turn of turns.filter((x) => specific(x).length).slice(0, 4)) {
      notes.append(el('div', '', `${turn.turnId}: ${specific(turn).join(' | ')}`));
    }
  }

  function renderDefinitions() {
    const dl = $('metricDefs');
    dl.textContent = '';
    for (const d of model.definitions) dl.append(el('dt', '', t(`metric.${d.key}`)), el('dd', '', d.def));
  }

  function appendLog(entry, scroll = true) {
    const log = $('eventLog');
    const line = `${fmtTime(entry.t)} [${entry.source}] ${entry.message}`;
    model.logLines.push(line);
    if (model.logLines.length > 500) model.logLines.shift();
    log.append(el('div', entry.level, line));
    while (log.childElementCount > 300) log.firstElementChild.remove();
    if (scroll) log.scrollTop = log.scrollHeight;
  }

  async function copyLogs() {
    const text = model.logLines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = el('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    $('copyLogs').textContent = t('diag.copied');
    setTimeout(() => { $('copyLogs').textContent = t('diag.copyLog'); }, 1500);
  }

  async function refreshDiagnostics() {
    const diag = await call('diag:get');
    if (!diag) return;
    model.turns = diag.turns;
    model.definitions = diag.definitions;
    model.summary = diag.summary;
    model.language = diag.language;
    renderRuntime();
    renderLanguage();
    renderSummary();
    renderTurns();
    renderDefinitions();
    renderLastTurn();
  }

  async function refreshResources() {
    const r = await call('diag:resources');
    const table = $('resourceTable');
    table.textContent = '';
    if (!r) return;
    const row = (k, v) => { const tr = el('tr'); tr.append(el('td', '', k), el('td', '', v)); table.append(tr); };
    row(t('diag.res.core'), `${r.coreRssMb} МБ`);
    const v = r.voice || {};
    row(t('diag.res.voice'), v.rssMb != null ? `${Math.round(v.rssMb)} МБ` : t('diag.res.unavailable'));
    if (Array.isArray(v.gpu) && v.gpu.length) {
      for (const g of v.gpu) row(g.name, t('diag.res.vram', { used: Math.round(g.memoryUsedMb), total: Math.round(g.memoryTotalMb), load: Math.round(g.utilizationPct) }));
    } else {
      row(t('diag.res.gpu'), t('diag.res.unavailable'));
    }
  }

  // ----------------------------------------------------------- navigation --
  function setPage(name) {
    model.page = name;
    for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.page === name);
    for (const p of document.querySelectorAll('.page')) p.classList.toggle('active', p.id === `page-${name}`);
    clearInterval(model.resourceTimer);
    model.resourceTimer = null;
    if (name === 'diagnostics') {
      refreshDiagnostics();
      refreshResources();
      model.resourceTimer = setInterval(refreshResources, 5000);
    }
    if (name === 'models' || name === 'settings') {
      renderModelStatuses();
      loadDevices();
    }
    if (name === 'chat') scrollTranscript();
  }

  // --------------------------------------------------------------- events --
  function onEvent({ type, payload }) {
    switch (type) {
      case 'state':
        model.conv = payload;
        renderState();
        if (model.page === 'diagnostics') renderRuntime();
        break;
      case 'status': {
        const before = model.statuses;
        model.statuses = payload;
        renderStatusStrip();
        renderModelStatuses();
        if (model.config && JSON.stringify((before.llm || {}).models) !== JSON.stringify((payload.llm || {}).models)) fillLlmModels();
        loadDevices();
        if (model.page === 'diagnostics') renderRuntime();
        break;
      }
      case 'language':
        model.language = payload;
        fillTts();
        renderModelStatuses();
        if (model.page === 'diagnostics') renderLanguage();
        break;
      case 'characters':
        // an update that is older than what a profile action has already returned is ignored
        if (model.characters && payload.revision < model.characters.revision) break;
        model.characters = payload;
        renderCharacters();
        break;
      case 'message': addMessage(payload); break;
      case 'avatar': model.avatar = payload; renderAvatar(); break;
      case 'assistantDelta': addDelta(payload); break;
      case 'stt': renderStt(payload); break;
      case 'turn':
        model.turns.push(payload);
        settlePartial(payload);
        renderLastTurn();
        if (model.page === 'diagnostics') refreshDiagnostics();
        break;
      case 'log': appendLog(payload); break;
      case 'level': {
        const pct = Math.min(100, Math.round(Math.sqrt(Math.max(0, payload.rms || 0)) * 260));
        $('micLevel').style.width = `${pct}%`;
        break;
      }
      case 'config':
        model.config = payload;
        if (payload.ui.theme !== theme) applyTheme(payload.ui.theme);
        fillForm();
        break;
      case 'sessionCleared':
        $('transcript').textContent = '';
        renderStt(null);
        break;
      case 'problem': showBanner(payload.message); break;
      case 'rejected':
        if (payload.source === 'voice') showBanner(t('chat.voiceIgnored', { reason: payload.reason }), 4000);
        break;
      default: break;
    }
  }

  // ----------------------------------------------------------------- init --
  function bind() {
    $('photoChooseBtn').addEventListener('click', choosePhoto);
    $('avatarChooseBtn').addEventListener('click', choosePhoto);
    $('avatarClearBtn').addEventListener('click', clearPhoto);
    for (const b of document.querySelectorAll('.nav-item')) b.addEventListener('click', () => setPage(b.dataset.page));
    for (const b of document.querySelectorAll('[data-window-action]')) {
      b.addEventListener('click', () => { if (api.windowControl) api.windowControl(b.dataset.windowAction); });
    }
    $('themeToggle').addEventListener('click', async () => {
      const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      applyTheme(next);
      await call('config:update', { ui: { theme: next } });
    });
    $('banner').addEventListener('click', () => $('banner').classList.add('hidden'));
    $('sendBtn').addEventListener('click', send);
    $('textInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!$('sendBtn').disabled) send(); }
    });
    $('stopBtn').addEventListener('click', () => call('chat:stop'));
    $('clearBtn').addEventListener('click', () => call('chat:clear'));
    $('micMode').addEventListener('change', (e) => call('mic:setMode', { mode: e.target.value }));
    $('diagMode').addEventListener('change', renderSummary);
    $('allColumns').addEventListener('change', renderTurns);
    $('logsHeader').addEventListener('click', () => $('eventLog').classList.toggle('visible'));
    $('copyLogs').addEventListener('click', copyLogs);
    $('exportBtn').addEventListener('click', async () => {
      const res = await call('diag:export');
      if (res) $('exportResult').textContent = t('diag.exported', { file: res.file });
    });
    $('llmRefreshBtn').addEventListener('click', async () => {
      const endpoint = $('cfgLlmEndpoint').value.trim();
      if (model.config && endpoint && endpoint !== model.config.llm.endpoint) await applySetting('cfgLlmEndpoint');
      await call('llm:refresh');
    });
    $('devicesRefreshBtn').addEventListener('click', () => loadDevices(true));
    $('restartVoiceBtn').addEventListener('click', async () => {
      $('restartResult').textContent = t('settings.restarting');
      const res = await call('voice:restart');
      $('restartResult').textContent = res && res.ok ? t('settings.restarted') : t('settings.restartFailed');
      model.devices = null;
    });
    $('charProfile').addEventListener('change', (e) => characterAction('characters:select', { id: e.target.value },
      (res, a) => (res.sessionCleared ? t('character.note.switched', { name: a.displayName }) : '')));
    $('charNewBtn').addEventListener('click', async () => {
      const res = await characterAction('characters:create', {}, (r, a) => t('character.note.switched', { name: a.displayName }));
      if (res) { $('charDisplayName').focus(); $('charDisplayName').select(); }
    });
    $('charDuplicateBtn').addEventListener('click', () => {
      const a = activeCharacter();
      if (a) characterAction('characters:duplicate', { id: a.id }, (r, now) => t('character.note.switched', { name: now.displayName }));
    });
    $('charDeleteBtn').addEventListener('click', deleteCharacter);
    $('charSaveBtn').addEventListener('click', saveCharacter);
    $('charCancelBtn').addEventListener('click', () => { charUi.note = null; renderCharacters(true); });
    $('charResetDescriptionBtn').addEventListener('click', () => {
      if (!model.characters) return;
      $('charDescription').value = model.characters.defaults.description;
      charUi.note = null;
      updateCharacterControls();
    });
    $('charPreviewBtn').addEventListener('click', previewCharacterVoice);
    for (const id of CHAR_FIELDS) {
      const edited = () => { charUi.note = null; updateCharacterControls(); };
      $(id).addEventListener('input', edited);
      $(id).addEventListener('change', edited);
    }
    for (const id of Object.keys(SETTINGS)) $(id).addEventListener('change', () => applySetting(id));
  }

  async function init() {
    applyI18n();
    applyTheme('system');
    bind();
    api.onEvent(onEvent);
    const snap = await call('app:snapshot');
    if (snap) {
      model.conv = snap.conversation;
      model.statuses = snap.statuses;
      model.config = snap.config;
      model.language = snap.language;
      model.languages = snap.languages;
      model.characters = snap.characters;
      model.avatar = snap.avatar || null;
      setUiLanguage(snap.config.ui.language);
      applyTheme(snap.config.ui.theme);
      $('transcript').textContent = '';
      for (const m of snap.messages) addMessage(m);
      renderStt(snap.lastStt);
      fillForm();
    }
    renderState();
    renderModelStatuses();
    renderAvatar();
    const diag = await call('diag:get');
    if (diag) {
      model.turns = diag.turns;
      model.definitions = diag.definitions;
      model.summary = diag.summary;
      for (const entry of diag.log) appendLog(entry, false);
    }
    renderLastTurn();
    loadDevices();
  }

  init();
})();
