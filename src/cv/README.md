# Computer Vision Module for Unity Game UI Detection

This module provides Computer Vision-based UI element detection for Unity games and other apps where native accessibility APIs (UIAutomator, WebDriverAgent) don't work.

## Overview

Unity games use custom rendering (OpenGL/Metal/Vulkan) which bypasses Android/iOS accessibility systems. This module uses OpenCV to:

1. **Detect UI elements** - Automatically find buttons, icons, and UI elements using edge detection
2. **Template matching** - Find specific UI elements by matching template images

## Installation

### Prerequisites

- Python 3.7+
- pip3

### Install Dependencies

```bash
cd src/cv
pip3 install -r requirements.txt
```

This installs:
- `opencv-python` - Computer Vision library
- `numpy` - Numerical processing

## Usage

### 1. Detect UI Elements (Auto-detection)

Automatically finds all UI elements on screen using edge and contour detection.

**MCP Tool:** `mobile_detect_ui_elements`

**Parameters:**
- `device` (required): Device identifier
- `min_area` (optional): Minimum area in pixels for UI elements (default: 400)

**Example:**
```typescript
{
  "device": "emulator-5554",
  "min_area": 400
}
```

**Returns:**
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
      "area": 9000,
      "type": "rectangle",
      "confidence": 0.8,
      "vertices": 4
    }
  ],
  "count": 10
}
```

**Element Types:**
- `rectangle` - Rectangular buttons, text fields (confidence: 0.8)
- `circle` - Circular buttons, icons (confidence: 0.9)
- `polygon` - Irregular shapes (confidence: 0.6)

### 2. Template Matching (Find by Image)

Find specific UI elements by providing a template image.

**MCP Tool:** `mobile_find_element_by_template`

**Parameters:**
- `device` (required): Device identifier
- `template_image_base64` (required): Base64 encoded template image
- `confidence_threshold` (optional): Minimum match confidence 0.0-1.0 (default: 0.7)

**Example:**
```typescript
{
  "device": "emulator-5554",
  "template_image_base64": "iVBORw0KGgoAAAANS...",
  "confidence_threshold": 0.75
}
```

**Returns:**
```json
{
  "matches": [
    {
      "x": 120,
      "y": 300,
      "width": 80,
      "height": 80,
      "center_x": 160,
      "center_y": 340,
      "confidence": 0.92,
      "scale": 1.0
    }
  ],
  "count": 1
}
```

## How It Works

### UI Element Detection

1. **Preprocessing**
   - Convert to grayscale
   - Apply Gaussian blur to reduce noise

2. **Edge Detection**
   - Canny edge detection (threshold: 50-150)
   - Morphological dilation to connect edges

3. **Contour Analysis**
   - Find contours in edge image
   - Filter by area (min_area to 50% of screen)
   - Filter by aspect ratio (0.1 to 10)

4. **Shape Classification**
   - Rectangle: 4 vertices → buttons, text fields
   - Circle: circularity > 0.7 → icons
   - Polygon: < 10 vertices → custom shapes

5. **Post-processing**
   - Remove nested elements
   - Sort by area (largest first)
   - Limit to top 100 elements

### Template Matching

1. **Multi-scale Matching**
   - Try 5 scales: 0.5x, 0.75x, 1.0x, 1.25x, 1.5x
   - Handles different screen resolutions

2. **Correlation**
   - Uses normalized cross-correlation (TM_CCOEFF_NORMED)
   - Robust to lighting variations

3. **Non-Maximum Suppression**
   - Remove overlapping matches (IoU > 0.3)
   - Keep highest confidence matches

## Tuning Parameters

### Minimum Area (`min_area`)

- **Default: 400 pixels**
- Smaller values: Detect smaller elements (but more noise)
- Larger values: Only large buttons/elements

**Examples:**
- Small icons: `min_area = 200`
- Medium buttons: `min_area = 400`
- Large panels: `min_area = 1000`

### Confidence Threshold (`confidence_threshold`)

- **Default: 0.7 (70%)**
- Higher values: More strict matching (fewer false positives)
- Lower values: More lenient matching (more results)

**Examples:**
- Exact match needed: `threshold = 0.9`
- Similar elements OK: `threshold = 0.6`
- Approximate match: `threshold = 0.5`

## Limitations

1. **No text recognition** - Cannot read text from UI elements (use OCR separately)
2. **Static analysis only** - Analyzes single frame, no animation tracking
3. **No semantic understanding** - Doesn't know what elements do (e.g., "login button")
4. **Performance** - Processing takes 1-5 seconds depending on image size
5. **False positives** - May detect non-UI elements (decorations, game objects)

## Troubleshooting

### "OpenCV not installed" Error

```bash
pip3 install opencv-python numpy
```

### "Python not found" Error

Install Python 3:
- macOS: `brew install python3`
- Ubuntu: `sudo apt install python3 python3-pip`
- Windows: Download from python.org

### No Elements Detected

1. Lower `min_area` to detect smaller elements
2. Check if screenshot is valid
3. Verify UI has clear edges (not blurry/gradient backgrounds)

### Template Not Found

1. Lower `confidence_threshold` (try 0.6 or 0.5)
2. Ensure template image is cropped correctly
3. Verify template matches current screen resolution
4. Try different lighting/color conditions

### Too Many False Positives

1. Increase `min_area` to filter small noise
2. Increase `confidence_threshold` for template matching
3. Filter results by area/type in your code

## Advanced Usage

### Standalone Python Scripts

You can also run the scripts directly:

```bash
# Detect UI elements
python3 ui_detector.py <screenshot_base64> [min_area]

# Template matching
python3 template_matcher.py <screenshot_base64> <template_base64> [threshold]
```

Output is JSON to stdout.

### Integration with LLMs

Use detected coordinates with LLM-based automation:

1. Take screenshot
2. Detect UI elements
3. LLM analyzes screenshot + element coordinates
4. LLM decides which element to click
5. Click using `mobile_click_on_screen_at_coordinates`

## License

Apache 2.0
