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

      console.log('\n📊 ИСХОДНЫЕ ДАННЫЕ:');
      console.log(`   textRu: "${textRu}"`);
      console.log(`   textNo: "${textNo}"`);

      if (!textRu && !textNo) {
        console.log('❌ ПРОПУСК: оба пустые');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      // Шаг 2 — GPT арбитр
      console.log('\n🤖 ШАГ 2: Арбитр анализирует...');
      const t2 = Date.now();

      const arbiter = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Ты арбитр системы распознавания языка Russian-Norwegian.

Тебе приходят два текста от одного аудио файла:
- textRu: принудительно транскрибирован как русский
- textNo: принудительно транскрибирован как норвежский

Один из них отражает реальную речь, другой — искажение или транслитерацию.

ОБЯЗАТЕЛЬНО заполни таблицу строго YES или NO по каждому пункту. Никаких объяснений.

ПРАВИЛО 1 — СМЫСЛ:
textRu_exists: существуют ли эти слова в русском языке? YES/NO
textNo_exists: существуют ли эти слова в норвежском языке? YES/NO

ПРАВИЛО 2 — ГРАММАТИКА РУССКОГО (для textRu):
textRu_conjugation: правильное спряжение глаголов по лицам и числам? YES/NO
textRu_declension: правильное склонение существительных по падежам? YES/NO
textRu_agreement: правильное согласование прилагательных по роду числу и падежу? YES/NO
textRu_prepositions: используются русские предлоги? YES/NO

ПРАВИЛО 3 — ГРАММАТИКА НОРВЕЖСКОГО (для textNo):
textNo_articles: правильно используются артикли? YES/NO
textNo_verbforms: правильные глагольные формы? YES/NO
textNo_wordorder: соблюдается порядок слов SVO (глагол на втором месте)? YES/NO
textNo_prepositions: используются норвежские предлоги? YES/NO

ПРАВИЛО 4 — ТРАНСЛИТЕРАЦИЯ:
textRu_transliteration: слова написаны кириллицей но не существуют в русском и не подчиняются его грамматике? YES/NO
textNo_transliteration: слова написаны латиницей но не существуют в норвежском и не подчиняются его грамматике? YES/NO

ПРАВИЛО 5 — АЛФАВИТ:
textNo_has_cyrillic: textNo содержит кириллицу? YES/NO
textRu_has_latin: textRu содержит латиницу или æøå? YES/NO

РЕШЕНИЕ:
Русский получает очко за каждый YES в: textRu_exists, textRu_conjugation, textRu_declension, textRu_agreement, textRu_prepositions, textNo_transliteration, textNo_has_cyrillic.
Норвежский получает очко за каждый YES в: textNo_exists, textNo_articles, textNo_verbforms, textNo_wordorder, textNo_prepositions, textRu_transliteration, textRu_has_latin.
Тот у кого больше очков — победитель.

Верни ТОЛЬКО одно слово без кавычек: russian или norwegian`
          },
          {
            role: 'user',
            content: JSON.stringify({ textRu, textNo })
          }
        ]
      });

      const decision = arbiter.choices[0].message.content.trim().toLowerCase().replace(/"/g, '');
      console.log(`   ⏱ Арбитр: ${Date.now()-t2}мс`);
      console.log(`   Решение: ${decision}`);

      if (decision !== 'russian' && decision !== 'norwegian') {
        console.log('❌ Неверный ответ арбитра — пропускаем');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      const isRussian = decision === 'russian';
      const sourceText = isRussian ? textRu : textNo;
      const targetLang = isRussian ? 'Norwegian' : 'Russian';

      console.log(`   Источник: "${sourceText}"`);
      clientWs.send(JSON.stringify({ type: 'original', text: sourceText }));

      // Шаг 3 — перевод
      console.log(`\n🔄 ШАГ 3: GPT-4o переводит на ${targetLang}...`);
      const t3 = Date.now();
      const translation = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Ты переводчик. Переведи полученный текст на ${targetLang}. Расставь знаки препинания. Верни ТОЛЬКО перевод без объяснений и без добавлений от себя.`
          },
          { role: 'user', content: sourceText }
        ]
      });
      const translated = translation.choices[0].message.content.trim();
      console.log(`   ⏱ GPT-4o: ${Date.now()-t3}мс`);
      console.log(`   Перевод: "${translated}"`);

      clientWs.send(JSON.stringify({ type: 'translated', text: translated }));

      // Шаг 4 — TTS
      console.log(`\n🔊 ШАГ 4: OpenAI TTS (onyx)...`);
      const t4 = Date.now();
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'onyx',
        input: translated,
        response_format: 'mp3'
      });
      console.log(`   ⏱ TTS: ${Date.now()-t4}мс`);

      const audioOut = Buffer.from(await tts.arrayBuffer()).toString('base64');
      clientWs.send(JSON.stringify({ type: 'audio', data: audioOut }));

      console.log(`\n⏱ ИТОГО: ${Date.now()-tTotal}мс`);
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