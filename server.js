require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const speech = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const googleSpeech = new speech.SpeechClient({ apiKey: process.env.GOOGLE_API_KEY });
const googleTTS = new textToSpeech.TextToSpeechClient({ apiKey: process.env.GOOGLE_TTS_KEY });
const ai = new GoogleGenAI({
  vertexai: true,
  project: 'project-955a0a8b-63ea-489f-a2f',
  location: 'europe-west1'
});

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (clientWs) => {
  console.log('✅ Клиент подключился');
  let isProcessing = false;

  clientWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type !== 'audio_chunk') return;
      if (isProcessing) { console.log('⏳ Занят'); return; }
      isProcessing = true;

      const tTotal = Date.now();
      console.log('\n════════════════════════════════');
      console.log('🎤 НОВЫЙ ЗАПРОС');

      const audioBase64 = msg.audio;

      // Шаг 1 — Google Speech
      console.log('📡 ШАГ 1: Google Speech...');
      const t1 = Date.now();
      const [speechResponse] = await googleSpeech.recognize({
        audio: { content: audioBase64 },
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'no-NO',
          model: 'latest_long'
        }
      });
      console.log(`   ⏱ Speech: ${Date.now()-t1}мс`);

      const text = speechResponse.results?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
      const confidence = speechResponse.results?.[0]?.alternatives?.[0]?.confidence || 0;
      console.log(`   Текст: "${text}" (${confidence.toFixed(3)})`);

      if (!text || text.length < 2) {
        console.log('❌ ПРОПУСК: пустой текст');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      // Сразу показываем оригинал
      clientWs.send(JSON.stringify({ type: 'original', text }));

      // Шаг 2 — Gemini перевод
      console.log('🔄 ШАГ 2: Gemini переводит...');
      const t2 = Date.now();
      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Переведи с норвежского на русский. Расставь знаки препинания. Верни ТОЛЬКО перевод без объяснений:\n${text}`
      });
      const translated = result.text.trim();
      console.log(`   ⏱ Gemini: ${Date.now()-t2}мс`);
      console.log(`   Перевод: "${translated}"`);

      // Сразу показываем перевод
      clientWs.send(JSON.stringify({ type: 'translated', text: translated }));

      // Шаг 3 — Google TTS
      console.log('🔊 ШАГ 3: Google TTS...');
      const t3 = Date.now();
      const [ttsResponse] = await googleTTS.synthesizeSpeech({
        input: { text: translated },
        voice: { languageCode: 'ru-RU', name: 'ru-RU-Standard-D' },
        audioConfig: { audioEncoding: 'MP3' }
      });
      console.log(`   ⏱ TTS: ${Date.now()-t3}мс`);

      const audioOut = typeof ttsResponse.audioContent === 'string'
        ? ttsResponse.audioContent
        : Buffer.from(ttsResponse.audioContent).toString('base64');

      clientWs.send(JSON.stringify({ type: 'audio', data: audioOut }));

      console.log(`⏱ ИТОГО: ${Date.now()-tTotal}мс`);
      console.log('✅ ГОТОВО');
      isProcessing = false;

    } catch (err) {
      console.error('💥 ОШИБКА:', err.message);
      isProcessing = false;
      clientWs.send(JSON.stringify({ type: 'ready' }));
    }
  });

  clientWs.on('close', () => console.log('❌ Клиент отключился'));
});

server.listen(3000, () => console.log('🚀 Сервер запущен на http://localhost:3000'));