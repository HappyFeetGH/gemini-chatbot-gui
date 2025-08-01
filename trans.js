// hwpx_simple_converter.js (불필요한 데이터 필터링 최종 버전)
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

// [핵심 개선] 실제 텍스트(<t>)만 선별적으로 추출하는 재귀 함수
function selectiveRecursiveExtract(element) {
    let text = '';
    // 재귀의 기본 조건: 탐색할 요소가 객체가 아니면 종료
    if (!element || typeof element !== 'object') {
        return '';
    }

    // 1. 't' 태그를 찾으면 그 안의 텍스트(_)를 추출
    if (element.t) {
        const t_elements = Array.isArray(element.t) ? element.t : [element.t];
        t_elements.forEach(t => {
            if (t && t._) {
                text += t._;
            } else if (typeof t === 'string') {
                text += t;
            }
        });
    }

    // 2. 재귀적으로 자식 요소들을 탐색하여 텍스트를 이어 붙임
    for (const key in element) {
        // 속성 정보($)는 건너뛰어 불필요한 데이터 추출 방지
        if (key === '$') {
            continue;
        }

        if (Array.isArray(element[key])) {
            element[key].forEach(child => {
                text += selectiveRecursiveExtract(child);
            });
        } else if (typeof element[key] === 'object') {
            text += selectiveRecursiveExtract(element[key]);
        }
    }
    return text;
}

// 테이블 셀 내부의 텍스트를 추출하는 함수
function parseTable(tblElement) {
    const tableData = [];
    if (!tblElement || !tblElement.tr || !Array.isArray(tblElement.tr)) return tableData;

    tblElement.tr.forEach(tr => {
        const rowData = [];
        if (tr.tc && Array.isArray(tr.tc)) {
            tr.tc.forEach(tc => {
                // 개선된 추출 함수 호출
                const cellText = selectiveRecursiveExtract(tc).trim();
                rowData.push(cellText);
            });
        }
        tableData.push(rowData);
    });
    return tableData;
}

// 2D 배열을 마크다운 테이블로 변환하는 함수
function tableToMarkdown(tableData) {
    if (!tableData || tableData.length === 0) return '';
    
    const colCount = Math.max(1, ...tableData.map(row => row.length));
    const normalizedData = tableData.map(row => {
        const newRow = [...row];
        while (newRow.length < colCount) newRow.push('');
        return newRow;
    });

    const header = normalizedData[0].map(h => (h || ' ').replace(/\|/g, '&#124;')).join(' | ');
    const separator = Array(colCount).fill('---').join(' | ');
    const body = normalizedData.slice(1).map(row => '| ' + row.map(c => (c || ' ').replace(/\|/g, '&#124;')).join(' | ') + ' |').join('\n');
    
    return `| ${header} |\n| ${separator} |\n${body}\n\n`;
}

// 본문에서 내용 추출
function extractContentFromXml(xmlObject) {
    let content = '';
    if (!xmlObject || !xmlObject.p) return '';

    xmlObject.p.forEach(p => {
        let paragraphText = '';
        let hasTableInRun = false;

        if (p.run && Array.isArray(p.run)) {
            p.run.forEach(run => {
                // 표가 있으면 먼저 처리
                if (run.tbl) {
                    hasTableInRun = true;
                    const tableData = parseTable(run.tbl[0]);
                    content += tableToMarkdown(tableData);
                } else {
                    // 표가 아닌 경우에만 텍스트 추출
                    paragraphText += selectiveRecursiveExtract(run);
                }
            });
        }
        
        if (paragraphText.trim()) {
            content += paragraphText.trim() + '\n\n';
        }
    });
    return content;
}


async function convertHwpxToMd(hwpxPath) {
    const fileName = path.basename(hwpxPath, '.hwpx');
    const tempZipPath = path.join(path.dirname(hwpxPath), `${fileName}_temp.zip`);
  
    try {
        fs.copyFileSync(hwpxPath, tempZipPath);
        const zip = new AdmZip(tempZipPath);
        
        const sectionEntry = zip.getEntry('Contents/section0.xml');
        if (!sectionEntry) {
            throw new Error('section0.xml을 찾을 수 없습니다.');
        }
    
        const xmlData = sectionEntry.getData().toString('utf-8');
    
        const parser = new xml2js.Parser({
            explicitRoot: false,
            tagNameProcessors: [name => name.replace(/.*:/, '')]
        });
    
        const xml = await parser.parseStringPromise(xmlData);
        const mdContent = extractContentFromXml(xml);

        if (!mdContent.trim()) {
            console.warn(`[경고] ${fileName}에서 내용을 추출하지 못했습니다.`);
        }
        
        return `# ${fileName}\n\n${mdContent.trim()}`;
    
    } finally {
        if (fs.existsSync(tempZipPath)) {
            fs.unlinkSync(tempZipPath);
        }
    }
}

// --- 아래 부분은 수정 없음 ---
async function convertAllHwpxFiles() {
    const contextDir = path.join(__dirname, 'context');
  
    if (!fs.existsSync(contextDir)) {
        console.log('context 폴더가 없습니다.'); return;
    }
  
    const hwpxFiles = fs.readdirSync(contextDir).filter(f => f.toLowerCase().endsWith('.hwpx'));
  
    if (hwpxFiles.length === 0) {
        console.log('context 폴더에 HWPX 파일이 없습니다.'); return;
    }
  
    console.log(`${hwpxFiles.length}개의 HWPX 파일 발견`);
  
    for (const file of hwpxFiles) {
        const hwpxPath = path.join(contextDir, file);
        const mdPath = path.join(contextDir, file.replace(/\.hwpx$/i, '.md'));
    
        try {
            console.log(`\n=== ${file} 변환 시작 ===`);
            const mdContent = await convertHwpxToMd(hwpxPath);
            fs.writeFileSync(mdPath, mdContent, 'utf-8');
            console.log(`✅ 변환 성공: ${file} -> ${path.basename(mdPath)}`);
        } catch (error) {
            console.error(`❌ 변환 실패: ${file} - ${error.message}`);
        }
    }
    console.log('\n모든 변환 작업 완료!');
}

convertAllHwpxFiles().catch(console.error);
