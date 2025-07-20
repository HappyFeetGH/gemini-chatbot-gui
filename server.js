const express = require('express');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');  // 파일 관리용
const fsExtra = require('fs-extra');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');

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

const sessions = new Map();  // 사용자별 맥락 저장 (socket.id 키)

io.on('connection', (socket) => {
  sessions.set(socket.id, { context: '' });  // 초기화

  socket.on('select folder', async (rootFolder) => {
    try {
      let newContext = '';

      // 재귀 스캔 함수 (하위 폴더 지원, 요약 통합)
      async function scanDir(dir) {
        const files = await fsExtra.readdir(dir, { withFileTypes: true });
        for (const file of files) {
          const filePath = path.join(dir, file.name);
          if (file.isDirectory()) {
            await scanDir(filePath);  // 재귀
          } else if (file.isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            if (['.pdf', '.xlsx', '.docx'].includes(ext)) {
              newContext += await getFileSummaryFromGemini(filePath);  // gemini-cli로 요약
            } else {
              newContext += await extractContext(filePath);  // 기존 로컬 추출
            }
          }
        }
      }

      await scanDir(rootFolder);

      sessions.get(socket.id).context = newContext;
      console.log('Context loaded:', newContext.substring(0, 200));  // 디버그 로그
      socket.emit('context updated', '맥락이 로드되었습니다.');
    } catch (err) {
      socket.emit('error', '폴더 처리 오류: ' + err.message);
    }
  });


  socket.on('chat message', ({ prompt, imagePath }) => {  // 이미지 경로 포함 수신
    const session = sessions.get(socket.id);
    let fullPrompt = session.context + '\n' + prompt;
    
    socket.emit('thinking');  // 로딩 스피너 시작 (이전 기능 참조)

    if (imagePath) {      
      fullPrompt += ` \n이미지 분석: ${imagePath}`;  // 프롬프트에 경로 포함 (gemini-cli가 지원할 경우)
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

  socket.on('disconnect', () => {
    sessions.delete(socket.id);  // 초기화
  });
});

async function extractContext(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let content = '';

  if (['.txt', '.md'].includes(ext)) {  // .md 추가
    content = await fsExtra.readFile(filePath, 'utf8');
  } else if (['.hwpx', '.docx'].includes(ext)) {
    const { value } = await mammoth.extractRawText({ path: filePath });
    content = value;
  } else if (ext === '.pdf') {
    const data = await fsExtra.readFile(filePath);
    const pdf = await pdfParse(data);
    content = pdf.text;
  } else if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    let text = '';
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => { text += row.values.join(' ') + '\n'; });
    });
    content = text;
  } else if (ext === '.png') {
    // 이미지: 더 구체적인 프롬프트로 Gemini 위임
    return `이미지 파일 ${filePath}: 이 이미지의 주요 요소와 맥락을 요약해 주세요.\n`;
  }

  // 추출된 내용 요약 (과부하 방지)
  if (content) {
    return `파일 ${filePath}: ${content.substring(0, 1000)}...\n`;  // 1000자 제한
  }
  return '';  // 지원되지 않음
}

async function getFileSummaryFromGemini(filePath) {
  return new Promise((resolve, reject) => {
    const command = [
      'gemini',
      '-m', 'gemini-2.5-pro',
      '-p', `이 파일의 내용을 요약해 주세요: ${filePath}`
      // 지원 시: '--file', filePath 추가
    ];

    const process = spawn(command[0], command.slice(1));
    let summary = '';

    process.stdout.on('data', (data) => { summary += data.toString(); });
    process.stderr.on('data', (data) => { console.error('Gemini error:', data.toString()); });
    process.on('error', (err) => { reject(err); });
    process.on('close', (code) => {
      if (code === 0) {
        resolve(`파일 ${filePath} 요약: ${summary}\n`);
      } else {
        reject(new Error('Gemini summary failed with code ' + code));
      }
    });
  });
}


server.listen(3000, () => console.log('Server running on port 3000'));
