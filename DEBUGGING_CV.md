# Debugging CV Issues

## EPIPE Error 디버깅

`EPIPE` 에러가 발생하면 Python 스크립트를 직접 실행해서 원인을 파악할 수 있습니다.

### 1. Python 스크립트 직접 테스트

```bash
cd /path/to/mobile-mcp

# 테스트 이미지 준비 (스크린샷 촬영 후)
# 예: screenshot.png

# UI Detector 테스트
python3 src/cv/ui_detector.py screenshot.png 400

# Template Matcher 테스트
python3 src/cv/template_matcher.py screenshot.png template.png 0.7
```

### 2. OpenCV 설치 확인

```bash
python3 -c "import cv2; import numpy; print('OpenCV:', cv2.__version__, 'NumPy:', numpy.__version__)"
```

### 3. 일반적인 EPIPE 원인

1. **OpenCV 미설치**
   ```bash
   pip3 install opencv-python numpy
   ```

2. **이미지 파일 손상**
   - 스크린샷이 제대로 저장되지 않음
   - 임시 파일 경로 접근 권한 문제

3. **Python 경로 문제**
   ```bash
   which python3
   # Cursor 설정에서 정확한 경로 사용
   ```

4. **메모리 부족**
   - 매우 큰 스크린샷 (4K+)
   - `min_area`를 높여서 처리할 요소 수 줄이기

### 4. 에러 메시지 확인

최신 버전에서는 stderr도 캡처하므로, 에러 메시지에 Python 스택 트레이스가 포함됩니다:

```
UI detection failed: Command failed
Stderr: Traceback (most recent call last):
  File "ui_detector.py", line 10, in <module>
    import cv2
ModuleNotFoundError: No module named 'cv2'
```

### 5. 임시 파일 확인

```bash
# macOS/Linux
ls -la /tmp/mcp-screenshot-*.png

# 임시 파일이 생성되지 않으면 권한 문제일 수 있음
```

### 6. 대안: 네이티브 접근성 API 사용

Computer Vision이 작동하지 않으면 네이티브 API 사용:

```typescript
// Unity가 아닌 일반 앱이라면
mobile_list_elements_on_screen({ device: "your-device" })
```

## 성능 최적화

### 큰 스크린샷 처리

```typescript
// min_area를 높여서 작은 요소 무시
mobile_detect_ui_elements({
  device: "your-device",
  min_area: 1000  // 기본값 400 대신
})
```

### 타임아웃 이슈

매우 큰 이미지는 30초 내에 처리 안 될 수 있습니다.
- 해결: 디바이스 해상도 낮추기
- 또는: cv-bridge.ts의 timeout 값 증가

## 문의

문제가 지속되면 다음 정보와 함께 이슈 등록:
1. Python 버전: `python3 --version`
2. OpenCV 버전: `python3 -c "import cv2; print(cv2.__version__)"`
3. 스크린 해상도: `mobile_get_screen_size`
4. 전체 에러 메시지
