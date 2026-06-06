require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const OpenAI = require('openai');
const speech = require('@google-cloud/speech');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const googleSpeech = new speech.SpeechClient({ apiKey: process.env.GOOGLE_API_KEY });

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
      console.log('📡 ШАГ 1: Google Speech (no-NO)...');
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

      // Шаг 2 — GPT-4o перевод
      console.log('🔄 ШАГ 2: GPT-4o переводит...');
      const t2 = Date.now();
      const result = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Переведи с норвежского на русский. Расставь знаки препинания. Верни ТОЛЬКО перевод без объяснений.' },
          { role: 'user', content: text }
        ]
      });
      const translated = result.choices[0].message.content.trim();
      console.log(`   ⏱ GPT-4o: ${Date.now()-t2}мс`);
      console.log(`   Перевод: "${translated}"`);

      // Сразу показываем перевод
      clientWs.send(JSON.stringify({ type: 'translated', text: translated }));

      // Шаг 3 — OpenAI TTS
      console.log('🔊 ШАГ 3: OpenAI TTS (onyx)...');
      const t3 = Date.now();
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
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