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

// [개선] hwpx専用 추출 함수 (hwpx_simple_converter 로직)
async function extractHwpx(filePath, extractedPath) {
  try {
    const zip = new AdmZip(filePath);
    const sectionEntry = zip.getEntry('Contents/section0.xml');
    if (!sectionEntry) throw new Error('section0.xml not found');

    const xmlData = sectionEntry.getData().toString('utf-8');
    const parser = new xml2js.Parser({
      explicitRoot: false,
      tagNameProcessors: [name => name.replace(/.*:/, '')]
    });
    const xml = await parser.parseStringPromise(xmlData);

    let resultText = '';
    if (xml && xml.p) {
      xml.p.forEach(p => {
        let paragraphText = selectiveRecursiveExtract(p);
        if (paragraphText) resultText += paragraphText + '\n\n';

        if (p.run) {
          p.run.forEach(run => {
            if (run.tbl) {
              const tableData = parseTable(run.tbl[0]);
              resultText += tableToMarkdown(tableData);
            }
          });
        }
      });
    }
    fs.writeFileSync(extractedPath, resultText.trim() || 'No content extracted', 'utf-8');
    console.log(`Extracted HWPX: ${path.basename(filePath)}`);
  } catch (err) {
    console.error(`HWPX extract error: ${err.message}`);
  }
}

// [hwpx_simple_converter 통합] HWPX 텍스트 추출 함수
function selectiveRecursiveExtract(element) {
  let text = '';
  if (typeof element === 'string') return element.trim();
  if (!element || typeof element !== 'object') return text;

  if (element.t) {
    const t_elements = Array.isArray(element.t) ? element.t : [element.t];
    t_elements.forEach(t => {
      if (t && t._) text += t._.trim() + ' ';
      else if (typeof t === 'string') text += t.trim() + ' ';
    });
  }

  for (const key in element) {
    if (key === '$') continue;  // 속성 무시
    if (Array.isArray(element[key])) {
      element[key].forEach(child => text += selectiveRecursiveExtract(child) + ' ');
    } else if (typeof element[key] === 'object') {
      text += selectiveRecursiveExtract(element[key]) + ' ';
    }
  }
  return text.trim();
}

// [hwpx_simple_converter 통합] 테이블 파싱 함수
function parseTable(tblElement) {
  const tableData = [];
  if (!tblElement || !tblElement.tr) return tableData;

  tblElement.tr.forEach(tr => {
    const rowData = [];
    if (tr.tc) {
      tr.tc.forEach(tc => {
        const cellText = selectiveRecursiveExtract(tc);
        rowData.push(cellText);
      });
    }
    tableData.push(rowData);
  });
  return tableData;
}

// [hwpx_simple_converter 통합] Markdown 테이블 생성 함수
function tableToMarkdown(tableData) {
  if (!tableData || tableData.length === 0) return '';
  const colCount = Math.max(...tableData.map(row => row.length));
  const normalizedData = tableData.map(row => {
    const newRow = [...row];
    while (newRow.length < colCount) newRow.push('');
    return newRow;
  });

  const header = normalizedData[0].map(h => h || ' ').join(' | ');
  const separator = normalizedData[0].map(() => '---').join(' | ');
  const body = normalizedData.slice(1).map(row => '| ' + row.map(c => c || ' ').join(' | ') + ' |').join('\n');
  return `| ${header} |\n| ${separator} |\n${body}\n\n`;
}

// 서버 시작 시 ./context 폴더 스캔 및 추출 함수 (확장자별 최적화)
async function extractContextFiles() {
  const contextDir = path.join(__dirname, 'context');
  if (!fs.existsSync(contextDir)) return;

  const files = fs.readdirSync(contextDir);
  for (const file of files) {
    const filePath = path.join(contextDir, file);
    if (!fs.statSync(filePath).isFile()) continue;  // 파일만 처리

    const ext = path.extname(file).toLowerCase();
    const extractedPath = path.join(extractedDir, `${path.basename(file, ext)}_extracted.txt`);

    try {
      if (['.txt', '.md'].includes(ext)) {
        fs.copyFileSync(filePath, extractedPath);
        console.log(`Copied text file: ${file}`);
      } else if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        fs.writeFileSync(extractedPath, data.text, 'utf-8');
        console.log(`Extracted PDF: ${file}`);
      } else if (['.jpg', '.png', '.jpeg'].includes(ext)) {
        const metadata = await sharp(filePath).metadata();
        const text = `Image: ${file}\nDimensions: ${metadata.width}x${metadata.height}\nFormat: ${metadata.format}`;
        fs.writeFileSync(extractedPath, text, 'utf-8');
        console.log(`Extracted Image: ${file}`);
      } else if (ext === '.csv') {
        let rows = [];
        await new Promise(resolve => {
          fs.createReadStream(filePath)
            .pipe(csvParser())
            .on('data', row => rows.push(row))
            .on('end', resolve);
        });
        const text = tableToMarkdown(rows);
        fs.writeFileSync(extractedPath, text, 'utf-8');
        console.log(`Extracted CSV: ${file}`);
      } else if (ext === '.xlsx') {
        const workbook = XLSX.readFile(filePath);
        let text = '';
        workbook.SheetNames.forEach(sheetName => {
          const sheet = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
          text += `Sheet: ${sheetName}\n${sheet}\n\n`;
        });
        fs.writeFileSync(extractedPath, text, 'utf-8');
        console.log(`Extracted XLSX: ${file}`);
      } else if (ext === '.docx') {
        const result = await mammoth.convertToMarkdown({ path: filePath });
        fs.writeFileSync(extractedPath, result.value, 'utf-8');
        console.log(`Extracted DOCX: ${file}`);
      } else if (ext === '.hwpx') {
        await extractHwpx(filePath, extractedPath);  // hwpx専用 함수 호출
      } else {
        console.log(`Skipping unsupported extension: ${file} (${ext})`);
      }
    } catch (err) {
      console.error(`Extract error for ${file}: ${err.message}`);
    }
  }
}

// 서버 시작 직후 추출 실행
(async () => {
  await extractContextFiles();
})();

// ./context/extracted 폴더의 txt만 읽기
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

// 세션 히스토리 저장
const sessionHistories = new Map();

// Sequential Thinking MCP 템플릿
const sequentialThinkingTemplate = `
너는 도움이 되는 개인 비서야. 다음 단계를 따라 생각하고 응답해:
Step 1: 사용자의 쿼리를 분석해. (주요 포인트와 의도 파악)
Step 2: 이전 대화 히스토리를 회상하고, 관련된 부분을 참조해. (없으면 무시)
Step 3: ./context에서 제공된 맥락을 적용해. (예: 규칙이나 데이터)
Step 4: 논리적이고 도움이 되는 응답을 생성해. 응답은 친절하고 간결하게.
`;

io.on('connection', (socket) => {
  sessionHistories.set(socket.id, []);

  socket.on('chat message', ({ prompt, imagePath }) => {
    socket.emit('thinking');

    let history = sessionHistories.get(socket.id) || [];
    const userMessage = prompt || '이 이미지를 분석해 주세요.';
    history.push({ role: 'user', content: userMessage });
    if (history.length > 10) history = history.slice(-10);

    let fullPrompt = sequentialThinkingTemplate + '\n\n';
    fullPrompt += getContext() + '\n\n';
    fullPrompt += '대화 히스토리:\n' + history.map(msg => `${msg.role}: ${msg.content}`).join('\n') + '\n\n';
    if (imagePath) fullPrompt += ` [이미지 파일: ${imagePath}]`;
    fullPrompt = fullPrompt.trim();

    const tempFilePath = path.join(__dirname, 'temp_prompt.txt');
    fs.writeFileSync(tempFilePath, fullPrompt, 'utf-8');

    const command = [
      'gemini',
      '-m', 'gemini-2.5-pro',
      '-p', `@${tempFilePath}`
    ];

    const geminiProcess = spawn(command[0], command.slice(1));

    let response = '';
    geminiProcess.stdout.on('data', (data) => response += data.toString());

    geminiProcess.stderr.on('data', (data) => console.error('Gemini error:', data.toString()));

    geminiProcess.on('error', (err) => {
      console.error('Spawn error:', err.message);
      socket.emit('chat message', 'Error: ' + err.message);
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    });

    geminiProcess.on('close', (code) => {
      socket.emit('chat done');
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
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

  socket.on('disconnect', () => sessionHistories.delete(socket.id));
});

server.listen(3000, () => console.log('Server running on port 3000'));
