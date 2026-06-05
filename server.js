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

      console.log('Запускаем две системы параллельно...');

      // Система 1: Русский → Норвежский
      // Система 2: Норвежский → Русский
      const [resultRuToNo, resultNoToRu] = await Promise.all([
        // Система 1
        (async () => {
          const trans = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tmpRu),
            model: 'whisper-1',
            response_format: 'verbose_json',
            language: 'ru'
          });
          const text = trans.text.trim();
          if (!text || text.length < 3) return null;
          const gpt = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Translate Russian to Norwegian. Return ONLY the translation.' },
              { role: 'user', content: text }
            ]
          });
          return { original: text, translated: gpt.choices[0].message.content.trim(), lang: 'no' };
        })(),
        // Система 2
        (async () => {
          const trans = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tmpNo),
            model: 'whisper-1',
            response_format: 'verbose_json',
            language: 'no'
          });
          const text = trans.text.trim();
          if (!text || text.length < 3) return null;
          const gpt = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Translate Norwegian to Russian. Return ONLY the translation.' },
              { role: 'user', content: text }
            ]
          });
          return { original: text, translated: gpt.choices[0].message.content.trim(), lang: 'ru' };
        })()
      ]);

      if (fs.existsSync(tmpRu)) fs.unlinkSync(tmpRu);
      if (fs.existsSync(tmpNo)) fs.unlinkSync(tmpNo);

      console.log('Система 1 (RU→NO):', resultRuToNo);
      console.log('Система 2 (NO→RU):', resultNoToRu);

      // Система 3: Арбитр — выбирает правильный результат
      const arbiter = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are an arbiter between two translation systems.
System 1 assumed the audio was Russian and translated to Norwegian.
System 2 assumed the audio was Norwegian and translated to Russian.

Your job:
1. Look at both original transcriptions
2. Decide which system got the correct original language
3. Return ONLY the translation from the correct system
4. Return nothing else - just the translated text`
          },
          {
            role: 'user',
            content: `System 1 original (assumed Russian): "${resultRuToNo?.original || ''}"
System 1 translation (to Norwegian): "${resultRuToNo?.translated || ''}"

System 2 original (assumed Norwegian): "${resultNoToRu?.original || ''}"
System 2 translation (to Russian): "${resultNoToRu?.translated || ''}"

Which system got the correct language? Return only the translation.`
          }
        ]
      });

      const finalTranslation = arbiter.choices[0].message.content.trim();
      const finalLang = resultNoToRu?.translated === finalTranslation ? 'ru' : 'no';

      console.log('Финальный перевод:', finalTranslation);
      console.log('Язык озвучки:', finalLang);

      clientWs.send(JSON.stringify({
        type: 'translation',
        original: finalLang === 'ru' ? resultNoToRu?.original : resultRuToNo?.original,
        translated: finalTranslation
      }));

      // Озвучка с правильным голосом
      const voice = finalLang === 'ru' ? 'nova' : 'onyx';
      const speech = await openai.audio.speech.create({
        model: 'tts-1',
        voice: voice,
        input: finalTranslation,
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