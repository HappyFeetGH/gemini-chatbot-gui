const express = require('express');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');  // PDF
const sharp = require('sharp');  // 이미지
const csvParser = require('csv-parser');  // CSV
const XLSX = require('xlsx');  // XLSX
const mammoth = require('mammoth');  // DOCX
const AdmZip = require('adm-zip');  // HWPX ZIP
const xml2js = require('xml2js');  // HWPX XML 파싱

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 업로드 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// 정적 파일 서빙
app.use(express.static('public'));

// 이미지 업로드 라우트
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ imagePath: req.file.path });
});

// 추출 폴더 설정
const extractedDir = path.join(__dirname, 'context', 'extracted');
if (!fs.existsSync(extractedDir)) fs.mkdirSync(extractedDir, { recursive: true });

// 서버 시작 시 ./context 폴더 스캔 및 추출 함수
async function extractContextFiles() {
  const contextDir = path.join(__dirname, 'context');
  if (!fs.existsSync(contextDir)) return;

  const files = fs.readdirSync(contextDir);
  for (const file of files) {  // 순차 처리로 CPU 부하 분산
    const filePath = path.join(contextDir, file);
    if (fs.statSync(filePath).isFile()) {
      const ext = path.extname(file).toLowerCase();
      const extractedPath = path.join(extractedDir, `${path.basename(file, ext)}_extracted.txt`);

      try {
        if (['.txt', '.md'].includes(ext)) {
          // 텍스트: 그대로 복사
          fs.copyFileSync(filePath, extractedPath);
        } else if (ext === '.pdf') {
          // PDF: 텍스트 추출
          const dataBuffer = fs.readFileSync(filePath);
          const data = await pdfParse(dataBuffer);
          fs.writeFileSync(extractedPath, data.text, 'utf-8');
          console.log(`Extracted PDF: ${file}`);
        } else if (['.jpg', '.png', '.jpeg'].includes(ext)) {
          // 이미지: 메타데이터
          const metadata = await sharp(filePath).metadata();
          const text = `Image: ${file}\nDimensions: ${metadata.width}x${metadata.height}\nFormat: ${metadata.format}\n(추가 분석 필요)`;
          fs.writeFileSync(extractedPath, text, 'utf-8');
          console.log(`Extracted Image: ${file}`);
        } else if (ext === '.csv') {
          // CSV: 파싱해 Markdown 테이블로 변환
          let rows = [];
          fs.createReadStream(filePath)
            .pipe(csvParser())
            .on('data', (row) => rows.push(row))
            .on('end', () => {
              let text = tableToMarkdown(rows);
              fs.writeFileSync(extractedPath, text, 'utf-8');
              console.log(`Extracted CSV: ${file}`);
            });
        } else if (ext === '.xlsx') {
          // XLSX: 시트 추출해 텍스트로
          const workbook = XLSX.readFile(filePath);
          let text = '';
          workbook.SheetNames.forEach(sheetName => {
            const sheet = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
            text += `Sheet: ${sheetName}\n${sheet}\n\n`;
          });
          fs.writeFileSync(extractedPath, text, 'utf-8');
          console.log(`Extracted XLSX: ${file}`);
        } else if (ext === '.docx') {
          // DOCX: 텍스트/Markdown 추출
          const result = await mammoth.convertToMarkdown({ path: filePath });
          fs.writeFileSync(extractedPath, result.value, 'utf-8');
          console.log(`Extracted DOCX: ${file}`);
        } else if (ext === '.hwpx') {
          // HWPX: ZIP 추출 후 XML 파싱 (제공된 Python 코드 포팅)
          const zip = new AdmZip(filePath);
          const tempDir = path.join(__dirname, 'temp_hwpx');
          fs.mkdirSync(tempDir, { recursive: true });
          zip.extractAllTo(tempDir, true);

          let resultText = '';
          const contentsDir = path.join(tempDir, 'Contents');
          const sectionFiles = fs.readdirSync(contentsDir).filter(f => f.startsWith('section') && f.endsWith('.xml')).map(f => path.join(contentsDir, f));

          for (const sectionFile of sectionFiles.sort()) {
            const xmlData = fs.readFileSync(sectionFile, 'utf-8');
            await xml2js.parseStringPromise(xmlData).then(root => {
              // 재귀적으로 요소 탐색 (t 태그 텍스트 추출, tbl 테이블 처리)
              function traverse(element) {
                if (element['t'] && element['t'].length) {
                  element['t'].forEach(t => {
                    if (t['_']) resultText += t['_'] + '\n';
                  });
                } else if (element['tbl'] && element['tbl'].length) {
                  element['tbl'].forEach(tbl => {
                    const tableData = extractTableData(tbl);
                    if (tableData) resultText += tableToMarkdown(tableData) + '\n';
                  });
                }
                for (const key in element) {
                  if (Array.isArray(element[key])) {
                    element[key].forEach(child => traverse(child));
                  }
                }
              }
              traverse(root);
            });
          }
          fs.writeFileSync(extractedPath, resultText, 'utf-8');
          console.log(`Extracted HWPX: ${file}`);
          fs.rmSync(tempDir, { recursive: true, force: true });  // 임시 폴더 삭제
        } else {
          console.log(`Skipping unsupported file: ${file}`);
        }
      } catch (err) {
        console.error(`Extract error for ${file}: ${err.message}`);
      }
    }
  }
}

// 도우미 함수: 테이블 데이터 추출 (HWPX용, Python 코드 기반)
function extractTableData(tbl) {
  const rows = parseInt(tbl['$'].rowCnt || 0);
  const cols = parseInt(tbl['$'].colCnt || 0);
  const tableData = Array.from({ length: rows }, () => Array(cols).fill(''));
  if (tbl['tc']) {
    tbl['tc'].forEach(tc => {
      const rowIdx = parseInt(tc['$'].rowIdx || 0);
      const colIdx = parseInt(tc['$'].colIdx || 0);
      let cellText = '';
      if (tc['t']) tc['t'].forEach(t => { if (t['_']) cellText += t['_'].trim() + ' '; });
      if (rowIdx >= 0 && rowIdx < rows && colIdx >= 0 && colIdx < cols) {
        tableData[rowIdx][colIdx] = cellText.trim();
      }
    });
  }
  return tableData;
}

// 도우미 함수: 테이블을 Markdown으로 (CSV/HWPX 공용)
function tableToMarkdown(tableData) {
  if (!tableData || !tableData.length || !tableData[0].length) return '';
  let markdown = '| ' + tableData[0].join(' | ') + ' |\n';
  markdown += '| ' + tableData[0].map(() => '---').join(' | ') + ' |\n';
  tableData.slice(1).forEach(row => {
    markdown += '| ' + row.join(' | ') + ' |\n';
  });
  return markdown;
}

// 서버 시작 직후 추출 실행 (async 호출)
(async () => {
  await extractContextFiles();
})();


// ./context/extracted 폴더의 txt만 읽기 (기존 getContext 유지)
function getContext() {
  let context = '';
  if (fs.existsSync(extractedDir)) {
    const files = fs.readdirSync(extractedDir);
    files.forEach(file => {
      const filePath = path.join(extractedDir, file);
      if (fs.statSync(filePath).isFile() && path.extname(file) === '.txt') {
        try {
          context += fs.readFileSync(filePath, 'utf-8') + '\n\n';
        } catch (err) {
          console.error(`Error reading extracted ${file}: ${err.message}`);
        }
      }
    });
  }
  return context;
}

// 세션 히스토리 저장 (소켓 ID별 Map)
const sessionHistories = new Map();  // 키: socket.id, 값: 배열 [{role: 'user'/'assistant', content: string}]


// Sequential Thinking MCP 템플릿 (단계적 사고 유도)
const sequentialThinkingTemplate = `
너는 도움이 되는 개인 비서야. 다음 단계를 따라 생각하고 응답해:
Step 1: 사용자의 쿼리를 분석해. (주요 포인트와 의도 파악)
Step 2: 이전 대화 히스토리를 회상하고, 관련된 부분을 참조해. (없으면 무시)
Step 3: ./context에서 제공된 맥락을 적용해. (예: 규칙이나 데이터)
Step 4: 논리적이고 도움이 되는 응답을 생성해. 응답은 친절하고 간결하게.
`;

io.on('connection', (socket) => {
  // 새 연결 시 히스토리 초기화
  sessionHistories.set(socket.id, []);

  socket.on('chat message', ({ prompt, imagePath }) => {
    socket.emit('thinking');

    // 히스토리 가져오기 및 사용자 메시지 추가 (기존 유지)
    let history = sessionHistories.get(socket.id) || [];
    const userMessage = prompt || '이 이미지를 분석해 주세요.';
    history.push({ role: 'user', content: userMessage });
    if (history.length > 10) history = history.slice(-10);  // 길이 제한

    // fullPrompt 구성 (기존 유지)
    let fullPrompt = sequentialThinkingTemplate + '\n\n';
    fullPrompt += getContext() + '\n\n';
    fullPrompt += '대화 히스토리:\n' + history.map(msg => `${msg.role}: ${msg.content}`).join('\n') + '\n\n';
    if (imagePath) {
      fullPrompt += ` [이미지 파일: ${imagePath}]`;
    }
    fullPrompt = fullPrompt.trim();

    // 파일 기반 전달: 임시 파일 생성
    const tempFilePath = path.join(__dirname, 'temp_prompt.txt');
    fs.writeFileSync(tempFilePath, fullPrompt, 'utf-8');

    // 명령어 수정: -p @temp_prompt.txt
    const command = [
      'gemini',
      '-m', 'gemini-2.5-pro',
      '-p', `@${tempFilePath}`  // @file 형식으로 파일 참조
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
      console.error('Spawn error:', err.message);
      socket.emit('chat message', 'Error: ' + err.message);
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);  // 에러 시 파일 삭제
    });

    geminiProcess.on('close', (code) => {
      socket.emit('chat done');
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);  // 파일 삭제
      if (code === 0) {
        socket.emit('chat message', response);
        history.push({ role: 'assistant', content: response });
        sessionHistories.set(socket.id, history);
        if (imagePath) fs.unlinkSync(imagePath);
      } else {
        socket.emit('chat message', 'Error: gemini-cli failed with code ' + code);
      }
    });
  });

  // 연결 종료 시 히스토리 삭제 (메모리 절약)
  socket.on('disconnect', () => {
    sessionHistories.delete(socket.id);
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
