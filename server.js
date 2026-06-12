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

let ruDict, nbDict;
(async () => {
  const ruDictModule = await import('dictionary-ru');
  const nbDictModule = await import('dictionary-nb');

  const ruWords = ruDictModule.default.dic.toString().split('\n')
    .map(w => w.split('/')[0].toLowerCase().trim())
    .filter(w => w.length > 0);
  ruDict = new Set(ruWords);
  console.log(`✅ Русский словарь: ${ruDict.size} слов`);

  const nbWords = nbDictModule.default.dic.toString().split('\n')
    .map(w => w.split('/')[0].toLowerCase().trim())
    .filter(w => w.length > 0);
  nbDict = new Set(nbWords);
  console.log(`✅ Норвежский словарь: ${nbDict.size} слов`);
})();

// Словарная проверка вместо GPT
function alg1_smysl(textRu, textNo) {
  const ruWords = textRu.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const noWords = textNo.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  const ruMatch = ruDict ? ruWords.filter(w => ruDict.has(w)).length : 0;
  const noMatch = nbDict ? noWords.filter(w => nbDict.has(w)).length : 0;

  const ruExists = ruMatch > 0 ? 'YES' : 'NO';
  const noExists = noMatch > 0 ? 'YES' : 'NO';

  console.log(`   Dict: ruMatch=${ruMatch}/${ruWords.length} noMatch=${noMatch}/${noWords.length}`);
  return { ruExists, noExists };
}

async function gpt2_grammarRu(textRu) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 15,
    messages: [
      {
        role: 'system',
        content: `Ты лингвистический анализатор русского языка.
Проверь текст по правилам русского языка.
Ответь строго YES или NO на каждый вопрос.
Верни ТОЛЬКО четыре слова через пробел.

1. Глаголы имеют правильное спряжение по лицам и числам?
2. Существительные имеют правильное склонение по падежам?
3. Прилагательные согласованы по роду числу и падежу?
4. Используются русские предлоги?

Формат ответа: YES/NO YES/NO YES/NO YES/NO`
      },
      { role: 'user', content: textRu || 'пусто' }
    ]
  });
  const parts = res.choices[0].message.content.trim().toUpperCase().split(/\s+/);
  return { conj: parts[0], decl: parts[1], agr: parts[2], prep: parts[3] };
}

async function gpt3_grammarNo(textNo) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 15,
    messages: [
      {
        role: 'system',
        content: `Ты лингвистический анализатор норвежского языка.
Проверь текст по правилам норвежского языка.
Ответь строго YES или NO на каждый вопрос.
Верни ТОЛЬКО четыре слова через пробел.

1. Существительные используют правильные артикли?
2. Глаголы имеют правильные норвежские формы?
3. Соблюдается порядок слов SVO (глагол на втором месте)?
4. Используются норвежские предлоги?

Формат ответа: YES/NO YES/NO YES/NO YES/NO`
      },
      { role: 'user', content: textNo || 'пусто' }
    ]
  });
  const parts = res.choices[0].message.content.trim().toUpperCase().split(/\s+/);
  return { art: parts[0], verb: parts[1], svo: parts[2], prep: parts[3] };
}

async function gpt4_translit(textRu, textNo) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 10,
    messages: [
      {
        role: 'system',
        content: `Ты лингвистический анализатор.
Транслитерация = слова одного языка записанные буквами другого алфавита.
Ответь строго YES или NO на каждый вопрос.
Верни ТОЛЬКО два слова через пробел.

1. textRu написан кириллицей но слова не существуют в русском и звучат как норвежские?
2. textNo написан латиницей но слова не существуют в норвежском и звучат как русские?

Формат ответа: YES/NO YES/NO`
      },
      { role: 'user', content: JSON.stringify({ textRu, textNo }) }
    ]
  });
  const parts = res.choices[0].message.content.trim().toUpperCase().split(/\s+/);
  return { ruTranslit: parts[0], noTranslit: parts[1] };
}

function alg5_alphabet(textRu, textNo) {
  return {
    noHasCyrillic: /[а-яёА-ЯЁ]/.test(textNo),
    ruHasLatin: /[a-zA-ZæøåÆØÅ]/.test(textRu)
  };
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

      // Шаг 1 — Google Speech параллельно
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

      // Шаг 2 — параллельный анализ
      console.log('\n🔍 ШАГ 2: Параллельный анализ...');
      const t2 = Date.now();

      const smysl = alg1_smysl(textRu, textNo);
      const [gramRu, gramNo, translit] = await Promise.all([
        gpt2_grammarRu(textRu),
        gpt3_grammarNo(textNo),
        gpt4_translit(textRu, textNo)
      ]);
      const alphabet = alg5_alphabet(textRu, textNo);

      console.log(`   ⏱ Анализ: ${Date.now()-t2}мс`);
      console.log(`   Смысл: ruExists=${smysl.ruExists} noExists=${smysl.noExists}`);
      console.log(`   GramRU: conj=${gramRu.conj} decl=${gramRu.decl} agr=${gramRu.agr} prep=${gramRu.prep}`);
      console.log(`   GramNO: art=${gramNo.art} verb=${gramNo.verb} svo=${gramNo.svo} prep=${gramNo.prep}`);
      console.log(`   Translit: ruTranslit=${translit.ruTranslit} noTranslit=${translit.noTranslit}`);
      console.log(`   Alphabet: noHasCyrillic=${alphabet.noHasCyrillic} ruHasLatin=${alphabet.ruHasLatin}`);

      const pocket = {
        texts: { ru: textRu, no: textNo },
        smysl,
        gramRu,
        gramNo,
        translit,
        alphabet
      };

      // Шаг 3 — арбитр
      console.log('\n⚖️  ШАГ 3: Арбитр...');
      const t3 = Date.now();

      const arbiter = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 10,
        messages: [
          {
            role: 'system',
            content: `Ты финальный арбитр системы Russian-Norwegian.
Получаешь карман с результатами анализа.

Подсчитай очки строго по правилам:

RU получает +1 за каждое YES/true:
- smysl.ruExists = YES
- gramRu.conj = YES
- gramRu.decl = YES
- gramRu.agr = YES
- gramRu.prep = YES
- translit.noTranslit = YES
- alphabet.noHasCyrillic = true

NO получает +1 за каждое YES/true:
- smysl.noExists = YES
- gramNo.art = YES
- gramNo.verb = YES
- gramNo.svo = YES
- gramNo.prep = YES
- translit.ruTranslit = YES
- alphabet.ruHasLatin = true

Тот у кого больше очков — победитель.
Верни ТОЛЬКО одно слово: russian или norwegian`
          },
          { role: 'user', content: JSON.stringify(pocket) }
        ]
      });

      const decision = arbiter.choices[0].message.content.trim().toLowerCase().replace(/"/g, '');
      console.log(`   ⏱ Арбитр: ${Date.now()-t3}мс`);
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

      // Шаг 4 — перевод
      // Шаг 4 — перевод
console.log(`\n🔄 ШАГ 4: GPT-4o переводит на ${targetLang}...`);
const t4 = Date.now();
const translation = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [
    {
      role: 'system',
      content: isRussian
        ? `Ты переводчик с русского на норвежский язык. Переведи текст естественно и правильно. Расставь знаки препинания. Верни ТОЛЬКО перевод без объяснений.`
        : `Ты переводчик с норвежского на русский язык. Переведи текст естественно и правильно. Расставь знаки препинания. Верни ТОЛЬКО перевод без объяснений.`
    },
    { role: 'user', content: sourceText }
  ]
});
      const translated = translation.choices[0].message.content.trim();
      console.log(`   ⏱ GPT-4o: ${Date.now()-t4}мс`);
      console.log(`   Перевод: "${translated}"`);

      clientWs.send(JSON.stringify({ type: 'translated', text: translated }));

      // Шаг 5 — TTS
      console.log(`\n🔊 ШАГ 5: OpenAI TTS (onyx)...`);
      const t5 = Date.now();
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'onyx',
        input: translated,
        response_format: 'mp3'
      });
      console.log(`   ⏱ TTS: ${Date.now()-t5}мс`);

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