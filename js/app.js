import {
  agendaDB,
  formatDateISO,
  minutesToHHMM,
  hhmmToMinutes
} from './db.js';
import {
  VoiceNoteRecorder,
  processVoiceNoteWithAI
} from './ai-pipeline.js';

const START_HOUR = 7;   // 07:00
const END_HOUR = 22;    // 22:00
const START_MIN = START_HOUR * 60; // 420
const END_MIN = END_HOUR * 60;     // 1320
const WIND_DOWN_START = 20 * 60;   // 1200 (20:00)
const PX_PER_HOUR = 68;
const PX_PER_MIN = PX_PER_HOUR / 60;

export const CATEGORIES = [
  {
    id: 'Investigação',
    label: 'investigação',
    cssClass: 'cat-investigacao',
    swatch: '#B9C5AE'
  },
  {
    id: 'Trabalho',
    label: 'trabalho',
    cssClass: 'cat-trabalho',
    swatch: '#D8C8AE'
  },
  {
    id: 'Escrita',
    label: 'escrita',
    cssClass: 'cat-escrita',
    swatch: '#EAE0CE'
  },
  {
    id: 'Exercício Mental',
    label: 'exercício mental',
    cssClass: 'cat-exercicio-mental',
    swatch: '#CFCAC0'
  },
  {
    id: 'Leitura',
    label: 'leitura',
    cssClass: 'cat-leitura',
    swatch: '#CED3BC'
  }
];

const PT_MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

const PT_WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const PT_WEEKDAYS_FULL = [
  'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sábado'
];

class WabiSabiCalendarApp {
  constructor() {
    this.selectedDate = new Date();
    this.viewMode = 'day'; // 'day' | 'month'
    this.routineRules = [];
    this.allCategoryBlocks = [];
    this.allVoiceNotes = [];

    // estado do bottom-sheet de categoria
    this.editingBlockId = null;
    this.draftCategory = 'Investigação';
    this.draftTaskName = '';
    this.draftRating = null;
    this.draftStartMin = 9 * 60;
    this.draftEndMin = 10 * 60 + 30;

    // estado do sheet de avaliação de fim de bloco (0 a 5 estrelas)
    this.ratingBlockId = null;
    this.pendingRatingValue = 4;

    // estado de long-press na timeline
    this.longPressTimer = null;
    this.longPressStartPos = null;
    this.ghostRange = null;

    // estado do gravador de voice notes
    this.recorder = null;
    this.isRecording = false;
    this.isProcessingVoice = false;
    this.activeVoiceNote = null;
    this.showTranscriptInModal = false;
    this.activeAudioElement = null;
    this.isPlayingAudio = false;

    this.init();
  }

  async init() {
    window.app = this;
    const todayStr = formatDateISO(this.selectedDate);
    await agendaDB.ensureSeedData(todayStr);
    await this.reloadData();
    this.setupNotificationListeners();
    this.render();
    this.checkFinishedBlocks();

    // Sincroniza com o Supabase em background sem bloquear a renderização inicial
    if (agendaDB.hasSupabase()) {
      agendaDB.syncFromSupabase().then(async (res) => {
        if (res?.ok) {
          await this.reloadData();
          this.render();
        }
      });
    }

    setInterval(() => {
      if (this.viewMode === 'day') this.renderTimeline();
      this.checkFinishedBlocks();
    }, 20000);
  }

  setupNotificationListeners() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'OPEN_RATING_SHEET' && event.data.blockId) {
          this.openRatingSheet(event.data.blockId);
        }
      });
    }
    const checkHash = () => {
      if (window.location.hash.startsWith('#rate=')) {
        const blockId = decodeURIComponent(window.location.hash.slice(6));
        window.history.replaceState(null, '', window.location.pathname);
        if (blockId) this.openRatingSheet(blockId);
      }
    };
    window.addEventListener('hashchange', checkHash);
    setTimeout(checkHash, 300);
  }

  renderDiscreteStars(rating) {
    if (rating === null || rating === undefined || rating === '') return '';
    const r = Math.max(0, Math.min(5, Number(rating)));
    let stars = '';
    for (let i = 1; i <= 5; i++) {
      stars += i <= r
        ? `<span class="opacity-80">★</span>`
        : `<span class="opacity-25">☆</span>`;
    }
    return `<span class="text-xs tracking-tight leading-none select-none" title="${r}/5">${stars}</span>`;
  }

  async checkFinishedBlocks() {
    const now = new Date();
    const todayStr = formatDateISO(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const todayBlocks = this.getCategoryBlocksForDate(todayStr);

    for (const b of todayBlocks) {
      const unrated = b.rating === null || b.rating === undefined;
      if (nowMins >= b.end_minutes && unrated && !b.notified_end) {
        b.notified_end = true;
        await agendaDB.saveCategoryBlock(b);
        await this.reloadData();
        this.triggerBlockEndNotification(b);
        this.openRatingSheet(b.id);
        break;
      }
    }
  }

  async triggerBlockEndNotification(block) {
    if (!('Notification' in window)) return;
    try {
      if (Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      if (Notification.permission === 'granted') {
        const title = `${block.category.toLowerCase()} concluída`;
        const body = `${block.task_name ? block.task_name + ' · ' : ''}avaliar bloco de 0 a 5 estrelas`;
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(title, {
            body,
            icon: './icons/icon.svg',
            tag: `rate-${block.id}`,
            data: { blockId: block.id }
          });
        } else {
          new Notification(title, { body });
        }
      }
    } catch (e) {}
  }

  openRatingSheet(blockId) {
    const block = this.allCategoryBlocks.find((b) => b.id === blockId);
    if (!block) return;
    this.ratingBlockId = block.id;
    this.pendingRatingValue = block.rating !== null && block.rating !== undefined ? Number(block.rating) : 4;
    this.renderRatingSheet();
    this.showSheet('rating-sheet');
  }

  setPendingRating(val) {
    this.pendingRatingValue = this.pendingRatingValue === val ? 0 : val;
    this.renderRatingSheet();
  }

  renderRatingSheet() {
    const container = document.getElementById('rating-sheet-content');
    if (!container) return;
    const block = this.allCategoryBlocks.find((b) => b.id === this.ratingBlockId);
    if (!block) return;
    const meta = this.getCategoryMeta(block.category);

    container.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="text-center mb-4">
        <span class="text-xs text-[#85796C] block mb-0.5">bloco concluído</span>
        <h3 class="font-serif-editorial text-2xl font-semibold text-[#231C17]">${meta.label}</h3>
        ${block.task_name ? `<p class="text-xs text-[#6E6256] mt-0.5">${block.task_name}</p>` : ''}
      </div>

      <div class="bg-[#F2ECE1] border border-[#DED6C6] rounded-2xl p-4 mb-4 flex flex-col items-center gap-3">
        <div class="flex items-center justify-center gap-2">
          ${[1, 2, 3, 4, 5].map((star) => {
            const filled = star <= this.pendingRatingValue;
            return `
              <button
                onclick="window.app.setPendingRating(${star})"
                class="tactile-btn w-11 h-11 rounded-xl flex items-center justify-center text-2xl transition-all ${
                  filled ? 'text-[#231C17] bg-[#EAE1D0]' : 'text-[#C5B9A5] bg-[#FAF7F0]'
                } border border-[#DED6C6]"
              >
                ★
              </button>
            `;
          }).join('')}
        </div>
        <span class="text-xs text-[#6E6256] font-mono">${this.pendingRatingValue} / 5 estrelas</span>
      </div>

      <button
        onclick="window.app.saveBlockRating()"
        class="tactile-btn w-full py-3 rounded-xl bg-[#231C17] text-[#FAF7F0] text-xs font-semibold"
      >
        guardar avaliação
      </button>
    `;
  }

  async saveBlockRating() {
    const block = this.allCategoryBlocks.find((b) => b.id === this.ratingBlockId);
    if (!block) return;
    block.rating = this.pendingRatingValue;
    block.notified_end = true;
    await agendaDB.saveCategoryBlock(block);
    await this.reloadData();
    this.closeAllSheets();
    this.render();
  }

  async reloadData() {
    const [rules, blocks, notes] = await Promise.all([
      agendaDB.getRoutineRules(),
      agendaDB.getAllCategoryBlocks(),
      agendaDB.getAllVoiceNotes()
    ]);
    this.routineRules = rules;
    this.allCategoryBlocks = blocks;
    this.allVoiceNotes = notes;
  }

  getSelectedDateStr() {
    return formatDateISO(this.selectedDate);
  }

  getActiveRoutineForDate(dateObj) {
    const dow = dateObj.getDay();
    return this.routineRules.filter(
      (r) => r.is_active !== false && Array.isArray(r.days_of_week) && r.days_of_week.includes(dow)
    );
  }

  getCategoryBlocksForDate(dateStr) {
    return this.allCategoryBlocks
      .filter((b) => b.date_str === dateStr)
      .sort((a, b) => a.start_minutes - b.start_minutes);
  }

  getVoiceNotesForDate(dateStr) {
    return this.allVoiceNotes
      .filter((vn) => vn.date_str === dateStr)
      .sort((a, b) => a.recorded_minutes - b.recorded_minutes);
  }

  getContextAtMinutes(dateObj, minutes) {
    const dateStr = formatDateISO(dateObj);
    const routines = this.getActiveRoutineForDate(dateObj);
    for (const r of routines) {
      if (minutes >= r.start_minutes && minutes <= r.end_minutes) {
        return `durante ${r.title.toLowerCase()}`;
      }
    }
    const cats = this.getCategoryBlocksForDate(dateStr);
    for (const c of cats) {
      if (minutes >= c.start_minutes && minutes <= c.end_minutes) {
        return `durante ${c.category.toLowerCase()}`;
      }
    }
    return 'intervalo livre';
  }

  snapIntervalAroundLockedBlocks(dateObj, desiredStart, desiredDuration = 60) {
    const routines = this.getActiveRoutineForDate(dateObj).sort(
      (a, b) => a.start_minutes - b.start_minutes
    );

    let start = Math.max(START_MIN, Math.min(WIND_DOWN_START - 15, desiredStart));
    start = Math.round(start / 15) * 15;

    for (const r of routines) {
      if (start >= r.start_minutes && start < r.end_minutes) {
        start = r.end_minutes;
      }
    }

    if (start >= WIND_DOWN_START) {
      start = 18 * 60;
    }

    let end = Math.min(WIND_DOWN_START, start + desiredDuration);

    for (const r of routines) {
      if (r.start_minutes > start && end > r.start_minutes) {
        end = r.start_minutes;
        break;
      }
    }

    if (end - start < 15) {
      end = Math.min(WIND_DOWN_START, start + 30);
    }

    return { start, end };
  }

  findRoutineConflict(dateObj, startMin, endMin) {
    const routines = this.getActiveRoutineForDate(dateObj);
    for (const r of routines) {
      const overlaps = startMin < r.end_minutes && endMin > r.start_minutes;
      if (overlaps) return r;
    }
    return null;
  }

  getCategoryMeta(catId) {
    return (
      CATEGORIES.find((c) => c.id.toLowerCase() === (catId || '').toLowerCase()) ||
      CATEGORIES[0]
    );
  }

  // ==========================================================================
  // RENDERIZAÇÃO PRINCIPAL
  // ==========================================================================
  render() {
    this.renderHeader();
    if (this.viewMode === 'day') {
      document.getElementById('day-view-container').classList.remove('hidden');
      document.getElementById('month-view-container').classList.add('hidden');
      this.renderTimeline();
    } else {
      document.getElementById('day-view-container').classList.add('hidden');
      document.getElementById('month-view-container').classList.remove('hidden');
      this.renderMonthView();
    }
    this.renderVoiceFab();
  }

  // Barra superior minimalista:
  // - Visão do mês: apenas mês e ano ("novembro 2026")
  // - Visão do dia: "< novembro" à esquerda + 3 dias (anterior, atual, seguinte) à direita no mesmo nível
  renderHeader() {
    const headerEl = document.getElementById('ios-header-root');
    if (!headerEl) return;

    const monthName = PT_MONTHS[this.selectedDate.getMonth()];
    const year = this.selectedDate.getFullYear();

    if (this.viewMode === 'month') {
      headerEl.innerHTML = `
        <div class="flex items-center justify-between py-2">
          <h1 class="font-serif-editorial text-3xl font-semibold tracking-tight text-[#231C17]">
            ${monthName} ${year}
          </h1>
        </div>
      `;
      return;
    }

    // Visão do dia: "< mês" à esquerda e os 3 dias (anterior, atual, seguinte) à direita no mesmo nível
    const todayStr = formatDateISO(new Date());
    const selStr = this.getSelectedDateStr();

    const threeDays = [-1, 0, 1].map((offset) => {
      const d = new Date(this.selectedDate);
      d.setDate(this.selectedDate.getDate() + offset);
      return d;
    });

    const pillsHtml = threeDays
      .map((d) => {
        const dStr = formatDateISO(d);
        const isSelected = dStr === selStr;
        const isToday = dStr === todayStr;
        const hasVoice = this.allVoiceNotes.some((vn) => vn.date_str === dStr);
        const hasCat = this.allCategoryBlocks.some((b) => b.date_str === dStr);

        return `
          <button
            onclick="window.app.selectDateISO('${dStr}')"
            class="week-day-pill tactile-btn flex flex-col items-center justify-center py-1.5 px-2.5 rounded-2xl ${
              isSelected ? 'selected' : isToday ? 'today' : 'text-[#4F4338] hover:bg-[#EAE3D5]'
            }"
          >
            <span class="text-xs opacity-75 font-medium">${PT_WEEKDAYS_SHORT[d.getDay()]}</span>
            <span class="font-serif-editorial text-lg font-semibold leading-tight mt-0.5">${d.getDate()}</span>
            <div class="flex items-center gap-1 mt-0.5 h-1.5">
              ${hasCat ? `<span class="w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-[#D6DFCE]' : 'bg-[#7A8870]'}"></span>` : ''}
              ${hasVoice ? `<span class="w-1.5 h-1.5 rounded-full bg-[#C85A3C]"></span>` : ''}
            </div>
          </button>
        `;
      })
      .join('');

    headerEl.innerHTML = `
      <div class="flex items-center justify-between gap-3">
        <button
          onclick="window.app.setViewMode('month')"
          class="tactile-btn flex items-center gap-1.5 py-1 text-[#231C17] hover:opacity-75"
        >
          <span class="text-xl leading-none font-light text-[#52463B]">&lt;</span>
          <span class="font-serif-editorial text-2xl font-semibold tracking-tight">${monthName}</span>
        </button>

        <div class="grid grid-cols-3 gap-1.5">
          ${pillsHtml}
        </div>
      </div>
    `;
  }

  renderTimeline() {
    const canvas = document.getElementById('timeline-canvas');
    if (!canvas) return;

    const dateStr = this.getSelectedDateStr();
    const routines = this.getActiveRoutineForDate(this.selectedDate);
    const categories = this.getCategoryBlocksForDate(dateStr);
    const voiceNotes = this.getVoiceNotesForDate(dateStr);

    let html = '';

    const now = new Date();
    const isToday = formatDateISO(now) === dateStr;
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const showNowIndicator = isToday && nowMins >= START_MIN && nowMins <= END_MIN;

    // 1. Linhas horárias das 07:00 às 22:00 (oculta o marcador de hora se a barra da hora atual coincidir)
    for (let h = START_HOUR; h <= END_HOUR; h++) {
      const topPx = (h - START_HOUR) * PX_PER_HOUR;
      const label = `${String(h).padStart(2, '0')}:00`;
      const overlapsNow = showNowIndicator && Math.abs(h * 60 - nowMins) <= 14;
      html += `
        <div class="hour-row" style="top: ${topPx}px;">
          <span class="hour-label ${overlapsNow ? 'opacity-0' : ''}">${label}</span>
          <div class="hour-line"></div>
        </div>
      `;
      if (h < END_HOUR) {
        const halfTop = topPx + PX_PER_HOUR / 2;
        html += `<div class="half-hour-line" style="top: ${halfTop}px;"></div>`;
      }
    }

    // 2. Ghost de long-press
    if (this.ghostRange) {
      const top = (this.ghostRange.start - START_MIN) * PX_PER_MIN;
      const height = Math.max(26, (this.ghostRange.end - this.ghostRange.start) * PX_PER_MIN);
      html += `
        <div class="long-press-ghost" style="top: ${top}px; height: ${height}px;">
          <span>+ novo bloco</span>
        </div>
      `;
    }

    // 3. Blocos de rotina fixa (não clicáveis, sem horas, sem subtítulo — articulados quando sequenciais)
    for (let i = 0; i < routines.length; i++) {
      const r = routines[i];
      const prev = routines[i - 1];
      const next = routines[i + 1];
      const hasPrev = Boolean(prev && prev.end_minutes === r.start_minutes);
      const hasNext = Boolean(next && r.end_minutes === next.start_minutes);

      let jointClass = '';
      if (!hasPrev && hasNext) jointClass = 'routine-joint-top';
      else if (hasPrev && hasNext) jointClass = 'routine-joint-mid';
      else if (hasPrev && !hasNext) jointClass = 'routine-joint-bottom';

      const topOffset = hasPrev ? 1.5 : 1;
      const bottomTrim = hasNext ? 1.5 : 1;
      const top = (r.start_minutes - START_MIN) * PX_PER_MIN + topOffset;
      const height = Math.max(26, (r.end_minutes - r.start_minutes) * PX_PER_MIN - (topOffset + bottomTrim));
      const durationMin = r.end_minutes - r.start_minutes;
      const isCompact = durationMin <= 35;

      html += `
        <div
          class="routine-block routine-tone-${r.tone || 'night'} ${jointClass}"
          style="top: ${top}px; height: ${height}px;"
        >
          ${jointClass ? `<span class="w-1 h-3.5 rounded-full bg-[#DAE2DB]/35 mr-2.5 shrink-0"></span>` : ''}
          <span class="font-serif-editorial ${isCompact ? 'text-base' : 'text-lg'} font-semibold tracking-tight truncate">
            ${r.title.toLowerCase()}
          </span>
        </div>
      `;
    }

    // 4. Blocos normais de categoria (avaliação discreta à frente do nome; nome/descrição da tarefa por baixo)
    for (const b of categories) {
      const top = (b.start_minutes - START_MIN) * PX_PER_MIN;
      const height = Math.max(32, (b.end_minutes - b.start_minutes) * PX_PER_MIN);
      const meta = this.getCategoryMeta(b.category);
      const taskDesc = (b.task_name || '').trim().toLowerCase();
      const starsHtml = this.renderDiscreteStars(b.rating);

      html += `
        <div
          onclick="event.stopPropagation(); window.app.openEditCategoryBlock('${b.id}')"
          class="category-block ${meta.cssClass}"
          style="top: ${top + 1}px; height: ${height - 2}px;"
        >
          <div class="flex flex-col justify-start">
            <div class="flex items-baseline gap-2">
              <span class="font-serif-editorial text-lg font-semibold leading-tight">${meta.label}</span>
              ${starsHtml}
            </div>
            ${taskDesc ? `<div class="text-xs opacity-80 mt-0.5 truncate">${taskDesc}</div>` : ''}
          </div>
        </div>
      `;
    }

    // 5. Marcas de voice notes (terracota quente) sobre o minuto exato
    for (const vn of voiceNotes) {
      const clampedMin = Math.max(START_MIN, Math.min(END_MIN, vn.recorded_minutes));
      const top = (clampedMin - START_MIN) * PX_PER_MIN;

      html += `
        <div class="voice-note-pin" style="top: ${top}px;">
          <div class="voice-note-dot"></div>
          <div class="voice-note-line"></div>
          <button
            onclick="event.stopPropagation(); window.app.openVoiceNoteModal('${vn.id}')"
            class="voice-note-pill"
          >
            <span class="w-2 h-2 rounded-full bg-[#FAF7F0] shrink-0"></span>
            <span class="font-mono text-xs opacity-90">${vn.recorded_time_label}</span>
            <span class="truncate font-serif-editorial italic text-sm">${(vn.poetic_title || '').toLowerCase()}</span>
          </button>
        </div>
      `;
    }

    // 6. Barra-ponteiro da hora atual (hora na coluna das horas, sobrepondo de forma limpa)
    if (showNowIndicator) {
      const nowTop = (nowMins - START_MIN) * PX_PER_MIN;
      html += `
        <div class="now-indicator" style="top: ${nowTop}px;">
          <span class="now-time-label">${minutesToHHMM(nowMins)}</span>
          <span class="now-time-dot"></span>
          <div class="now-time-line"></div>
        </div>
      `;
    }

    canvas.innerHTML = html;
    this.attachTimelineGestures(canvas);
  }

  attachTimelineGestures(canvas) {
    if (canvas.dataset.bound === 'true') return;
    canvas.dataset.bound = 'true';

    const getMinutesFromClientY = (clientY) => {
      const rect = canvas.getBoundingClientRect();
      const offsetY = Math.max(0, Math.min(rect.height, clientY - rect.top));
      const rawMinutes = START_MIN + offsetY / PX_PER_MIN;
      return Math.round(rawMinutes / 15) * 15;
    };

    const startPress = (clientX, clientY, target) => {
      if (
        target.closest('.category-block') ||
        target.closest('.routine-block') ||
        target.closest('.voice-note-pill')
      ) {
        return;
      }

      const pressedMin = getMinutesFromClientY(clientY);
      const conflict = this.findRoutineConflict(this.selectedDate, pressedMin, pressedMin + 15);
      if (conflict) return;

      this.longPressStartPos = { x: clientX, y: clientY };
      const snapped = this.snapIntervalAroundLockedBlocks(this.selectedDate, pressedMin, 60);

      this.longPressTimer = setTimeout(() => {
        this.ghostRange = snapped;
        if (navigator.vibrate) navigator.vibrate(18);
        this.renderTimeline();

        setTimeout(() => {
          this.ghostRange = null;
          this.renderTimeline();
          this.openNewCategorySheet(snapped.start, snapped.end);
        }, 220);
      }, 380);
    };

    const cancelPress = () => {
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
    };

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startPress(t.clientX, t.clientY, e.target);
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (!this.longPressStartPos || !e.touches[0]) return;
      const dx = Math.abs(e.touches[0].clientX - this.longPressStartPos.x);
      const dy = Math.abs(e.touches[0].clientY - this.longPressStartPos.y);
      if (dx > 12 || dy > 12) cancelPress();
    }, { passive: true });

    canvas.addEventListener('touchend', cancelPress);
    canvas.addEventListener('touchcancel', cancelPress);

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      startPress(e.clientX, e.clientY, e.target);
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!this.longPressStartPos) return;
      const dx = Math.abs(e.clientX - this.longPressStartPos.x);
      const dy = Math.abs(e.clientY - this.longPressStartPos.y);
      if (dx > 10 || dy > 10) cancelPress();
    });
    canvas.addEventListener('mouseup', cancelPress);
    canvas.addEventListener('mouseleave', cancelPress);

    canvas.addEventListener('dblclick', (e) => {
      if (
        e.target.closest('.category-block') ||
        e.target.closest('.routine-block') ||
        e.target.closest('.voice-note-pill')
      ) {
        return;
      }
      const mins = getMinutesFromClientY(e.clientY);
      const conflict = this.findRoutineConflict(this.selectedDate, mins, mins + 15);
      if (conflict) return;
      const snapped = this.snapIntervalAroundLockedBlocks(this.selectedDate, mins, 60);
      this.openNewCategorySheet(snapped.start, snapped.end);
    });
  }

  // ==========================================================================
  // VISTA MENSAL MINIMALISTA
  // - Clicar num dia seleciona-o; clicar no dia que JÁ está selecionado abre a visão do dia
  // - Preview inferior lista APENAS as voice notes com uma bolinha branca
  // ==========================================================================
  renderMonthView() {
    const gridEl = document.getElementById('month-calendar-grid');
    const summaryEl = document.getElementById('month-day-preview');
    if (!gridEl) return;

    const year = this.selectedDate.getFullYear();
    const month = this.selectedDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    const startOffset = (firstDay.getDay() + 6) % 7;
    const totalDays = lastDay.getDate();

    const todayStr = formatDateISO(new Date());
    const selStr = this.getSelectedDateStr();

    let html = '';
    for (let i = 0; i < startOffset; i++) {
      html += `<div class="h-14 rounded-xl bg-transparent"></div>`;
    }

    for (let day = 1; day <= totalDays; day++) {
      const d = new Date(year, month, day);
      const dStr = formatDateISO(d);
      const isSelected = dStr === selStr;
      const isToday = dStr === todayStr;
      const dayBlocks = this.getCategoryBlocksForDate(dStr);
      const dayVoices = this.getVoiceNotesForDate(dStr);

      html += `
        <button
          onclick="window.app.handleMonthDayClick('${dStr}')"
          class="tactile-btn h-14 rounded-xl p-1.5 flex flex-col items-center justify-between border transition-all ${
            isSelected
              ? 'bg-[#231C17] text-[#FAF7F0] border-[#231C17] shadow-md'
              : isToday
              ? 'bg-[#FAF7F0] text-[#C85A3C] border-[#C85A3C]'
              : 'bg-[#FAF7F0]/70 text-[#231C17] border-[#E4DDD0] hover:bg-[#EFEADE]'
          }"
        >
          <span class="font-serif-editorial text-base font-semibold">${day}</span>
          <div class="flex items-center justify-center gap-1 h-2">
            ${dayBlocks.slice(0, 3).map(() => `<span class="w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-[#D2DACB]' : 'bg-[#6D7F62]'}"></span>`).join('')}
            ${dayVoices.length > 0 ? `<span class="w-2 h-2 rounded-full bg-[#C85A3C]"></span>` : ''}
          </div>
        </button>
      `;
    }

    gridEl.innerHTML = html;

    if (summaryEl) {
      const voices = this.getVoiceNotesForDate(selStr);

      summaryEl.innerHTML = `
        <div class="border-b border-[#DED6C6] pb-2.5 mb-3">
          <h3 class="font-serif-editorial text-xl font-semibold text-[#231C17]">
            ${PT_WEEKDAYS_FULL[this.selectedDate.getDay()]}, ${this.selectedDate.getDate()} de ${PT_MONTHS[this.selectedDate.getMonth()]}
          </h3>
        </div>

        <div class="space-y-2">
          ${voices.map((vn) => `
            <div
              onclick="window.app.openVoiceNoteModal('${vn.id}')"
              class="cursor-pointer flex items-center justify-between p-3 rounded-xl bg-[#231C17] text-[#FAF7F0]"
            >
              <div class="flex items-center gap-3 truncate">
                <span class="w-2.5 h-2.5 rounded-full bg-[#FAF7F0] shrink-0"></span>
                <div class="truncate">
                  <div class="font-serif-editorial font-semibold text-base truncate">${(vn.poetic_title || '').toLowerCase()}</div>
                  <div class="text-xs opacity-75 truncate">${(vn.summary || '').toLowerCase()}</div>
                </div>
              </div>
              <span class="text-xs font-mono opacity-80 shrink-0 ml-2">${vn.recorded_time_label}</span>
            </div>
          `).join('')}

          ${voices.length === 0 ? `
            <div class="text-center py-4 text-xs text-[#85796C]">
              sem voice notes neste dia
            </div>
          ` : ''}
        </div>
      `;
    }
  }

  handleMonthDayClick(isoStr) {
    if (isoStr === this.getSelectedDateStr()) {
      // Clicar no dia que já está selecionado abre a visão do dia (como no iOS Calendar)
      this.setViewMode('day');
      return;
    }
    const [y, m, d] = isoStr.split('-').map(Number);
    this.selectedDate = new Date(y, m - 1, d);
    this.renderHeader();
    this.renderMonthView();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.render();
  }

  selectDateISO(isoStr) {
    const [y, m, d] = isoStr.split('-').map(Number);
    this.selectedDate = new Date(y, m - 1, d);
    this.render();
  }

  // ==========================================================================
  // BOTTOM-SHEET DE CONFIGURAÇÃO DE EVENTO (APENAS 5 CATEGORIAS, SEM NOME)
  // ==========================================================================
  openNewCategorySheet(startMin = null, endMin = null) {
    this.editingBlockId = null;
    this.draftCategory = 'Investigação';
    this.draftTaskName = '';
    this.draftRating = null;

    if (startMin === null) {
      const snapped = this.snapIntervalAroundLockedBlocks(this.selectedDate, 9 * 60, 90);
      this.draftStartMin = snapped.start;
      this.draftEndMin = snapped.end;
    } else {
      this.draftStartMin = startMin;
      this.draftEndMin = endMin || Math.min(WIND_DOWN_START, startMin + 60);
    }

    this.renderCategorySheet();
    this.showSheet('category-sheet');
  }

  openEditCategoryBlock(blockId) {
    const block = this.allCategoryBlocks.find((b) => b.id === blockId);
    if (!block) return;
    this.editingBlockId = block.id;
    this.draftCategory = block.category;
    this.draftTaskName = block.task_name || '';
    this.draftRating = block.rating !== undefined ? block.rating : null;
    this.draftStartMin = block.start_minutes;
    this.draftEndMin = block.end_minutes;

    this.renderCategorySheet();
    this.showSheet('category-sheet');
  }

  setDraftRating(val) {
    const inputEl = document.getElementById('draft-task-name-input');
    if (inputEl) this.draftTaskName = inputEl.value;
    this.draftRating = this.draftRating === val ? null : val;
    this.renderCategorySheet();
  }

  selectDraftCategory(catId) {
    const inputEl = document.getElementById('draft-task-name-input');
    if (inputEl) this.draftTaskName = inputEl.value;
    this.draftCategory = catId;
    this.renderCategorySheet();
  }

  applyQuickDuration(durationMins) {
    const inputEl = document.getElementById('draft-task-name-input');
    if (inputEl) this.draftTaskName = inputEl.value;
    const snapped = this.snapIntervalAroundLockedBlocks(
      this.selectedDate,
      this.draftStartMin,
      durationMins
    );
    this.draftStartMin = snapped.start;
    this.draftEndMin = snapped.end;
    this.renderCategorySheet();
  }

  onTimeInputChange(field, minsValue) {
    const inputEl = document.getElementById('draft-task-name-input');
    if (inputEl) this.draftTaskName = inputEl.value;
    const mins = typeof minsValue === 'number' ? minsValue : Number(minsValue);

    if (field === 'start') {
      const prevDur = Math.max(30, this.draftEndMin - this.draftStartMin);
      this.draftStartMin = mins;
      let desiredEnd = Math.min(WIND_DOWN_START, mins + prevDur);
      const routines = this.getActiveRoutineForDate(this.selectedDate).sort(
        (a, b) => a.start_minutes - b.start_minutes
      );
      for (const r of routines) {
        if (r.start_minutes > mins && desiredEnd > r.start_minutes) {
          desiredEnd = r.start_minutes;
          break;
        }
      }
      if (desiredEnd <= mins) {
        desiredEnd = Math.min(WIND_DOWN_START, mins + 30);
      }
      this.draftEndMin = desiredEnd;
    } else {
      this.draftEndMin = Math.max(this.draftStartMin + 15, Math.min(WIND_DOWN_START, mins));
    }
    this.renderCategorySheet();
  }

  getStartOptionsForDate(dateObj) {
    const routines = this.getActiveRoutineForDate(dateObj);
    const options = [];
    for (let m = START_MIN; m <= WIND_DOWN_START - 15; m += 15) {
      const locked = routines.find((r) => m >= r.start_minutes && m < r.end_minutes);
      options.push({
        mins: m,
        label: minutesToHHMM(m),
        disabled: Boolean(locked),
        lockedTitle: locked ? locked.title : null
      });
    }
    return options;
  }

  getEndOptionsForDate(dateObj, startMin) {
    const routines = this.getActiveRoutineForDate(dateObj).sort(
      (a, b) => a.start_minutes - b.start_minutes
    );
    let maxEnd = WIND_DOWN_START;
    for (const r of routines) {
      if (r.start_minutes > startMin) {
        maxEnd = Math.min(maxEnd, r.start_minutes);
        break;
      }
    }
    const options = [];
    for (let m = startMin + 15; m <= WIND_DOWN_START; m += 15) {
      options.push({
        mins: m,
        label: minutesToHHMM(m),
        disabled: m > maxEnd
      });
    }
    return options;
  }

  renderCategorySheet() {
    const container = document.getElementById('category-sheet-content');
    if (!container) return;

    const conflict = this.findRoutineConflict(
      this.selectedDate,
      this.draftStartMin,
      this.draftEndMin
    );

    const startOptions = this.getStartOptionsForDate(this.selectedDate);
    const endOptions = this.getEndOptionsForDate(this.selectedDate, this.draftStartMin);

    container.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="flex items-center justify-between border-b border-[#DED6C6] pb-3 mb-4">
        <button
          onclick="window.app.closeAllSheets()"
          class="text-xs font-medium text-[#786C5F] hover:text-[#231C17] px-2 py-1"
        >
          cancelar
        </button>
        <h3 class="font-serif-editorial text-xl font-semibold">${this.editingBlockId ? 'editar categoria' : 'nova categoria'}</h3>
        <button
          onclick="window.app.saveCategoryFromSheet()"
          class="tactile-btn px-3.5 py-1.5 rounded-full text-xs font-semibold bg-[#231C17] text-[#FAF7F0]"
        >
          guardar
        </button>
      </div>

      <!-- Campo para nome / descrição da tarefa -->
      <div class="mb-3.5">
        <input
          id="draft-task-name-input"
          type="text"
          placeholder="nome ou descrição da tarefa..."
          value="${(this.draftTaskName || '').replace(/"/g, '&quot;')}"
          oninput="window.app.draftTaskName = this.value"
          class="w-full px-3.5 py-2.5 rounded-xl bg-[#FAF7F0] border border-[#D4CBB9] text-sm text-[#231C17] placeholder-[#9A8E80] focus:outline-none focus:border-[#231C17]"
        />
      </div>

      <!-- Lista das 5 categorias sem subtítulos -->
      <div class="mb-4 space-y-2">
        ${CATEGORIES.map((cat) => {
          const active = this.draftCategory === cat.id;
          return `
            <div
              onclick="window.app.selectDraftCategory('${cat.id}')"
              class="category-choice-card flex items-center justify-between ${active ? 'active' : ''}"
            >
              <div class="flex items-center gap-3">
                <span class="w-3.5 h-3.5 rounded-full border border-black/15 shrink-0" style="background-color: ${cat.swatch};"></span>
                <div class="font-serif-editorial text-lg font-semibold leading-tight text-[#231C17]">${cat.label}</div>
              </div>
              <div class="w-5 h-5 rounded-full border flex items-center justify-center ${
                active ? 'border-[#231C17] bg-[#231C17] text-[#FAF7F0]' : 'border-[#C5B9A5]'
              }">
                ${active ? '✓' : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="bg-[#F2ECE1] border border-[#DED6C6] rounded-2xl p-3.5 mb-4">
        <div class="flex items-center justify-between mb-2.5">
          <span class="text-xs text-[#6E6256] font-medium">intervalo</span>
          <div class="flex gap-1.5">
            ${[45, 60, 90, 120].map((m) => `
              <button
                type="button"
                onclick="window.app.applyQuickDuration(${m})"
                class="px-2 py-0.5 rounded-md text-xs font-medium border ${
                  this.draftEndMin - this.draftStartMin === m
                    ? 'bg-[#231C17] text-[#FAF7F0] border-[#231C17]'
                    : 'bg-[#FAF7F0] text-[#52463B] border-[#D5CBB8]'
                }"
              >
                ${m >= 60 ? `${m / 60}h` : `${m}m`}
              </button>
            `).join('')}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="min-w-0">
            <label class="text-xs text-[#786C5F] block mb-1">início</label>
            <div class="relative flex items-center bg-[#FAF7F0] border border-[#D4CBB9] rounded-xl px-3 py-2.5">
              <select
                onchange="window.app.onTimeInputChange('start', Number(this.value))"
                class="appearance-none bg-transparent w-full text-sm font-mono font-medium text-[#231C17] focus:outline-none pr-5"
              >
                ${startOptions.map((opt) => `
                  <option
                    value="${opt.mins}"
                    ${opt.mins === this.draftStartMin ? 'selected' : ''}
                    ${opt.disabled ? 'disabled' : ''}
                  >
                    ${opt.label}${opt.lockedTitle ? ` (${opt.lockedTitle})` : ''}
                  </option>
                `).join('')}
              </select>
              <span class="pointer-events-none absolute right-3 text-xs text-[#786C5F]">▾</span>
            </div>
          </div>

          <div class="min-w-0">
            <label class="text-xs text-[#786C5F] block mb-1">fim</label>
            <div class="relative flex items-center bg-[#FAF7F0] border border-[#D4CBB9] rounded-xl px-3 py-2.5">
              <select
                onchange="window.app.onTimeInputChange('end', Number(this.value))"
                class="appearance-none bg-transparent w-full text-sm font-mono font-medium text-[#231C17] focus:outline-none pr-5"
              >
                ${endOptions.map((opt) => `
                  <option
                    value="${opt.mins}"
                    ${opt.mins === this.draftEndMin ? 'selected' : ''}
                    ${opt.disabled ? 'disabled' : ''}
                  >
                    ${opt.label}
                  </option>
                `).join('')}
              </select>
              <span class="pointer-events-none absolute right-3 text-xs text-[#786C5F]">▾</span>
            </div>
          </div>
        </div>

        ${conflict ? `
          <div class="mt-2.5 px-3 py-2 rounded-xl bg-[#C85A3C]/15 border border-[#C85A3C]/40 text-xs text-[#8E351D]">
            conflito com ${conflict.title}. será ajustado automaticamente.
          </div>
        ` : ''}
      </div>

      <!-- Avaliação retrospetiva -->
      <div class="bg-[#F2ECE1] border border-[#DED6C6] rounded-2xl p-3.5 mb-4 flex items-center justify-between">
        <span class="text-xs text-[#6E6256] font-medium">avaliação</span>
        <div class="flex items-center gap-1.5">
          ${[1, 2, 3, 4, 5].map((star) => {
            const filled = this.draftRating !== null && this.draftRating >= star;
            return `
              <button
                onclick="window.app.setDraftRating(${star})"
                class="w-8 h-8 rounded-lg flex items-center justify-center text-base border ${
                  filled
                    ? 'bg-[#231C17] text-[#FAF7F0] border-[#231C17]'
                    : 'bg-[#FAF7F0] text-[#B8AC9C] border-[#D5CBB8]'
                }"
              >★</button>
            `;
          }).join('')}
        </div>
      </div>

      ${this.editingBlockId ? `
        <button
          onclick="window.app.deleteCurrentCategoryBlock()"
          class="w-full py-2.5 rounded-xl border border-[#C85A3C]/50 text-[#A9452A] text-xs font-semibold hover:bg-[#C85A3C]/10 transition-all"
        >
          remover bloco
        </button>
      ` : ''}
    `;
  }

  async saveCategoryFromSheet() {
    const inputEl = document.getElementById('draft-task-name-input');
    if (inputEl) this.draftTaskName = inputEl.value;

    let start = this.draftStartMin;
    let end = this.draftEndMin;

    const conflict = this.findRoutineConflict(this.selectedDate, start, end);
    if (conflict) {
      const snapped = this.snapIntervalAroundLockedBlocks(
        this.selectedDate,
        start,
        Math.max(30, end - start)
      );
      start = snapped.start;
      end = snapped.end;
    }

    const finalConflict = this.findRoutineConflict(this.selectedDate, start, end);
    if (finalConflict) {
      this.showToast(`horário reservado para ${finalConflict.title}`);
      return;
    }

    const dateStr = this.getSelectedDateStr();
    const existing = this.editingBlockId
      ? this.allCategoryBlocks.find((b) => b.id === this.editingBlockId)
      : null;

    const block = {
      id: this.editingBlockId || `cat-${dateStr}-${Date.now()}`,
      date_str: dateStr,
      category: this.draftCategory,
      task_name: (this.draftTaskName || '').trim().toLowerCase(),
      rating: this.draftRating !== undefined ? this.draftRating : (existing?.rating ?? null),
      notified_end: existing?.notified_end || (this.draftRating !== null && this.draftRating !== undefined),
      start_minutes: start,
      end_minutes: end
    };

    await agendaDB.saveCategoryBlock(block);
    await this.reloadData();
    this.closeAllSheets();
    this.render();
  }

  async deleteCurrentCategoryBlock() {
    if (!this.editingBlockId) return;
    await agendaDB.deleteCategoryBlock(this.editingBlockId);
    await this.reloadData();
    this.closeAllSheets();
    this.render();
  }

  // ==========================================================================
  // VOICE NOTES:
  // - Apenas ícone do microfone dentro de um círculo redondo
  // - Quando a gravação está ativa, escurece todo o ecrã exceto o botão redondo,
  //   que agora fica só com o quadrado branco
  // ==========================================================================
  renderVoiceFab() {
    const container = document.getElementById('voice-fab-root');
    const dimOverlay = document.getElementById('recording-dim-overlay');
    if (!container) return;

    if (dimOverlay) {
      if (this.isRecording || this.isProcessingVoice) {
        dimOverlay.classList.add('active');
      } else {
        dimOverlay.classList.remove('active');
      }
    }

    if (this.isProcessingVoice) {
      container.innerHTML = `
        <button class="voice-fab recording" disabled>
          <svg class="w-5 h-5 animate-spin text-[#FFF9F5]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
        </button>
      `;
      return;
    }

    if (this.isRecording) {
      container.innerHTML = `
        <button
          onclick="window.app.toggleVoiceRecording()"
          class="voice-fab recording"
          aria-label="parar gravação"
        >
          <span class="w-4 h-4 rounded-[3px] bg-[#FFF9F5]"></span>
        </button>
      `;
      return;
    }

    container.innerHTML = `
      <button
        onclick="window.app.toggleVoiceRecording()"
        class="voice-fab"
        aria-label="gravar nota de voz"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" x2="12" y1="19" y2="22"/>
        </svg>
      </button>
    `;
  }

  async toggleVoiceRecording() {
    if (this.isProcessingVoice) return;

    if (!this.isRecording) {
      this.isRecording = true;
      if (navigator.vibrate) navigator.vibrate(15);
      this.recorder = new VoiceNoteRecorder();
      await this.recorder.start();
      this.renderVoiceFab();
      return;
    }

    this.isRecording = false;
    this.isProcessingVoice = true;
    if (navigator.vibrate) navigator.vibrate([15, 40, 20]);
    this.renderVoiceFab();

    const recResult = await this.recorder.stop();

    const now = new Date();
    let recMinutes = now.getHours() * 60 + now.getMinutes();
    if (recMinutes < START_MIN || recMinutes > END_MIN) {
      recMinutes = 11 * 60 + 15;
    }
    const timeLabel = minutesToHHMM(recMinutes);
    const dateStr = this.getSelectedDateStr();
    const contextBlock = this.getContextAtMinutes(this.selectedDate, recMinutes);

    const aiResult = await processVoiceNoteWithAI({
      audioBlob: recResult.audioBlob,
      audioDataUrl: recResult.audioDataUrl,
      audioMime: recResult.audioMime,
      liveSpeechTranscript: recResult.liveSpeechTranscript,
      contextBlock,
      recordedTimeLabel: timeLabel,
      settings: agendaDB.settings
    });

    const newNote = {
      id: `vn-${dateStr}-${Date.now()}`,
      date_str: dateStr,
      recorded_minutes: recMinutes,
      recorded_time_label: timeLabel,
      duration_seconds: recResult.durationSeconds,
      context_block: contextBlock,
      poetic_title: aiResult.poetic_title,
      summary: aiResult.summary,
      key_points: aiResult.key_points || [],
      transcript: aiResult.transcript,
      audio_data_url: recResult.audioDataUrl,
      audio_mime: recResult.audioMime,
      created_at: new Date().toISOString()
    };

    const saved = await agendaDB.saveVoiceNote(newNote, recResult.audioBlob);
    await this.reloadData();

    this.isProcessingVoice = false;
    this.render();
    this.openVoiceNoteModal(saved.id);
  }

  openVoiceNoteModal(noteId) {
    const vn = this.allVoiceNotes.find((n) => n.id === noteId);
    if (!vn) return;
    this.activeVoiceNote = vn;
    this.showTranscriptInModal = false;
    this.stopAudioPlayback();
    this.renderVoiceNoteModal();
    this.showSheet('voicenote-sheet');
  }

  toggleTranscriptInModal() {
    this.showTranscriptInModal = !this.showTranscriptInModal;
    this.renderVoiceNoteModal();
  }

  togglePlayVoiceNoteAudio() {
    if (!this.activeVoiceNote) return;

    if (this.isPlayingAudio) {
      this.stopAudioPlayback();
      this.renderVoiceNoteModal();
      return;
    }

    const src = this.activeVoiceNote.audio_data_url || this.activeVoiceNote.audio_url;
    if (src) {
      this.activeAudioElement = new Audio(src);
      this.isPlayingAudio = true;
      this.renderVoiceNoteModal();
      this.activeAudioElement.onended = () => {
        this.isPlayingAudio = false;
        this.renderVoiceNoteModal();
      };
      this.activeAudioElement.onerror = () => {
        this.isPlayingAudio = false;
        this.speakTranscriptFallback(this.activeVoiceNote.transcript);
      };
      this.activeAudioElement.play().catch(() => {
        this.speakTranscriptFallback(this.activeVoiceNote.transcript);
      });
    } else {
      this.speakTranscriptFallback(this.activeVoiceNote.transcript);
    }
  }

  speakTranscriptFallback(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'pt-PT';
    utter.rate = 0.98;
    this.isPlayingAudio = true;
    this.renderVoiceNoteModal();
    utter.onend = () => {
      this.isPlayingAudio = false;
      this.renderVoiceNoteModal();
    };
    window.speechSynthesis.speak(utter);
  }

  stopAudioPlayback() {
    if (this.activeAudioElement) {
      try { this.activeAudioElement.pause(); } catch (e) {}
      this.activeAudioElement = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.isPlayingAudio = false;
  }

  async deleteActiveVoiceNote() {
    if (!this.activeVoiceNote) return;
    this.stopAudioPlayback();
    await agendaDB.deleteVoiceNote(this.activeVoiceNote.id);
    await this.reloadData();
    this.closeAllSheets();
    this.render();
  }

  // Ecrã da síntese limpo:
  // - Sem "EDITORIAL AI"
  // - Sem "Whisper"
  // - Sem botão "Fechar"
  renderVoiceNoteModal() {
    const container = document.getElementById('voicenote-sheet-content');
    if (!container || !this.activeVoiceNote) return;

    const vn = this.activeVoiceNote;
    const keyPoints = Array.isArray(vn.key_points) ? vn.key_points : [];

    container.innerHTML = `
      <div class="sheet-handle"></div>

      <div class="flex items-center gap-2 border-b border-[#DED6C6] pb-3 mb-4">
        <span class="w-2.5 h-2.5 rounded-full bg-[#C85A3C]"></span>
        <span class="text-xs font-mono font-semibold text-[#A9452A]">${vn.recorded_time_label}</span>
        <span class="text-xs px-2.5 py-0.5 rounded-full bg-[#EAE3D5] text-[#52463B] font-medium">${(vn.context_block || '').toLowerCase()}</span>
      </div>

      <div class="bg-[#F4EFE4] border border-[#DFD6C5] rounded-2xl p-4 mb-4">
        <h3 class="font-serif-editorial text-2xl font-semibold italic text-[#231C17] leading-snug mb-2">
          “${(vn.poetic_title || '').toLowerCase()}”
        </h3>
        <p class="text-sm text-[#3E342B] leading-relaxed mb-3.5">
          ${(vn.summary || '').toLowerCase()}
        </p>

        ${keyPoints.length > 0 ? `
          <div class="border-t border-[#E2D9C8] pt-3">
            <ul class="space-y-1.5">
              ${keyPoints.map((pt) => `
                <li class="flex items-start gap-2 text-xs text-[#382F27]">
                  <span class="text-[#C85A3C] mt-0.5">•</span>
                  <span>${String(pt).toLowerCase()}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}
      </div>

      <div class="flex items-center justify-between gap-2 bg-[#FAF7F0] border border-[#DED6C6] rounded-2xl p-3 mb-3">
        <button
          onclick="window.app.togglePlayVoiceNoteAudio()"
          class="tactile-btn flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-[#231C17] text-[#FAF7F0] text-xs font-medium"
        >
          <span>${this.isPlayingAudio ? '⏹ parar áudio' : '▶ ouvir gravação'}</span>
          <span class="font-mono opacity-75">(${vn.duration_seconds || 18}s)</span>
        </button>

        <button
          onclick="window.app.toggleTranscriptInModal()"
          class="tactile-btn px-3 py-2 rounded-xl border border-[#D4CBB9] text-xs font-medium text-[#52463B] hover:bg-[#EFEADE]"
        >
          ${this.showTranscriptInModal ? 'ocultar transcrição' : 'ver transcrição'}
        </button>
      </div>

      ${this.showTranscriptInModal ? `
        <div class="bg-[#EFEADE] border border-[#DED6C6] rounded-xl p-3.5 mb-3 text-xs text-[#463B31] leading-relaxed">
          “${(vn.transcript || '').toLowerCase()}”
        </div>
      ` : ''}

      <div class="flex items-center justify-end pt-1">
        <button
          onclick="window.app.deleteActiveVoiceNote()"
          class="text-xs text-[#A9452A] hover:underline font-medium"
        >
          eliminar voice note
        </button>
      </div>
    `;
  }

  // ==========================================================================
  // GESTÃO DE BOTTOM-SHEETS & TOASTS
  // ==========================================================================
  showSheet(sheetId) {
    document.getElementById('sheet-backdrop')?.classList.add('open');
    document.querySelectorAll('.bottom-sheet').forEach((el) => el.classList.remove('open'));
    document.getElementById(sheetId)?.classList.add('open');
  }

  closeAllSheets() {
    this.stopAudioPlayback();
    document.getElementById('sheet-backdrop')?.classList.remove('open');
    document.querySelectorAll('.bottom-sheet').forEach((el) => el.classList.remove('open'));
  }

  showToast(message) {
    const toast = document.getElementById('wabi-toast');
    if (!toast) return;
    toast.textContent = message.toLowerCase();
    toast.classList.remove('opacity-0', 'translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-4');
      toast.classList.remove('opacity-100', 'translate-y-0');
    }, 2400);
  }
}

function bootApp() {
  if (!window.app) {
    new WabiSabiCalendarApp();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}
