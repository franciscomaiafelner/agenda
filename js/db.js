import { ENV_CONFIG } from './config.js';

const IDB_NAME = 'ma_wabi_sabi_agenda_db';
const IDB_VERSION = 1;

export const DEFAULT_ROUTINE_RULES = [
  {
    id: 'routine-passeio',
    title: 'passeio',
    subtitle: '',
    tone: 'night',
    start_minutes: 7 * 60,       // 07:00
    end_minutes: 7 * 60 + 30,    // 07:30
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    marker_minutes: null,
    marker_label: null,
    is_active: true
  },
  {
    id: 'routine-reflexao',
    title: 'reflexão',
    subtitle: '',
    tone: 'night',
    start_minutes: 7 * 60 + 30,  // 07:30
    end_minutes: 8 * 60 + 30,    // 08:30
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    marker_minutes: null,
    marker_label: null,
    is_active: true
  },
  {
    id: 'routine-meditacao',
    title: 'meditação',
    subtitle: '',
    tone: 'night',
    start_minutes: 8 * 60 + 30,  // 08:30
    end_minutes: 9 * 60,         // 09:00
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    marker_minutes: null,
    marker_label: null,
    is_active: true
  },
  {
    id: 'routine-faculdade-seg-qua',
    title: 'aulas da faculdade',
    subtitle: '',
    tone: 'stone',
    start_minutes: 10 * 60 + 30, // 10:30
    end_minutes: 12 * 60 + 30,   // 12:30
    days_of_week: [1, 3, 5],
    marker_minutes: null,
    marker_label: null,
    is_active: true
  },
  {
    id: 'routine-muay-thai',
    title: 'muay thai',
    subtitle: '',
    tone: 'leather',
    start_minutes: 13 * 60 + 30, // 13:30
    end_minutes: 15 * 60,        // 15:00
    days_of_week: [1, 2, 3, 4, 5, 6], // exceto domingos
    marker_minutes: null,
    marker_label: null,
    is_active: true
  },
  {
    id: 'routine-wind-down',
    title: 'wind down',
    subtitle: '',
    tone: 'night',
    start_minutes: 20 * 60,      // 20:00
    end_minutes: 22 * 60,        // 22:00
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    marker_minutes: null,
    marker_label: null,
    is_active: true
  }
];

export function formatDateISO(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function minutesToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

class AgendaDatabase {
  constructor() {
    this.dbPromise = this.initIDB();
    this.settings = this.loadSettings();
  }

  loadSettings() {
    let stored = {};
    try {
      const raw = localStorage.getItem('ma_wabi_sabi_settings');
      if (raw) stored = JSON.parse(raw);
    } catch (e) {}

    return {
      supabaseUrl: ENV_CONFIG.SUPABASE_URL || stored.supabaseUrl || '',
      supabaseAnonKey: ENV_CONFIG.SUPABASE_ANON_KEY || stored.supabaseAnonKey || '',
      aiProvider: ENV_CONFIG.AI_PROVIDER || stored.aiProvider || 'gemini',
      apiKey: ENV_CONFIG.GEMINI_API_KEY || ENV_CONFIG.OPENAI_OR_GROQ_API_KEY || stored.apiKey || '',
      whisperLanguage: stored.whisperLanguage || 'pt'
    };
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    localStorage.setItem('ma_wabi_sabi_settings', JSON.stringify(this.settings));
    return this.settings;
  }

  hasSupabase() {
    return Boolean(
      this.settings.supabaseUrl &&
      this.settings.supabaseUrl.startsWith('http') &&
      this.settings.supabaseAnonKey
    );
  }

  initIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('category_blocks')) {
          const store = db.createObjectStore('category_blocks', { keyPath: 'id' });
          store.createIndex('by_date', 'date_str', { unique: false });
        }
        if (!db.objectStoreNames.contains('routine_rules')) {
          db.createObjectStore('routine_rules', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('voice_notes')) {
          const vnStore = db.createObjectStore('voice_notes', { keyPath: 'id' });
          vnStore.createIndex('by_date', 'date_str', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async idbGetAll(storeName) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async idbPut(storeName, item) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });
  }

  async idbDelete(storeName, id) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async ensureSeedData(todayStr) {
    // Atualiza sempre as regras de rotina fixa sem marcador de café nem subtítulo
    for (const rule of DEFAULT_ROUTINE_RULES) {
      await this.idbPut('routine_rules', rule);
    }

    const seededFlag = localStorage.getItem('ma_wabi_sabi_seeded_v4');
    if (!seededFlag) {
      const sampleBlocks = [
        {
          id: `cat-${todayStr}-0900`,
          date_str: todayStr,
          category: 'Investigação',
          task_name: 'revisão de fontes primárias',
          start_minutes: 9 * 60,
          end_minutes: 10 * 60 + 30,
          rating: 4,
          notified_end: true
        },
        {
          id: `cat-${todayStr}-1530`,
          date_str: todayStr,
          category: 'Escrita',
          task_name: 'rascunho do capítulo metodológico',
          start_minutes: 15 * 60 + 30,
          end_minutes: 17 * 60 + 30,
          rating: null,
          notified_end: false
        },
        {
          id: `cat-${todayStr}-1800`,
          date_str: todayStr,
          category: 'Leitura',
          task_name: 'estudo lento e notas de margem',
          start_minutes: 18 * 60,
          end_minutes: 19 * 60 + 30,
          rating: null,
          notified_end: false
        }
      ];
      for (const b of sampleBlocks) {
        await this.idbPut('category_blocks', b);
      }

      const sampleVoiceNote = {
        id: `vn-${todayStr}-0942`,
        date_str: todayStr,
        recorded_minutes: 9 * 60 + 42,
        recorded_time_label: '09:42',
        duration_seconds: 28,
        context_block: 'durante investigação',
        poetic_title: 'arquitetura do silêncio funcional',
        summary: 'a restrição deliberada de escolhas liberta a atenção para a profundidade do pensamento. focar a revisão bibliográfica apenas em três fontes primárias antes do treino.',
        key_points: [
          'isolar as três referências centrais do capítulo metodológico',
          'sintetizar notas à mão antes de abrir o rascunho de escrita das 15:30',
          'testar hipótese sobre ritmos ultradianos na sessão de amanhã'
        ],
        transcript: 'estava aqui a pensar durante a leitura dos artigos que quando tentamos abranger demasiadas fontes ao mesmo tempo perdemos o fio condutor. vou isolar apenas as três referências centrais do capítulo metodológico e sintetizar as notas à mão antes do bloco das 15:30.',
        audio_url: null,
        audio_data_url: null,
        synced_cloud: false,
        created_at: new Date().toISOString()
      };
      await this.idbPut('voice_notes', sampleVoiceNote);
      localStorage.setItem('ma_wabi_sabi_seeded_v4', 'true');
    }
  }

  supabaseHeaders(extra = {}) {
    const key = this.settings.supabaseAnonKey.trim();
    return {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  supabaseRestUrl(table, query = '') {
    const base = this.settings.supabaseUrl.trim().replace(/\/+$/, '');
    return `${base}/rest/v1/${table}${query ? `?${query}` : ''}`;
  }

  async syncFromSupabase() {
    if (!this.hasSupabase()) return { ok: false, reason: 'no_credentials' };
    try {
      const [blocksRes, notesRes] = await Promise.all([
        fetch(this.supabaseRestUrl('category_blocks', 'select=*'), { headers: this.supabaseHeaders() }),
        fetch(this.supabaseRestUrl('voice_notes', 'select=*&order=recorded_minutes.asc'), { headers: this.supabaseHeaders() })
      ]);

      if (blocksRes.ok) {
        const blocks = await blocksRes.json();
        const existingLocal = await this.idbGetAll('category_blocks');
        const localMap = new Map(existingLocal.map((b) => [b.id, b]));
        for (const b of blocks) {
          const prev = localMap.get(b.id);
          await this.idbPut('category_blocks', {
            ...b,
            task_name: b.task_name ?? prev?.task_name ?? '',
            rating: b.rating !== undefined && b.rating !== null ? b.rating : (prev?.rating ?? null),
            notified_end: Boolean(b.notified_at || prev?.notified_end)
          });
        }
      }
      if (notesRes.ok) {
        const notes = await notesRes.json();
        for (const n of notes) {
          await this.idbPut('voice_notes', { ...n, synced_cloud: true });
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async getRoutineRules() {
    const rules = await this.idbGetAll('routine_rules');
    return rules.sort((a, b) => a.start_minutes - b.start_minutes);
  }

  async getAllCategoryBlocks() {
    return this.idbGetAll('category_blocks');
  }

  async saveCategoryBlock(block) {
    await this.idbPut('category_blocks', block);
    if (this.hasSupabase()) {
      const fullPayload = {
        id: block.id,
        date_str: block.date_str,
        category: block.category,
        task_name: block.task_name || '',
        rating: block.rating !== undefined ? block.rating : null,
        start_minutes: block.start_minutes,
        end_minutes: block.end_minutes
      };
      fetch(this.supabaseRestUrl('category_blocks'), {
        method: 'POST',
        headers: this.supabaseHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(fullPayload)
      })
        .then((res) => {
          if (!res.ok) {
            const { task_name, rating, ...fallbackPayload } = fullPayload;
            return fetch(this.supabaseRestUrl('category_blocks'), {
              method: 'POST',
              headers: this.supabaseHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
              body: JSON.stringify(fallbackPayload)
            });
          }
        })
        .catch(() => {});
    }
    return block;
  }

  async deleteCategoryBlock(id) {
    await this.idbDelete('category_blocks', id);
    if (this.hasSupabase()) {
      fetch(this.supabaseRestUrl('category_blocks', `id=eq.${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: this.supabaseHeaders()
      }).catch(() => {});
    }
  }

  async getAllVoiceNotes() {
    return this.idbGetAll('voice_notes');
  }

  async uploadAudioToSupabaseStorage(noteId, audioBlob) {
    if (!this.hasSupabase() || !audioBlob) return null;
    try {
      const base = this.settings.supabaseUrl.trim().replace(/\/+$/, '');
      const ext = (audioBlob.type || '').includes('mp4') ? 'm4a' : 'webm';
      const filePath = `${noteId}.${ext}`;
      const uploadUrl = `${base}/storage/v1/object/voice-notes/${filePath}`;
      const key = this.settings.supabaseAnonKey.trim();

      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': audioBlob.type || 'audio/webm',
          'x-upsert': 'true'
        },
        body: audioBlob
      });

      if (res.ok) {
        return `${base}/storage/v1/object/public/voice-notes/${filePath}`;
      }
    } catch (e) {}
    return null;
  }

  async saveVoiceNote(voiceNote, audioBlob = null) {
    let publicAudioUrl = voiceNote.audio_url || null;
    if (audioBlob && this.hasSupabase()) {
      publicAudioUrl = await this.uploadAudioToSupabaseStorage(voiceNote.id, audioBlob);
    }

    const recordToSave = {
      ...voiceNote,
      audio_url: publicAudioUrl,
      synced_cloud: Boolean(this.hasSupabase())
    };

    await this.idbPut('voice_notes', recordToSave);

    if (this.hasSupabase()) {
      const payload = {
        id: recordToSave.id,
        date_str: recordToSave.date_str,
        recorded_minutes: recordToSave.recorded_minutes,
        recorded_time_label: recordToSave.recorded_time_label,
        duration_seconds: recordToSave.duration_seconds || 0,
        context_block: recordToSave.context_block,
        poetic_title: recordToSave.poetic_title,
        summary: recordToSave.summary,
        key_points: recordToSave.key_points || [],
        transcript: recordToSave.transcript,
        audio_url: publicAudioUrl,
        audio_mime: recordToSave.audio_mime || 'audio/webm'
      };
      fetch(this.supabaseRestUrl('voice_notes'), {
        method: 'POST',
        headers: this.supabaseHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(payload)
      }).catch(() => {});
    }

    return recordToSave;
  }

  async deleteVoiceNote(id) {
    await this.idbDelete('voice_notes', id);
    if (this.hasSupabase()) {
      fetch(this.supabaseRestUrl('voice_notes', `id=eq.${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: this.supabaseHeaders()
      }).catch(() => {});
    }
  }
}

export const agendaDB = new AgendaDatabase();
