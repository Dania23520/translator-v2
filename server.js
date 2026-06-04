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
      const tmpFile = path.join(__dirname, 'tmp.wav');
      fs.writeFileSync(tmpFile, audioBuffer);

      console.log('Транскрибируем...');
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpFile),
        model: 'whisper-1',
        response_format: 'verbose_json',
        language: 'no'
      });

      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

      const text = transcription.text.trim();
      console.log(`Whisper NO: ${text}`);

      if (!text || text.length < 3) {
        isProcessing = false;
        clientWs.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      const result = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a translator. Translate Norwegian to Russian. Return ONLY the translation.'
          },
          {
            role: 'user',
            content: `Translate from Norwegian to Russian: "${text}"`
          }
        ]
      });

      const translated = result.choices[0].message.content.trim();
      console.log('Перевод:', translated);

      clientWs.send(JSON.stringify({ type: 'translation', original: text, translated }));

      const speech = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',
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