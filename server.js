const express = require('express');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
// 필요한 모든 라이브러리
const pdfParse = require('pdf-parse');
const sharp = require('sharp');
const csvParser = require('csv-parser');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 포트 변경 ---
const PORT = 4000; // 3000에서 4000으로 변경

// --- MCP 도구 함수 정의 ---

// [핵심 MCP 1] writeFile: 파일을 생성하는 도구
function writeFile(filePath, content, spaceName = 'default') {
  try {
    // 절대경로 처리 (보안상 현재 프로젝트 디렉토리 내에서만 허용)
    let fullPath;
    if (path.isAbsolute(filePath)) {
      // 절대경로일 경우 프로젝트 루트 기준으로 제한
      fullPath = path.resolve(__dirname, filePath.substring(1));
    } else {
      // 상대경로일 경우 현재 스페이스의 context 폴더 기준
      fullPath = path.resolve(__dirname, 'context', spaceName, filePath);
    }

    // 디렉토리가 존재하지 않으면 생성
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf-8');
    
    console.log(`[MCP] File created: ${fullPath}`);
    return {
      success: true,
      message: `파일 '${path.basename(fullPath)}'을 성공적으로 생성했습니다.`,
      filePath: fullPath,
      relativePath: path.relative(__dirname, fullPath)
    };
  } catch (error) {
    console.error(`[MCP] File creation failed: ${error.message}`);
    return {
      success: false,
      message: `파일 생성 중 오류 발생: ${error.message}`,
      filePath: null
    };
  }
}

// --- 기존 파일명 처리 및 업로드 설정 ---
function sanitizeFilename(filename) {
  if (!filename) return 'unnamed_file';
  try {
    let decoded = decodeURIComponent(filename);
    return decoded.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  } catch (e) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_').trim();
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const contextUpload = multer({ storage }).array('files', 10);

// --- 서버 라우트 ---

app.use(express.static('public'));

// [새로운 기능] 파일 다운로드 라우트
app.get('/download/:spaceName/:fileName', (req, res) => {
  try {
    const { spaceName, fileName } = req.params;
    const filePath = path.join(__dirname, 'context', spaceName, fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('파일을 찾을 수 없습니다.');
    }
    
    // 파일 다운로드 (브라우저에서 다운로드 대화상자 표시)
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error(`Download error: ${err.message}`);
        res.status(500).send('다운로드 중 오류가 발생했습니다.');
      }
    });
  } catch (error) {
    console.error(`Download route error: ${error.message}`);
    res.status(500).send('서버 오류');
  }
});

app.post('/upload', multer({ storage }).single('image'), (req, res) => {
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

// --- Space 및 파일 처리 헬퍼 함수 ---
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

// HWPX 관련 함수들 (기존 유지)
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
    if (key === '$') continue;
    if (Array.isArray(element[key])) {
      element[key].forEach(child => text += selectiveRecursiveExtract(child) + ' ');
    } else if (typeof element[key] === 'object') {
      text += selectiveRecursiveExtract(element[key]) + ' ';
    }
  }
  return text.trim();
}

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

async function extractHwpx(filePath, extractedPath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`HWPX file not found: ${filePath}`);
    }
    
    const zip = new AdmZip(filePath);
    const sectionEntry = zip.getEntry('Contents/section0.xml');
    if (!sectionEntry) throw new Error('section0.xml not found in HWPX');

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
  } catch (err) {
    console.error(`HWPX extract error: ${err.message}`);
    throw err;
  }
}

async function extractContextFiles(spaceName = 'default') {
    const contextDir = path.join(__dirname, 'context', spaceName);
    const extractedDir = path.join(contextDir, 'extracted');

    if (!fs.existsSync(contextDir)) {
        console.log(`[Info] Context directory for space "${spaceName}" does not exist. Skipping extraction.`);
        return;
    }
    if (!fs.existsSync(extractedDir)) {
        fs.mkdirSync(extractedDir, { recursive: true });
    }

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
        const extractedPath = path.join(extractedDir, `${path.basename(file, ext)}_extracted.txt`);
        
        try {
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
                await extractHwpx(filePath, extractedPath);
            } else {
                continue;
            }
            console.log(`✓ Extracted: ${file} -> ${path.basename(extractedPath)}`);
        } catch (err) {
            console.error(`✗ Extract error for ${file}: ${err.message}`);
        }
    }
    console.log(`[Success] Extraction completed for space "${spaceName}".`);
}

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

function getSpaceList() {
    if (!fs.existsSync(spacesDir)) return ['default'];
    const spaces = fs.readdirSync(spacesDir).map(f => f.replace('.json', ''));
    return spaces.length > 0 ? spaces : ['default'];
}

// --- MCP 응답 파싱 함수 ---
function parseToolCall(response) {
  console.log('[DEBUG] Raw Gemini response:', response.substring(0, 200) + '...');
  
  const patterns = [
    /\[TOOL_CALL:\s*writeFile\s*\(\s*['"](.*?)['"],\s*['"](.*?)['"]\s*\)\]/s,
    /\[TOOL_CALL:\s*writeFile\((.*?),\s*(.*?)\)\]/s,
    /writeFile\s*\(\s*['"](.*?)['"],\s*['"](.*?)['"]\s*\)/s
  ];
  
  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match) {
      console.log('[DEBUG] Tool call matched:', match);
      
      const [filePath, content] = [match[1], match[2]];
      
      // [핵심] 예시 값 감지 및 무시
      if (filePath.includes('실제파일명') || content.includes('실제내용') || 
          filePath === 'filename.ext' || content === 'content') {
        console.log('[WARNING] Template example detected, ignoring tool call');
        return null;
      }
      
      return { functionName: 'writeFile', args: [filePath, content] };
    }
  }
  
  console.log('[DEBUG] No valid tool call found in response');
  return null;
}

// --- Socket.IO 로직 ---

const currentSpace = new Map();
const sessionHistories = new Map();

// [개선] Sequential Thinking MCP 템플릿
const sequentialThinkingTemplate = `
당신은 한국어를 사용하는 개인 비서입니다. 

### 업무 절차 ###
1. 사용자 요청 분석
2. 대화 히스토리 참조  
3. 제공된 맥락 활용
4. 적절한 응답 생성

### 파일 생성 규칙 ###
사용자가 명시적으로 파일 생성을 요청할 때만 다음 형식으로 응답하세요:

[TOOL_CALL: writeFile("파일명.확장자", "내용")]

- "파일명.확장자": 사용자가 지정하거나 적절한 이름 사용
- "내용": 이전 대화에서 유추한 실제 내용 사용
- 이전 대화의 맥락을 반드시 반영하세요
- 한국어로만 응답하세요
- 요청하지 않았다면 절대 도구를 호출하지 마세요
`;

io.on('connection', (socket) => {
    sessionHistories.set(socket.id, []);
    currentSpace.set(socket.id, 'default');

    socket.on('list spaces', () => {
        socket.emit('space list', getSpaceList());
    });

    socket.on('add space', async (spaceName) => {
        if (spaceName) {
            saveSpace(spaceName, { files: [], history: [] });
            try {
                await extractContextFiles(spaceName);
            } catch (err) {
                console.error(`Auto-extraction failed for ${spaceName}: ${err.message}`);
            }
            io.emit('space list', getSpaceList());
        }
    });

    socket.on('switch space', async (spaceName) => {
        currentSpace.set(socket.id, spaceName);
        const spaceData = loadSpace(spaceName);
        sessionHistories.set(socket.id, spaceData.history || []);
        
        const spaceContextDir = path.join(__dirname, 'context', spaceName);
        if (fs.existsSync(spaceContextDir)) {
            try {
                await extractContextFiles(spaceName);
            } catch (err) {
                console.error(`Auto-extraction failed for ${spaceName}: ${err.message}`);
            }
        }
        
        socket.emit('space switched', { 
            name: spaceName, 
            files: spaceData.files || [], 
            history: spaceData.history || [] 
        });
    });

    socket.on('delete space', (spaceName) => {
        if (spaceName === 'default') {
            socket.emit('error', 'Cannot delete default space');
            return;
        }
        
        const spacePath = path.join(spacesDir, `${spaceName}.json`);
        if (fs.existsSync(spacePath)) fs.unlinkSync(spacePath);
        
        const spaceContextDir = path.join(__dirname, 'context', spaceName);
        if (fs.existsSync(spaceContextDir)) {
            fs.rmSync(spaceContextDir, { recursive: true, force: true });
        }
        
        io.emit('space list', getSpaceList());
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

            const originalFilePath = path.join(__dirname, 'context', spaceName, fileName);
            if (fs.existsSync(originalFilePath)) {
                fs.unlinkSync(originalFilePath);
            }

            const extractedFileName = `${path.basename(fileName, path.extname(fileName))}_extracted.txt`;
            const extractedFilePath = path.join(__dirname, 'context', spaceName, 'extracted', extractedFileName);
            if (fs.existsSync(extractedFilePath)) {
                fs.unlinkSync(extractedFilePath);
            }
            
            io.to(socket.id).emit('file list', spaceData.files);

        } catch (error) {
            console.error(`Failed to delete file ${fileName} in space ${spaceName}:`, error);
        }
    });

    // [핵심 MCP] 채팅 메시지 처리 (도구 호출 기능 포함)    
    socket.on('chat message', ({ prompt, imagePath }) => {
      socket.emit('thinking');
      
      const currentSpaceName = currentSpace.get(socket.id) || 'default';
      let history = sessionHistories.get(socket.id) || [];
      const userMessage = prompt || '이 이미지를 분석해 주세요.';
      history.push({ role: 'user', content: userMessage });
      if (history.length > 10) history = history.slice(-10);

      const contextData = getContext(currentSpaceName);
      
      // [핵심 개선] 맥락을 도구 호출에 명시적으로 연결
      let fullPrompt = sequentialThinkingTemplate + '\n\n';
      
      fullPrompt += '=== 현재 상황 ===\n';
      fullPrompt += `사용자의 최신 요청: "${userMessage}"\n`;
      fullPrompt += `현재 스페이스: ${currentSpaceName}\n\n`;
      
      const isFileRequest = /파일|저장|생성|만들어|txt|md/.test(userMessage);
      if (isFileRequest) {
          fullPrompt += '🚨 파일 생성 모드 활성화 🚨\n';
          fullPrompt += '사용자가 파일 생성을 요청했습니다.\n';
          fullPrompt += '반드시 [TOOL_CALL: writeFile("구체적파일명", "실제내용")] 형식으로 응답하세요.\n';
          fullPrompt += '파일명: 사용자 지정 또는 적절한 이름 (e.g., sad_story.txt)\n';
          fullPrompt += '내용: 이전 대화에서 생성된 실제 내용 사용 (e.g., 슬픈 이야기 전체 텍스트)\n';
          fullPrompt += '이전 대화에서 생성된 내용이 없다면, 새로 만들어서 사용하세요.\n\n';
      }
      
      fullPrompt += '=== 대화 기록 (최근 5개) ===\n';
      history.slice(-5).forEach(msg => {
          fullPrompt += `${msg.role}: ${msg.content}\n`;
      });
      
      fullPrompt += '\n=== 참고 자료 ===\n';
      fullPrompt += contextData || '제공된 참고 자료가 없습니다.\n';
      
      if (imagePath) fullPrompt += `\n=== 첨부 이미지 ===\n${imagePath}\n`;
      
      fullPrompt += '\n=== 응답 요구사항 ===\n';
      fullPrompt += '- 한국어로 응답\n';
      fullPrompt += '- 이전 대화 맥락 유지\n';
      if (isFileRequest) {
          fullPrompt += '- 파일 생성 시 [TOOL_CALL: writeFile("실제파일명", "실제내용")] 형식 필수\n';
      }
      fullPrompt += '\n지금 응답하세요:';

      const tempFilePath = path.join(__dirname, 'temp_prompt.txt');
      fs.writeFileSync(tempFilePath, fullPrompt, 'utf-8');

      console.log('[DEBUG] Sending enhanced prompt to Gemini...');
      console.log('[DEBUG] File request detected:', isFileRequest);
      
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
              console.log('[DEBUG] Gemini response (first 300 chars):', response.substring(0, 300));
              
              // [개선된] 도구 호출 처리
              const toolCall = parseToolCall(response);
              
              if (toolCall && toolCall.functionName === 'writeFile') {
                  console.log('[DEBUG] Processing writeFile with args:', toolCall.args);
                  
                  const [filePath, content] = toolCall.args;
                  
                  // 예시 데이터 사용 방지 검증
                  if (filePath.includes('구체적파일명') || content.includes('실제내용') || 
                      filePath === 'filename.ext' || content === 'content') {
                      console.log('[WARNING] Template example detected, ignoring tool call');
                      const fallbackResponse = `죄송합니다. 구체적인 파일명과 내용을 지정해주세요. 예를 들어:
  - 파일명: sad_story.txt
  - 내용: 실제 슬픈 이야기

  다시 요청해주시면 정확하게 처리하겠습니다.`;
                      socket.emit('chat message', fallbackResponse);
                      history.push({ role: 'assistant', content: fallbackResponse });
                  } else {
                      // 정상적인 파일 생성 처리
                      const result = writeFile(filePath, content, currentSpaceName);
                      
                      let finalResponse;
                      if (result.success) {
                          const downloadUrl = `http://localhost:${PORT}/download/${currentSpaceName}/${path.basename(result.filePath)}`;
                          finalResponse = `✅ ${result.message}

  📄 파일 내용 미리보기:
  ${content.length > 100 ? content.substring(0, 100) + '...' : content}

  📁 [파일 다운로드](${downloadUrl})

  파일 위치: ${result.filePath}`;
                          
                          // 스페이스 파일 목록 업데이트
                          const spaceData = loadSpace(currentSpaceName);
                          const fileName = path.basename(result.filePath);
                          if (!spaceData.files.includes(fileName)) {
                              spaceData.files.push(fileName);
                              saveSpace(currentSpaceName, { ...spaceData, history });
                          }
                          
                          console.log('[SUCCESS] File created successfully:', result.filePath);
                      } else {
                          finalResponse = `❌ 파일 생성 실패: ${result.message}`;
                      }
                      
                      socket.emit('chat message', finalResponse);
                      history.push({ role: 'assistant', content: finalResponse });
                  }
              } else {
                  console.log('[DEBUG] No valid tool call, sending normal response');
                  socket.emit('chat message', response);
                  history.push({ role: 'assistant', content: response });
              }
              
              sessionHistories.set(socket.id, history);
              if (imagePath) fs.unlinkSync(imagePath);
          } else {
              socket.emit('chat message', 'Error: gemini-cli failed with code ' + code);
          }
      });
  });


    socket.on('disconnect', () => {
        sessionHistories.delete(socket.id);
        currentSpace.delete(socket.id);
    });
});

// [포트 변경] 4000번 포트로 서버 시작
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
