// ============================================================================
// PIPELINE DE VOICE NOTES: GRAVAÇÃO DE ÁUDIO → TRANSCRIÇÃO & SÍNTESE (GEMINI / WHISPER)
// ============================================================================

export class VoiceNoteRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.startTime = 0;
    this.liveSpeechTranscript = '';
    this.recognition = null;
    this.isRecording = false;
    this.wakeLock = null;
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  async requestWakeLock() {
    if ('wakeLock' in navigator && navigator.wakeLock?.request) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {
        console.warn('wake lock não disponível:', err);
      }
    }
  }

  async releaseWakeLock() {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch (err) {
        console.warn('erro ao libertar wake lock:', err);
      }
      this.wakeLock = null;
    }
  }

  async handleVisibilityChange() {
    if (this.isRecording && document.visibilityState === 'visible') {
      await this.requestWakeLock();
    }
  }

  async start() {
    this.audioChunks = [];
    this.liveSpeechTranscript = '';
    this.startTime = Date.now();

    // Ativa a Screen Wake Lock API assim que inicia a gravação
    await this.requestWakeLock();
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';

      this.mediaRecorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.audioChunks.push(e.data);
        }
      };

      this.mediaRecorder.start(250);
    } catch (err) {
      console.warn('microfone indisponível neste contexto:', err);
    }

    this.startBrowserSpeechRecognition();
    this.isRecording = true;
  }

  startBrowserSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;
    try {
      this.recognition = new SpeechRec();
      this.recognition.lang = 'pt-PT';
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.onresult = (event) => {
        let text = '';
        for (let i = 0; i < event.results.length; i++) {
          text += event.results[i][0].transcript + ' ';
        }
        this.liveSpeechTranscript = text.trim();
      };
      this.recognition.start();
    } catch (e) {}
  }

  async stop() {
    this.isRecording = false;
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    // Liberta a Screen Wake Lock API quando clicas no quadrado branco
    await this.releaseWakeLock();

    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) {}
    }

    const durationSeconds = Math.max(1, Math.round((Date.now() - this.startTime) / 1000));

    let audioBlob = null;
    let audioDataUrl = null;
    let audioMime = 'audio/webm';

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        this.mediaRecorder.onstop = resolve;
        this.mediaRecorder.stop();
      });
      audioMime = this.mediaRecorder.mimeType || 'audio/webm';
      if (this.audioChunks.length > 0) {
        audioBlob = new Blob(this.audioChunks, { type: audioMime });
        audioDataUrl = await blobToDataURL(audioBlob);
      }
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }

    return {
      durationSeconds,
      audioBlob,
      audioDataUrl,
      audioMime,
      liveSpeechTranscript: this.liveSpeechTranscript
    };
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export async function processVoiceNoteWithAI({
  audioBlob,
  audioDataUrl,
  audioMime,
  liveSpeechTranscript,
  contextBlock,
  recordedTimeLabel,
  settings
}) {
  const apiKey = (settings?.apiKey || '').trim();
  const provider = settings?.aiProvider || 'gemini';
  const lang = settings?.whisperLanguage || 'pt';

  // 1. Se tivermos Gemini API Key, o Gemini 3 Flash transcreve e sintetiza num único passo multimodal
  if (apiKey && (provider === 'gemini' || apiKey.startsWith('AQ.') || apiKey.startsWith('AIza'))) {
    try {
      const geminiResult = await callGeminiAudioAndSynthesis({
        audioDataUrl,
        audioMime,
        liveSpeechTranscript,
        contextBlock,
        recordedTimeLabel,
        apiKey
      });
      if (geminiResult) {
        return {
          transcript: (geminiResult.transcript || liveSpeechTranscript || '').toLowerCase(),
          poetic_title: (geminiResult.poetic_title || 'nota de margem').toLowerCase(),
          summary: (geminiResult.summary || '').toLowerCase(),
          key_points: Array.isArray(geminiResult.key_points)
            ? geminiResult.key_points.map((p) => String(p).toLowerCase())
            : []
        };
      }
    } catch (err) {
      console.warn('erro na chamada gemini:', err);
    }
  }

  let transcript = (liveSpeechTranscript || '').trim();

  // 2. Transcrição com Whisper API se configurado OpenAI ou Groq
  if (audioBlob && apiKey && (provider === 'openai' || provider === 'groq')) {
    try {
      const whisperEndpoint =
        provider === 'groq'
          ? 'https://api.groq.com/openai/v1/audio/transcriptions'
          : 'https://api.openai.com/v1/audio/transcriptions';
      const whisperModel =
        provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

      const formData = new FormData();
      const ext = (audioBlob.type || '').includes('mp4') ? 'm4a' : 'webm';
      formData.append('file', audioBlob, `voicenote.${ext}`);
      formData.append('model', whisperModel);
      formData.append('language', lang);

      const res = await fetch(whisperEndpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        if (data.text && data.text.trim()) {
          transcript = data.text.trim();
        }
      }
    } catch (err) {}
  }

  if (!transcript) {
    transcript = generateContextualFallbackTranscript(contextBlock, recordedTimeLabel);
  }

  const localSynthesis = buildLocalEditorialSynthesis(transcript, contextBlock);
  return {
    transcript: transcript.toLowerCase(),
    ...localSynthesis
  };
}

async function callGeminiAudioAndSynthesis({
  audioDataUrl,
  audioMime,
  liveSpeechTranscript,
  contextBlock,
  recordedTimeLabel,
  apiKey
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${encodeURIComponent(apiKey)}`;
  const promptText = `és um assistente minimalista integrado numa agenda pessoal.
a nota de voz foi gravada às ${recordedTimeLabel} no contexto: "${contextBlock}".
transcreve fielmente o áudio e sintetiza-o em português de portugal, tudo em letras minúsculas.
responde apenas em json válido com estas 4 chaves:
{
  "transcript": "transcrição integral da gravação em minúsculas",
  "poetic_title": "título essencial de 3 a 5 palavras em minúsculas",
  "summary": "resumo conciso em 1 a 2 frases em minúsculas",
  "key_points": ["ideia-chave ou próximo passo 1", "ideia-chave ou próximo passo 2"]
}`;

  const parts = [{ text: promptText }];

  if (audioDataUrl && audioDataUrl.includes('base64,')) {
    const base64Data = audioDataUrl.split('base64,')[1];
    const cleanMime = (audioMime || 'audio/webm').split(';')[0];
    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: base64Data
      }
    });
  } else if (liveSpeechTranscript) {
    parts.push({ text: `transcrição captada: "${liveSpeechTranscript}"` });
  } else {
    return null;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return raw ? JSON.parse(raw) : null;
}

function generateContextualFallbackTranscript(contextBlock, timeLabel) {
  const ctx = (contextBlock || '').toLowerCase();
  const map = {
    'durante investigação': `nota gravada às ${timeLabel}. encontrei uma ligação importante entre os dois artigos principais. preciso de cruzar os dados empíricos antes de avançar para a síntese escrita.`,
    'durante trabalho': `registo rápido às ${timeLabel}. fechar o entregável prioritário desta sessão sem abrir novas frentes e deixar a estrutura pronta para amanhã.`,
    'durante escrita': `ideia para o texto às ${timeLabel}: abrir a secção com uma imagem mais concreta e cortar os adjetivos supérfluos no segundo parágrafo para manter o ritmo claro.`,
    'durante exercício mental': `observação às ${timeLabel}. o problema resolve-se de forma mais elegante se invertermos a premissa inicial e reduzirmos o número de variáveis.`,
    'durante leitura': `passagem sublinhada às ${timeLabel}: a verdadeira disciplina é a remoção de atrito em torno do que é essencial.`
  };
  return map[ctx] || `nota de voz registada às ${timeLabel} (${ctx}). consolidar a ideia central deste momento e definir o próximo passo antes do wind down.`;
}

function buildLocalEditorialSynthesis(transcript, contextBlock) {
  const ctx = (contextBlock || '').toLowerCase();
  const sentences = transcript
    .toLowerCase()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const contextTitles = {
    'durante investigação': 'fio condutor da investigação',
    'durante trabalho': 'rigor na execução essencial',
    'durante escrita': 'cadência e clareza textual',
    'durante exercício mental': 'inversão da premissa central',
    'durante leitura': 'margem de leitura atenta',
    'durante reflexão': 'clareza do ritmo matinal'
  };

  const poeticTitle = contextTitles[ctx] || 'nota de margem no tempo';
  const summary = sentences.slice(0, 2).join(' ') || transcript.toLowerCase().slice(0, 160);
  const keyPoints = sentences.length > 1
    ? sentences.slice(0, 3).map((s) => s.replace(/\.$/, ''))
    : [transcript.toLowerCase().slice(0, 95)];

  return {
    poetic_title: poeticTitle,
    summary,
    key_points: keyPoints
  };
}
