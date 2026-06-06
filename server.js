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

      // Шаг 2 — два GPT параллельно анализируют каждый свой текст
      console.log('🔍 ШАГ 2: Анализ параллельно...');
      const t2 = Date.now();
      const [analysisRu, analysisNo] = await Promise.all([
        // GPT-A анализирует только русский текст
        openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Ты анализируешь транскрипцию аудио записанную как русский язык.

Задача 1: Есть ли логическая связь между словами — это осмысленная русская речь?
Задача 2: Являются ли слова фонетической транслитерацией норвежских слов записанных кириллицей? (например "Я испилер" = "jeg spiller", "Вуден године" = "Hvordan går det")

Верни ТОЛЬКО JSON без markdown:
{"has_meaning": true/false, "has_transliteration": true/false, "text": "${textRu}"}`
            },
            { role: 'user', content: textRu || 'пусто' }
          ]
        }),
        // GPT-B анализирует только норвежский текст
        openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Ты анализируешь транскрипцию аудио записанную как норвежский язык.

Задача 1: Есть ли логическая связь между словами — это осмысленная норвежская речь?
Задача 2: Являются ли слова фонетической транслитерацией русских слов записанных латиницей или кириллицей? (например "Privet kak dela" = "Привет как дела")

Верни ТОЛЬКО JSON без markdown:
{"has_meaning": true/false, "has_transliteration": true/false, "text": "${textNo}"}`
            },
            { role: 'user', content: textNo || 'пусто' }
          ]
        })
      ]);
      console.log(`   ⏱ Анализ: ${Date.now()-t2}мс`);

      // Парсим результаты
      let ruResult, noResult;
      try {
        ruResult = JSON.parse(analysisRu.choices[0].message.content.trim());
      } catch {
        ruResult = { has_meaning: false, has_transliteration: false, text: textRu };
      }
      try {
        noResult = JSON.parse(analysisNo.choices[0].message.content.trim());
      } catch {
        noResult = { has_meaning: false, has_transliteration: false, text: textNo };
      }

      console.log(`   RU анализ:`, ruResult);
      console.log(`   NO анализ:`, noResult);

      // Шаг 3 — Арбитр
      console.log('⚖️  ШАГ 3: Арбитр принимает решение...');
      const t3 = Date.now();

      const pocket = { ru: ruResult, no: noResult };

      const arbiter = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Ты арбитр переводчика русский-норвежский. Следуй правилам СТРОГО:

Тебе приходит JSON с двумя полями: ru и no.
Каждое поле содержит: has_meaning, has_transliteration, text.

ПРАВИЛА — выполняй строго по порядку:

Правило 1: Если ru.has_meaning=true И ru.has_transliteration=false
→ Дополнительное подтверждение: no.has_transliteration=true означает что норвежский транскриптор тоже не понял язык → речь точно русская
→ Возьми ru.text → расставь пунктуацию и падежи → переведи на норвежский → верни ТОЛЬКО перевод

Правило 2: Если no.has_meaning=true И no.has_transliteration=false
→ Дополнительное подтверждение: ru.has_transliteration=true означает что русский транскриптор написал норвежские слова кириллицей → речь точно норвежская
→ Возьми no.text → расставь пунктуацию и падежи → переведи на русский → верни ТОЛЬКО перевод

Правило 3: Если оба has_meaning=true и оба has_transliteration=false
→ Если ru.text содержит кириллицу → применяй Правило 1
→ Если no.text содержит æ,ø,å → применяй Правило 2
→ Иначе применяй Правило 1

Правило 4: Если ни одно правило не подходит → верни: ERROR

Верни ТОЛЬКО перевод или ERROR. Ничего больше.`
          },
          {
            role: 'user',
            content: JSON.stringify(pocket)
          }
        ]
      });

      const translated = arbiter.choices[0].message.content.trim();
      console.log(`   ⏱ Арбитр: ${Date.now()-t3}мс`);
      console.log(`   Результат: "${translated}"`);

      if (translated === 'ERROR') {
        console.log('❌ Арбитр: мусор — пропускаем');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      // Определяем язык для озвучки
      const isRussian = ruResult.has_meaning && !ruResult.has_transliteration && 
                        !(noResult.has_meaning && !noResult.has_transliteration);
      const voice = isRussian ? 'nova' : 'onyx';

      // Показываем оригинал и перевод
      const originalText = isRussian ? textRu : textNo;
      clientWs.send(JSON.stringify({ type: 'original', text: originalText }));
      clientWs.send(JSON.stringify({ type: 'translated', text: translated }));

      // Шаг 4 — TTS
      console.log(`🔊 ШАГ 4: OpenAI TTS (${voice})...`);
      const t4 = Date.now();
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: voice,
        input: translated,
        response_format: 'mp3'
      });
      console.log(`   ⏱ TTS: ${Date.now()-t4}мс`);

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