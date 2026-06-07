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

let franc;
(async () => {
  const francModule = await import('franc');
  franc = francModule.franc;
})();

function analyzeLanguage(text) {
  if (!franc || !text) return { ru: 0, no: 0 };
  const result = franc(text, { minLength: 3, only: ['rus', 'nno', 'nob'] });
  // franc возвращает строку с кодом языка
  const isRu = result === 'rus';
  const isNo = result === 'nno' || result === 'nob';
  return { isRu, isNo, code: result };
}

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

      // Шаг 1 — два Google Speech параллельно
      console.log('📡 ШАГ 1: Google Speech параллельно...');
      const t1 = Date.now();
      const [ruResponse, noResponse] = await Promise.all([
        googleSpeech.recognize({
          audio: { content: audioBase64 },
          config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'ru-RU', model: 'latest_long' }
        }),
        googleSpeech.recognize({
          audio: { content: audioBase64 },
          config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'no-NO', model: 'latest_long' }
        })
      ]);
      console.log(`   ⏱ Speech: ${Date.now()-t1}мс`);

      const textRu = ruResponse[0].results?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
      const textNo = noResponse[0].results?.[0]?.alternatives?.[0]?.transcript?.trim() || '';

      console.log(`   RU: "${textRu}"`);
      console.log(`   NO: "${textNo}"`);

      if (!textRu && !textNo) {
        console.log('❌ ПРОПУСК: оба пустые');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      // Шаг 2 — franc + сигналы
      console.log('🔍 ШАГ 2: Анализ сигналов...');
      const t2 = Date.now();

      const ruAnalysis = analyzeLanguage(textRu);
      const noAnalysis = analyzeLanguage(textNo);

      const noHasCyrillic = /[а-яёА-ЯЁ]/.test(textNo);
      const ruHasLatin = /[a-zA-ZæøåÆØÅ]/.test(textRu);

      let ruVotes = 0;
      let noVotes = 0;

      // Сигнал 1 — franc для RU текста
      if (ruAnalysis.isRu) { ruVotes++; console.log('   ✅ Сигнал 1: franc RU текст = русский (+1 RU)'); }
      else if (ruAnalysis.isNo) { noVotes++; console.log('   ✅ Сигнал 1: franc RU текст = норвежский (+1 NO)'); }

      // Сигнал 2 — franc для NO текста
      if (noAnalysis.isNo) { noVotes++; console.log('   ✅ Сигнал 2: franc NO текст = норвежский (+1 NO)'); }
      else if (noAnalysis.isRu) { ruVotes++; console.log('   ✅ Сигнал 2: franc NO текст = русский (+1 RU)'); }

      // Сигнал 3 — кириллица в NO тексте
      if (noHasCyrillic) { ruVotes++; console.log('   ✅ Сигнал 3: NO выдал кириллицу (+1 RU)'); }

      // Сигнал 4 — латиница в RU тексте
      if (ruHasLatin) { noVotes++; console.log('   ✅ Сигнал 4: RU выдал латиницу (+1 NO)'); }

      console.log(`   RU голоса: ${ruVotes} | NO голоса: ${noVotes}`);
      console.log(`   ⏱ Анализ: ${Date.now()-t2}мс`);

      // Шаг 3 — решение
      let sourceText, targetLang, voice;

      if (ruVotes > noVotes) {
        sourceText = textRu;
        targetLang = 'Norwegian';
        voice = 'nova';
        console.log(`   → РУССКИЙ побеждает (${ruVotes} vs ${noVotes})`);
      } else if (noVotes > ruVotes) {
        sourceText = textNo;
        targetLang = 'Russian';
        voice = 'onyx';
        console.log(`   → НОРВЕЖСКИЙ побеждает (${noVotes} vs ${ruVotes})`);
      } else {
        // Ничья — смотрим на кириллицу в RU тексте
        const ruHasCyrillic = /[а-яёА-ЯЁ]/.test(textRu);
        if (ruHasCyrillic) {
          sourceText = textRu;
          targetLang = 'Norwegian';
          voice = 'nova';
          console.log(`   → НИЧЬЯ → RU содержит кириллицу → русский`);
        } else {
          sourceText = textNo;
          targetLang = 'Russian';
          voice = 'onyx';
          console.log(`   → НИЧЬЯ → норвежский по умолчанию`);
        }
      }

      if (!sourceText) {
        console.log('❌ ПРОПУСК: нет текста');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      clientWs.send(JSON.stringify({ type: 'original', text: sourceText }));

      // Шаг 4 — GPT-4o перевод
      console.log(`🔄 ШАГ 4: GPT-4o переводит на ${targetLang}...`);
      const t4 = Date.now();
      const result = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: `Переведи на ${targetLang}. Расставь знаки препинания. Верни ТОЛЬКО перевод.` },
          { role: 'user', content: sourceText }
        ]
      });
      const translated = result.choices[0].message.content.trim();
      console.log(`   ⏱ GPT-4o: ${Date.now()-t4}мс`);
      console.log(`   Перевод: "${translated}"`);

      clientWs.send(JSON.stringify({ type: 'translated', text: translated }));

      // Шаг 5 — TTS
      console.log(`🔊 ШАГ 5: OpenAI TTS (${voice})...`);
      const t5 = Date.now();
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: voice,
        input: translated,
        response_format: 'mp3'
      });
      console.log(`   ⏱ TTS: ${Date.now()-t5}мс`);

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