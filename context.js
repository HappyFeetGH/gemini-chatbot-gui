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

const sessions = new Map();  // 사용자별 맥락 저장 (socket.id 키)

io.on('connection', (socket) => {
  sessions.set(socket.id, { context: '' });  // 초기화

  socket.on('select folder', async (rootFolder) => {
    try {
      const files = await fsExtra.readdir(rootFolder, { withFileTypes: true });
      let newContext = '';

      for (const file of files) {
        const filePath = path.join(rootFolder, file.name);
        if (file.isFile()) {
          newContext += await extractContext(filePath);  // 파일별 추출
        }
      }

      sessions.get(socket.id).context = newContext;
      socket.emit('context updated', '맥락이 로드되었습니다.');
    } catch (err) {
      socket.emit('error', '폴더 처리 오류: ' + err.message);
    }
  });

  socket.on('chat message', (msg) => {
    const session = sessions.get(socket.id);
    const fullPrompt = session.context + '\n' + msg;  // 맥락 + 사용자 메시지

    const command = ['gemini', '-m', 'gemini-2.5-pro', '-p', fullPrompt];
    // ... 기존 spawn 로직 (thinking, response 등)
  });

  socket.on('disconnect', () => {
    sessions.delete(socket.id);  // 초기화
  });
});

async function extractContext(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.txt', '.hwpx', '.docx'].includes(ext)) {
    // 로컬 텍스트 추출
    if (ext === '.txt') return await fsExtra.readFile(filePath, 'utf8');
    if (['.hwpx', '.docx'].includes(ext)) {
      const { value } = await mammoth.extractRawText({ path: filePath });
      return value;
    }
  } else if (ext === '.pdf') {
    const data = await fsExtra.readFile(filePath);
    const pdf = await pdfParse(data);
    return pdf.text;
  } else if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    let text = '';
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => { text += row.values.join(' ') + '\n'; });
    });
    return text;
  } else if (ext === '.png') {
    // 이미지: Gemini에게 위임 (내용 추출 후 프롬프트)
    return `이미지 파일 ${filePath}: 이 이미지의 맥락을 추출해 주세요.`;  // 실제 호출은 chat message에서
  }
  return '';  // 지원되지 않음
}