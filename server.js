const express = require('express');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
  socket.on('chat message', (msg) => {
    socket.emit('thinking');  // 스피너 시작 신호

    const command = ['gemini', '-m', 'gemini-2.5-pro', '-p', msg];
    const geminiProcess = spawn(command[0], command.slice(1));

    let response = '';
    geminiProcess.stdout.on('data', (data) => {
      response += data.toString();
    });

    geminiProcess.on('close', (code) => {
      socket.emit('chat done');  // 스피너 종료 신호
      if (code === 0) {
        socket.emit('chat message', response);
      } else {
        socket.emit('chat message', 'Error: gemini-cli failed');
      }
    });
  });
});


server.listen(3000, () => console.log('Server running on port 3000'));
