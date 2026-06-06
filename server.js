require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const OpenAI = require('openai');
const speech = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const googleSpeech = new speech.SpeechClient({ apiKey: process.env.GOOGLE_API_KEY });
const googleTTS = new textToSpeech.TextToSpeechClient({ apiKey: process.env.GOOGLE_TTS_KEY });

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

      console.log('\n════════════════════════════════');
      console.log('🎤 НОВЫЙ ЗАПРОС');

      const audioBase64 = msg.audio;

      // Шаг 1 — Google Speech
      console.log('📡 ШАГ 1: Google Speech (no-NO)...');
      const [speechResponse] = await googleSpeech.recognize({
        audio: { content: audioBase64 },
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'no-NO',
          model: 'latest_long'
        }
      });

      const text = speechResponse.results?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
      const confidence = speechResponse.results?.[0]?.alternatives?.[0]?.confidence || 0;
      console.log(`   Текст: "${text}" (${confidence.toFixed(3)})`);

      if (!text || text.length < 2) {
        console.log('❌ ПРОПУСК: пустой текст');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      // Шаг 2 — GPT-4o перевод
      console.log('🔄 ШАГ 2: GPT-4o переводит...');
      const translation = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Переведи с норвежского на русский. Расставь знаки препинания — запятые, точки, вопросительные и восклицательные знаки. Используй правильные падежи. Верни ТОЛЬКО перевод.' },
          { role: 'user', content: text }
        ]
      });
      const translated = translation.choices[0].message.content.trim();
      console.log(`   Перевод: "${translated}"`);

      clientWs.send(JSON.stringify({ type: 'translation', original: text, translated }));

      // Шаг 3 — Google TTS
      console.log('🔊 ШАГ 3: Google TTS...');
      const [ttsResponse] = await googleTTS.synthesizeSpeech({
        input: { text: translated },
        voice: { languageCode: 'ru-RU', name: 'ru-RU-Wavenet-D' },
        audioConfig: { audioEncoding: 'MP3' }
      });

      const audioContent = ttsResponse.audioContent;
const audioOut = typeof audioContent === 'string' 
  ? audioContent 
  : Buffer.from(audioContent).toString('base64');
console.log(`   Тип audioContent: ${typeof audioContent}`);
console.log(`   Размер: ${audioContent.length}`);
      console.log(`   Аудио размер: ${ttsResponse.audioContent.length} байт`);
      clientWs.send(JSON.stringify({ type: 'audio', data: audioOut }));

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