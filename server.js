const express = require('express');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');  // 파일 관리용

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 업로드 설정: uploads 폴더에 저장
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// 정적 파일 서빙
app.use(express.static('public'));

// 이미지 업로드 라우트 (클라이언트에서 POST로 호출)
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ imagePath: req.file.path });  // 클라이언트로 파일 경로 반환
});

io.on('connection', (socket) => {
  socket.on('chat message', ({ prompt, imagePath }) => {  // 이미지 경로 포함 수신
    socket.emit('thinking');  // 로딩 스피너 시작 (이전 기능 참조)

    let fullPrompt = prompt || '이 이미지를 분석해 주세요.';
    if (imagePath) {
      fullPrompt += ` [이미지 파일: ${imagePath}]`;  // 프롬프트에 경로 포함 (gemini-cli가 지원할 경우)
    }

    const command = [
      'gemini',
      '-m', 'gemini-2.5-pro',
      '-p', fullPrompt  // -i 제거, 프롬프트로만 처리
      // 만약 이미지 옵션이 별도로 있다면: '--image', imagePath 추가 (테스트 필요)
    ];


    const geminiProcess = spawn(command[0], command.slice(1));

    let response = '';
    geminiProcess.stdout.on('data', (data) => {
      response += data.toString();
    });

    geminiProcess.stderr.on('data', (data) => {
      console.error('Gemini error:', data.toString());
    });

    geminiProcess.on('error', (err) => {
      console.error('Spawn error:', err.message);  // 상세 에러 출력
      socket.emit('chat message', 'Error: ' + err.message);
    });

    geminiProcess.on('close', (code) => {
      socket.emit('chat done');  // 로딩 종료
      if (code === 0) {
        socket.emit('chat message', response);
        // 분석 후 이미지 삭제 (보안/공간 절약)
        if (imagePath) fs.unlinkSync(imagePath);
      } else {
        socket.emit('chat message', 'Error: gemini-cli failed with code ' + code);
      }
    });
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
