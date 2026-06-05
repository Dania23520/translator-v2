require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const OpenAI = require('openai');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (clientWs) => {
  console.log('Клиент подключился');
  let isProcessing = false;

  clientWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type !== 'audio_chunk') return;
      if (isProcessing) { console.log('Занят — пропускаем'); return; }
      isProcessing = true;

      const audioBuffer = Buffer.from(msg.audio, 'base64');
      const tmpRu = path.join(__dirname, 'tmp_ru.wav');
      const tmpNo = path.join(__dirname, 'tmp_no.wav');
      fs.writeFileSync(tmpRu, audioBuffer);
      fs.writeFileSync(tmpNo, audioBuffer);

      // Шаг 1 — две транскрипции параллельно
      console.log('Транскрибируем параллельно...');
      const [transRu, transNo] = await Promise.all([
        openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpRu),
          model: 'gpt-4o-transcribe',
          response_format: 'json',
          language: 'ru'  // или 'no'
        }),
        openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpNo),
          model: 'gpt-4o-transcribe',
          response_format: 'json',
          language: 'no'  // или 'no'
        })
      ]);

      if (fs.existsSync(tmpRu)) fs.unlinkSync(tmpRu);
      if (fs.existsSync(tmpNo)) fs.unlinkSync(tmpNo);

      const textRu = transRu.text.trim();
      const textNo = transNo.text.trim();

      console.log(`Whisper RU: ${textRu}`);
      console.log(`Whisper NO: ${textNo}`);

      if (!textRu && !textNo) {
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      // Шаг 2 — арбитр определяет язык ДО перевода
      console.log('Арбитр определяет язык...');
      const arbiter = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a language detector.
You receive two transcriptions of the same audio.
One was forced as Russian, one was forced as Norwegian.
Your job is to determine which transcription is real human speech.

Rules:
- Look at both texts
- Real speech has proper words, grammar, and meaning
- Gibberish has random sounds, mixed characters, or no meaning
- Return ONLY one word: "russian" or "norwegian"
- Never return anything else`
          },
          {
            role: 'user',
            content: `Russian transcription: "${textRu}"
Norwegian transcription: "${textNo}"
Which one is real speech?`
          }
        ]
      });

      const detectedLang = arbiter.choices[0].message.content.trim().toLowerCase();
      console.log('Арбитр решил:', detectedLang);

      if (detectedLang !== 'russian' && detectedLang !== 'norwegian') {
        console.log('Арбитр не смог определить — пропускаем');
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      // Шаг 3 — перевод правильного текста
      const sourceText = detectedLang === 'russian' ? textRu : textNo;
      const targetLang = detectedLang === 'russian' ? 'Norwegian' : 'Russian';
      const voice = detectedLang === 'russian' ? 'onyx' : 'nova';

      console.log(`Переводим с ${detectedLang} на ${targetLang}: ${sourceText}`);

      const translation = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Translate to ${targetLang}. Return ONLY the translation.`
          },
          {
            role: 'user',
            content: sourceText
          }
        ]
      });

      const translated = translation.choices[0].message.content.trim();
      console.log('Перевод:', translated);

      clientWs.send(JSON.stringify({
        type: 'translation',
        original: sourceText,
        translated
      }));

      // Шаг 4 — озвучка
      console.log('Озвучиваем голосом:', voice);
      const speech = await openai.audio.speech.create({
        model: 'tts-1',
        voice: voice,
        input: translated,
        response_format: 'mp3'
      });

      const audioData = Buffer.from(await speech.arrayBuffer());
      clientWs.send(JSON.stringify({ type: 'audio', data: audioData.toString('base64') }));

      isProcessing = false;

    } catch (err) {
      console.error('Ошибка:', err.message);
      isProcessing = false;
      clientWs.send(JSON.stringify({ type: 'ready' }));
    }
  });

  clientWs.on('close', () => console.log('Клиент отключился'));
});

server.listen(3000, () => console.log('Сервер запущен на http://localhost:3000'));