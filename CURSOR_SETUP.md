# Cursor에서 mobile-mcp 사용 가이드

## 빠른 시작

### 1. Python 의존성 설치 (Computer Vision 기능용)

```bash
pip3 install -r src/cv/requirements.txt
```

### 2. Cursor MCP 설정

#### Option A: 전역 명령어 사용 (권장)

프로젝트를 전역으로 링크했으므로, Cursor MCP 설정 파일에 추가:

**설정 파일 위치:**
- Linux: `~/.config/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- macOS: `~/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windows: `%APPDATA%\Cursor\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

**설정 내용:**
```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "mcp-server-mobile",
      "args": [],
      "disabled": false
    }
  }
}
```

#### Option B: 절대 경로 사용

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "node",
      "args": [
        "/home/user/mobile-mcp/lib/index.js"
      ],
      "disabled": false
    }
  }
}
```

### 3. Cursor 재시작

설정 파일을 저장한 후 Cursor를 완전히 종료하고 다시 시작합니다.

### 4. 연결 확인

Cursor의 Claude Code에서 다음 명령어로 확인:

```
사용 가능한 도구를 보려면:
- mobile_list_available_devices
- mobile_take_screenshot
- mobile_detect_ui_elements (새로 추가된 CV 기능!)
- mobile_find_element_by_template (새로 추가된 CV 기능!)
```

## 사용 예시

### 1. 디바이스 목록 확인

```json
{
  "tool": "mobile_list_available_devices"
}
```

### 2. 스크린샷 촬영

```json
{
  "tool": "mobile_take_screenshot",
  "device": "emulator-5554"
}
```

### 3. Unity 게임 UI 자동 감지 (Computer Vision)

```json
{
  "tool": "mobile_detect_ui_elements",
  "device": "emulator-5554",
  "min_area": 400
}
```

**반환 예시:**
```json
{
  "elements": [
    {
      "x": 100,
      "y": 200,
      "width": 150,
      "height": 60,
      "center_x": 175,
      "center_y": 230,
      "type": "rectangle",
      "confidence": 0.8
    }
  ]
}
```

### 4. 템플릿 이미지로 UI 찾기

```json
{
  "tool": "mobile_find_element_by_template",
  "device": "emulator-5554",
  "template_image_base64": "<base64 encoded image>",
  "confidence_threshold": 0.7
}
```

### 5. 좌표로 클릭

```json
{
  "tool": "mobile_click_on_screen_at_coordinates",
  "device": "emulator-5554",
  "x": 175,
  "y": 230
}
```

## 문제 해결

### MCP 서버가 보이지 않음

1. **설정 파일 위치 확인**
   ```bash
   # Claude Dev (Cline) 확장 설정 찾기
   find ~/.config/Cursor -name "cline_mcp_settings.json" 2>/dev/null
   ```

2. **명령어 실행 테스트**
   ```bash
   mcp-server-mobile --help
   # 또는
   node /home/user/mobile-mcp/lib/index.js --help
   ```

3. **Cursor 로그 확인**
   - Cursor 메뉴 → View → Output
   - 드롭다운에서 "Claude Dev" 선택

### Computer Vision 기능 오류

1. **Python 확인**
   ```bash
   python3 --version
   ```

2. **OpenCV 설치 확인**
   ```bash
   python3 -c "import cv2; print('OpenCV:', cv2.__version__)"
   ```

3. **의존성 재설치**
   ```bash
   pip3 install -r src/cv/requirements.txt --force-reinstall
   ```

### 디바이스가 보이지 않음

**Android:**
```bash
adb devices
# 디바이스가 없으면:
adb kill-server
adb start-server
```

**iOS:**
```bash
# 시뮬레이터
xcrun simctl list devices

# 실제 기기
idevice_id -l
```

## 고급 설정

### 환경 변수 추가

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "mcp-server-mobile",
      "args": [],
      "env": {
        "ANDROID_HOME": "/path/to/android/sdk",
        "DEBUG": "true"
      },
      "disabled": false
    }
  }
}
```

### 특정 툴 항상 허용

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "mcp-server-mobile",
      "args": [],
      "disabled": false,
      "alwaysAllow": [
        "mobile_list_available_devices",
        "mobile_take_screenshot"
      ]
    }
  }
}
```

## 추가 리소스

- **Computer Vision 가이드**: `src/cv/README.md`
- **GitHub 이슈**: https://github.com/mobile-next/mobile-mcp/issues
- **MCP 프로토콜**: https://modelcontextprotocol.io

## 업데이트

프로젝트를 업데이트한 후:

```bash
cd /home/user/mobile-mcp
git pull
npm install
npm run build
```

전역 링크를 다시 설정할 필요는 없습니다.
