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

// 안전한 파일명 생성 함수
function sanitizeFilename(filename) {
  if (!filename) return 'unnamed_file';
  try {
    let decoded = decodeURIComponent(filename);
    return decoded.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  } catch (e) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_').trim();
  }
}

// 업로드 설정
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });
const contextUpload = multer({ storage }).array('files', 10);


// 정적 파일 서빙
app.use(express.static('public'));

// 이미지 업로드 라우트
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    res.json({ imagePath: req.file.path });
});

app.post('/upload-context', contextUpload, async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: 'No files uploaded' });
        }
        const spaceName = req.body.space || 'default';
        const spaceContextDir = path.join(__dirname, 'context', spaceName);
        if (!fs.existsSync(spaceContextDir)) {
            fs.mkdirSync(spaceContextDir, { recursive: true });
        }

        const uploadedFiles = [];
        for (const file of req.files) {
            const finalFileName = sanitizeFilename(file.originalname);
            const finalPath = path.join(spaceContextDir, finalFileName);
            fs.renameSync(file.path, finalPath);
            uploadedFiles.push(finalFileName);
            console.log(`✓ File moved: ${finalFileName} to space: ${spaceName}`);
        }

        const spaceData = loadSpace(spaceName);
        uploadedFiles.forEach(fileName => {
            if (!spaceData.files.includes(fileName)) {
                spaceData.files.push(fileName);
            }
        });
        saveSpace(spaceName, spaceData);
        
        await extractContextFiles(spaceName);

        res.json({ success: true, extracted: true, fileNames: uploadedFiles });
    } catch (err) {
        console.error(`Upload/Extract error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

const spacesDir = path.join(__dirname, 'spaces');
if (!fs.existsSync(spacesDir)) fs.mkdirSync(spacesDir);

function loadSpace(spaceName) {
    const spacePath = path.join(spacesDir, `${spaceName}.json`);
    if (fs.existsSync(spacePath)) {
        try {
            return JSON.parse(fs.readFileSync(spacePath, 'utf-8'));
        } catch (e) { return { files: [], history: [] }; }
    }
    return { files: [], history: [] };
}

function saveSpace(spaceName, data) {
    const spacePath = path.join(spacesDir, `${spaceName}.json`);
    fs.writeFileSync(spacePath, JSON.stringify(data, null, 2), 'utf-8');
}


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
async function extractContextFiles(spaceName = 'default') {
    // [핵심 2] 모든 결과물은 Space별 extracted 폴더로 가도록 경로 명확화
    const contextDir = path.join(__dirname, 'context', spaceName);
    const extractedDir = path.join(contextDir, 'extracted');

    // 대상 폴더가 없으면 함수 종료
    if (!fs.existsSync(contextDir)) {
        console.log(`[Info] Context directory for space "${spaceName}" does not exist. Skipping extraction.`);
        return;
    }
    // 추출 폴더가 없으면 생성
    if (!fs.existsSync(extractedDir)) {
        fs.mkdirSync(extractedDir, { recursive: true });
    }

    // 디렉토리 내의 파일 목록을 가져오되, 'extracted' 하위 디렉토리는 제외
    const files = fs.readdirSync(contextDir).filter(f => {
        const filePath = path.join(contextDir, f);
        return fs.statSync(filePath).isFile();
    });

    if (files.length === 0) {
        console.log(`[Info] No files to extract in space "${spaceName}".`);
        return;
    }

    console.log(`[Info] Starting extraction for ${files.length} file(s) in space "${spaceName}"...`);
    
    for (const file of files) {
        const filePath = path.join(contextDir, file);
        const ext = path.extname(file).toLowerCase();
        // 모든 결과 파일은 extractedDir에 "_extracted.txt" 접미사를 붙여 저장
        const extractedPath = path.join(extractedDir, `${path.basename(file, ext)}_extracted.txt`);
        
        try {
            // .txt, .md 파일도 extracted 폴더로 '복사'하여 위치 일원화
            if (['.txt', '.md'].includes(ext)) {
                fs.copyFileSync(filePath, extractedPath);
            } else if (ext === '.pdf') {
                const data = await pdfParse(fs.readFileSync(filePath));
                fs.writeFileSync(extractedPath, data.text, 'utf-8');
            } else if (['.jpg', '.png', '.jpeg'].includes(ext)) {
                const metadata = await sharp(filePath).metadata();
                fs.writeFileSync(extractedPath, `Image: ${file}\nDimensions: ${metadata.width}x${metadata.height}`, 'utf-8');
            } else if (ext === '.csv') {
                const rows = [];
                await new Promise((resolve, reject) => {
                    fs.createReadStream(filePath)
                      .pipe(csvParser())
                      .on('data', (row) => rows.push(Object.values(row)))
                      .on('end', resolve)
                      .on('error', reject);
                });
                fs.writeFileSync(extractedPath, tableToMarkdown(rows), 'utf-8');
            } else if (ext === '.xlsx') {
                const workbook = XLSX.readFile(filePath);
                let text = '';
                workbook.SheetNames.forEach(sheetName => {
                    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
                    text += `Sheet: ${sheetName}\n${tableToMarkdown(sheetData)}\n\n`;
                });
                fs.writeFileSync(extractedPath, text, 'utf-8');
            } else if (ext === '.docx') {
                const { value } = await mammoth.convertToMarkdown({ path: filePath });
                fs.writeFileSync(extractedPath, value, 'utf-8');
            } else if (ext === '.hwpx') {
                await extractHwpx(filePath, extractedPath); // HWPX 전용 추출 함수 호출
            } else {
                continue; // 지원하지 않는 확장자는 건너뜀
            }
            console.log(`✓ Extracted: ${file} -> ${path.basename(extractedPath)}`);
        } catch (err) {
            console.error(`✗ Extract error for ${file}: ${err.message}`);
        }
    }
    console.log(`[Success] Extraction completed for space "${spaceName}".`);
}





// 서버 시작 직후 추출 실행
(async () => {
  await extractContextFiles();
})();

// getContext 함수 수정 (Space별 격리)
function getContext(spaceName = 'default') {    
    const extractedDir = path.join(__dirname, 'context', spaceName, 'extracted');
    let context = '';
    if (fs.existsSync(extractedDir)) {
        const files = fs.readdirSync(extractedDir);
        files.forEach(file => {
            context += fs.readFileSync(path.join(extractedDir, file), 'utf-8') + '\n\n';
        });
    }
    return context;
}



// Sequential Thinking MCP 템플릿
const sequentialThinkingTemplate = `
너는 도움이 되는 개인 비서야. 다음 단계를 따라 생각하고 응답해:
Step 1: 사용자의 쿼리를 분석해. (주요 포인트와 의도 파악)
Step 2: 이전 대화 히스토리를 회상하고, 관련된 부분을 참조해. (없으면 무시)
Step 3: ./context에서 제공된 맥락을 적용해. (예: 규칙이나 데이터)
Step 4: 논리적이고 도움이 되는 응답을 생성해. 응답은 친절하고 간결하게.
`;

// Space 목록 헬퍼 추가 (spacesDir 스캔)
function getSpaceList() {
    if (!fs.existsSync(spacesDir)) return ['default'];
    const spaces = fs.readdirSync(spacesDir).map(f => f.replace('.json', ''));
    return spaces.length > 0 ? spaces : ['default'];
}

// 3. API 호출 속도 조절을 위한 Debounce 로직
const extractionDebouncers = new Map();
function debounceExtract(spaceName, delay = 2000) {
    if (extractionDebouncers.has(spaceName)) {
        clearTimeout(extractionDebouncers.get(spaceName));
    }
    const timerId = setTimeout(() => {
        console.log(`⏳ Debounced extraction starting for: ${spaceName}`);
        extractContextFiles(spaceName).catch(err => console.error(`Debounced extraction failed for ${spaceName}: ${err.message}`));
        extractionDebouncers.delete(spaceName);
    }, delay);
    extractionDebouncers.set(spaceName, timerId);
}

const currentSpace = new Map();  
const sessionHistories = new Map();

io.on('connection', (socket) => {
  currentSpace.set(socket.id, 'default');
  sessionHistories.set(socket.id, []);

  socket.on('chat message', ({ prompt, imagePath }) => {
    socket.emit('thinking');

    const currentSpaceName = currentSpace.get(socket.id) || 'default';
    let history = sessionHistories.get(socket.id) || [];
    const userMessage = prompt || '이 이미지를 분석해 주세요.';
    history.push({ role: 'user', content: userMessage });
    if (history.length > 10) history = history.slice(-10);

    // [핵심 수정] 프롬프트 구조화
    const contextData = getContext(currentSpaceName);
    let fullPrompt = sequentialThinkingTemplate + '\n\n---\n\n';
    fullPrompt += '### 참고 자료 (Context)\n';
    fullPrompt += '다음은 사용자가 제공한 파일에서 추출된 내용입니다. 답변의 주요 근거로 사용하세요.\n';
    fullPrompt += contextData ? contextData : '제공된 참고 자료가 없습니다.\n';
    fullPrompt += '\n---\n\n';
    fullPrompt += '### 대화 기록\n';
    fullPrompt += history.map(msg => `${msg.role}: ${msg.content}`).join('\n') + '\n';
    fullPrompt += `user: ${userMessage}\n`;
    if (imagePath) fullPrompt += ` [이미지 파일: ${imagePath}]`;
    fullPrompt = fullPrompt.trim();

    const tempFilePath = path.join(__dirname, 'temp_prompt.txt');
    fs.writeFileSync(tempFilePath, fullPrompt, 'utf-8');

    const command = ['gemini', '-m', 'gemini-2.5-pro', '-p', `@${tempFilePath}`];
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
      
      // 수정: 현재 Space 데이터를 다시 로드해서 저장
      const currentSpaceName = currentSpace.get(socket.id) || 'default';
      const currentSpaceData = loadSpace(currentSpaceName);
      saveSpace(currentSpaceName, { 
        files: currentSpaceData.files || [], 
        history: history 
      });
    });

  });

  socket.on('switch space', (spaceName) => {
      currentSpace.set(socket.id, spaceName);
      const spaceData = loadSpace(spaceName);
      sessionHistories.set(socket.id, spaceData.history || []);
      socket.emit('space switched', { name: spaceName, files: spaceData.files || [], history: spaceData.history || [] });
      debounceExtract(spaceName); // 전환 시 Debounce된 추출 호출
  });


  socket.on('list spaces', () => {
    socket.emit('space list', getSpaceList());
  });

  socket.on('add space', (spaceName) => {
      if (spaceName) {
          saveSpace(spaceName, { files: [], history: [] });
          io.emit('space list', getSpaceList());
      }
  });


  socket.on('delete space', (spaceName) => {
    if (spaceName === 'default') {
      socket.emit('error', 'Cannot delete default space');
      return;
    }
    
    // JSON 파일 삭제
    const spacePath = path.join(spacesDir, `${spaceName}.json`);
    if (fs.existsSync(spacePath)) fs.unlinkSync(spacePath);
    
    // 해당 Space의 context 폴더 전체 삭제
    const spaceContextDir = path.join(__dirname, 'context', spaceName);
    if (fs.existsSync(spaceContextDir)) {
      fs.rmSync(spaceContextDir, { recursive: true, force: true });
      console.log(`Deleted space folder: ${spaceContextDir}`);
    }
    
    io.emit('space list', getSpaceList());
    console.log(`Space ${spaceName} completely deleted`);
  });


  socket.on('list files', (spaceName) => {
    const spaceData = loadSpace(spaceName);
    socket.emit('file list', spaceData.files);
  });

  socket.on('delete file', ({ spaceName, fileName }) => {
      try {
          const spaceData = loadSpace(spaceName);
          spaceData.files = spaceData.files.filter(f => f !== fileName);
          saveSpace(spaceName, spaceData);

          // 1. 원본 파일 삭제
          const originalFilePath = path.join(__dirname, 'context', spaceName, fileName);
          if (fs.existsSync(originalFilePath)) {
              fs.unlinkSync(originalFilePath);
              console.log(`✓ Deleted original file: ${originalFilePath}`);
          }

          // 2. 추출된 .txt 파일 삭제
          const extractedFileName = `${path.basename(fileName, path.extname(fileName))}_extracted.txt`;
          const extractedFilePath = path.join(__dirname, 'context', spaceName, 'extracted', extractedFileName);
          if (fs.existsSync(extractedFilePath)) {
              fs.unlinkSync(extractedFilePath);
              console.log(`✓ Deleted extracted file: ${extractedFilePath}`);
          }
          
          // 클라이언트에 파일 목록 업데이트 알림
          io.to(socket.id).emit('file list', spaceData.files);

      } catch (error) {
          console.error(`Failed to delete file ${fileName} in space ${spaceName}:`, error);
      }
  });

  socket.on('extract context', async (spaceName) => {
    try {
      await extractContextFiles(spaceName);
      socket.emit('extraction done', spaceName);
      console.log(`Manual extraction completed for space: ${spaceName}`);
    } catch (err) {
      console.error(`Manual extraction failed for ${spaceName}: ${err.message}`);
      socket.emit('extraction error', err.message);
    }
  });

  socket.on('disconnect', () => {
    sessionHistories.delete(socket.id);
    currentSpace.delete(socket.id);  // 정리 (추가)
  });
});



server.listen(3000, () => console.log('Server running on port 3000'));
