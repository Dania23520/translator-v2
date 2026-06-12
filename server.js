require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const OpenAI = require('openai');
const { SpeechClient } = require('@google-cloud/speech').v2;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const speechClient = new SpeechClient({
  apiEndpoint: 'eu-speech.googleapis.com'
});

const PROJECT_ID = 'project-955a0a8b-63ea-489f-a2f';
const RECOGNIZER = `projects/${PROJECT_ID}/locations/eu/recognizers/_`;

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
      const audioBuffer = Buffer.from(audioBase64, 'base64');

      // Шаг 1 — Chirp 3
      console.log('📡 ШАГ 1: Chirp 3...');
      const t1 = Date.now();

      const [response] = await speechClient.recognize({
        recognizer: RECOGNIZER,
        config: {
          autoDecodingConfig: {},
          languageCodes: ['ru-RU', 'no-NO'],
          model: 'chirp_3'
        },
        content: audioBuffer
      });

      console.log(`   ⏱ Chirp 3: ${Date.now()-t1}мс`);

      const result = response.results?.[0];
      const text = result?.alternatives?.[0]?.transcript?.trim() || '';
      const detectedLang = result?.languageCode || '';

      console.log(`   Текст: "${text}"`);
      console.log(`   Язык: ${detectedLang}`);

      if (!text) {
        console.log('❌ ПРОПУСК: пустой текст');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      clientWs.send(JSON.stringify({ type: 'original', text }));

      // Шаг 2 — GPT-4o перевод
      const isRussian = detectedLang.startsWith('ru');
      const targetLang = isRussian ? 'Norwegian' : 'Russian';

      console.log(`🔄 ШАГ 2: GPT-4o переводит на ${targetLang}...`);
      const t2 = Date.now();

      const translation = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: isRussian
              ? `Ты переводчик с русского на норвежский язык. Переведи текст естественно и правильно. Расставь знаки препинания. Верни ТОЛЬКО перевод без объяснений.`
              : `Ты переводчик с норвежского на русский язык. Переведи текст естественно и правильно. Расставь знаки препинания. Верни ТОЛЬКО перевод без объяснений.`
          },
          { role: 'user', content: text }
        ]
      });

      const translated = translation.choices[0].message.content.trim();
      console.log(`   ⏱ GPT-4o: ${Date.now()-t2}мс`);
      console.log(`   Перевод: "${translated}"`);

      clientWs.send(JSON.stringify({ type: 'translated', text: translated }));

      // Шаг 3 — TTS
      console.log(`🔊 ШАГ 3: OpenAI TTS (onyx)...`);
      const t3 = Date.now();

      const tts = await openai.audio.speech.create({
  model: 'gpt-4o-mini-tts',
  voice: 'onyx',
  input: translated,
  response_format: 'mp3'
});

      console.log(`   ⏱ TTS: ${Date.now()-t3}мс`);

      const audioOut = Buffer.from(await tts.arrayBuffer()).toString('base64');
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