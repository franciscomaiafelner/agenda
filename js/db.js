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
    id: 'routine-muay-thai-manha',
    title: 'muay thai',
    subtitle: '',
    tone: 'leather',
    start_minutes: 10 * 60,      // 10:00
    end_minutes: 11 * 60 + 30,   // 11:30
    days_of_week: [3, 4],        // quarta e quinta
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
    days_of_week: [1, 2, 5, 6],  // segunda, terça, sexta e sábado
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
    await this.idbDelete('routine_rules', 'routine-faculdade-seg-qua');
    // Atualiza sempre as regras de rotina fixa
    for (const rule of DEFAULT_ROUTINE_RULES) {
      await this.idbPut('routine_rules', rule);
    }

    // Limpa qualquer dummy data antiga que tenha ficado guardada localmente
    const cleanedDummy = localStorage.getItem('ma_wabi_sabi_cleaned_dummy_v1');
    if (!cleanedDummy) {
      const allBlocks = await this.idbGetAll('category_blocks');
      for (const b of allBlocks) {
        if (/^cat-\d{4}-\d{2}-\d{2}-(0900|1530|1800)$/.test(b.id)) {
          await this.deleteCategoryBlock(b.id);
        }
      }
      const allNotes = await this.idbGetAll('voice_notes');
      for (const vn of allNotes) {
        if (/^vn-\d{4}-\d{2}-\d{2}-0942$/.test(vn.id)) {
          await this.deleteVoiceNote(vn.id);
        }
      }
      localStorage.setItem('ma_wabi_sabi_cleaned_dummy_v1', 'true');
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
          const hasRating = b.rating !== undefined && b.rating !== null;
          await this.idbPut('category_blocks', {
            ...b,
            task_name: b.task_name ?? prev?.task_name ?? '',
            rating: hasRating ? b.rating : (prev?.rating ?? null),
            notified_end: Boolean(hasRating || prev?.notified_end)
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

  async savePushSubscription(subObj) {
    if (!this.hasSupabase() || !subObj || !subObj.endpoint) return false;
    try {
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      const payload = {
        endpoint: subObj.endpoint,
        subscription_json: {
          ...subObj,
          tz_offset_minutes: tzOffsetMinutes
        }
      };
      const res = await fetch(
        this.supabaseRestUrl('push_subscriptions', 'on_conflict=endpoint'),
        {
          method: 'POST',
          headers: this.supabaseHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
          body: JSON.stringify(payload)
        }
      );
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  async triggerEdgeFunctionCheck(extraPayload = {}) {
    if (!this.hasSupabase() || !ENV_CONFIG.EDGE_FUNCTION_URL) return null;
    try {
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      const res = await fetch(ENV_CONFIG.EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: this.supabaseHeaders(),
        body: JSON.stringify({
          name: 'agenda',
          tz_offset_minutes: tzOffsetMinutes,
          ...extraPayload
        })
      });
      if (res.ok) return await res.json();
    } catch (e) {}
    return null;
  }
}

export const agendaDB = new AgendaDatabase();
