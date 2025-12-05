#!/usr/bin/env python3
"""
Template Matcher for Unity Game UI
Finds UI elements by matching template images
"""

import sys
import json
import base64
import cv2
import numpy as np
from typing import List, Dict, Tuple


class TemplateMatcher:
    def __init__(self, threshold: float = 0.7, method: str = "ccoeff_normed"):
        """
        Initialize template matcher

        Args:
            threshold: Minimum confidence threshold (0.0 - 1.0)
            method: OpenCV matching method
                - ccoeff_normed: Correlation coefficient (best for color matching)
                - ccorr_normed: Cross-correlation (fast)
                - sqdiff_normed: Squared difference (good for exact matches)
        """
        self.threshold = threshold
        self.method_map = {
            "ccoeff_normed": cv2.TM_CCOEFF_NORMED,
            "ccorr_normed": cv2.TM_CCORR_NORMED,
            "sqdiff_normed": cv2.TM_SQDIFF_NORMED,
        }
        self.method = self.method_map.get(method, cv2.TM_CCOEFF_NORMED)

    def find_matches(
        self,
        screenshot_data: str,
        template_data: str,
        multi_scale: bool = True
    ) -> List[Dict]:
        """
        Find template matches in screenshot

        Args:
            screenshot_data: Base64 encoded screenshot or file path
            template_data: Base64 encoded template or file path
            multi_scale: Try multiple scales (handles different resolutions)

        Returns:
            List of matches with coordinates and confidence
        """
        # Load images
        screenshot = self._load_image(screenshot_data)
        template = self._load_image(template_data)

        if screenshot is None or template is None:
            return []

        matches = []

        if multi_scale:
            # Try multiple scales
            scales = [0.5, 0.75, 1.0, 1.25, 1.5]
            for scale in scales:
                scaled_matches = self._match_at_scale(screenshot, template, scale)
                matches.extend(scaled_matches)
        else:
            matches = self._match_at_scale(screenshot, template, 1.0)

        # Remove overlapping matches (non-maximum suppression)
        matches = self._non_max_suppression(matches)

        # Sort by confidence
        matches.sort(key=lambda x: x['confidence'], reverse=True)

        return matches

    def _load_image(self, image_data: str) -> np.ndarray:
        """Load image from base64 or file path"""
        try:
            # Try base64 decode
            if image_data.startswith('data:image'):
                image_data = image_data.split(',', 1)[1]

            img_bytes = base64.b64decode(image_data)
            img_array = np.frombuffer(img_bytes, dtype=np.uint8)
            img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            return img
        except:
            # Try file path
            try:
                img = cv2.imread(image_data)
                return img
            except:
                return None

    def _match_at_scale(
        self,
        screenshot: np.ndarray,
        template: np.ndarray,
        scale: float
    ) -> List[Dict]:
        """Match template at a specific scale"""
        # Resize template
        template_h, template_w = template.shape[:2]
        new_w = int(template_w * scale)
        new_h = int(template_h * scale)

        if new_w <= 0 or new_h <= 0:
            return []

        if new_w > screenshot.shape[1] or new_h > screenshot.shape[0]:
            return []

        resized_template = cv2.resize(template, (new_w, new_h))

        # Perform template matching
        result = cv2.matchTemplate(screenshot, resized_template, self.method)

        # Find locations where confidence > threshold
        if self.method == cv2.TM_SQDIFF_NORMED:
            # For SQDIFF, lower is better
            locations = np.where(result <= (1 - self.threshold))
            confidences = 1 - result[locations]
        else:
            locations = np.where(result >= self.threshold)
            confidences = result[locations]

        matches = []
        for pt, confidence in zip(zip(*locations[::-1]), confidences):
            x, y = pt
            matches.append({
                "x": int(x),
                "y": int(y),
                "width": new_w,
                "height": new_h,
                "center_x": int(x + new_w // 2),
                "center_y": int(y + new_h // 2),
                "confidence": round(float(confidence), 3),
                "scale": round(scale, 2)
            })

        return matches

    def _non_max_suppression(
        self,
        matches: List[Dict],
        overlap_threshold: float = 0.3
    ) -> List[Dict]:
        """Remove overlapping matches, keeping the highest confidence ones"""
        if not matches:
            return []

        # Sort by confidence (descending)
        matches = sorted(matches, key=lambda x: x['confidence'], reverse=True)

        kept_matches = []

        for match in matches:
            # Check if this match overlaps with any kept match
            is_overlapping = False

            for kept in kept_matches:
                iou = self._calculate_iou(match, kept)
                if iou > overlap_threshold:
                    is_overlapping = True
                    break

            if not is_overlapping:
                kept_matches.append(match)

        return kept_matches

    def _calculate_iou(self, box1: Dict, box2: Dict) -> float:
        """Calculate Intersection over Union (IoU) for two boxes"""
        x1_min = box1['x']
        y1_min = box1['y']
        x1_max = box1['x'] + box1['width']
        y1_max = box1['y'] + box1['height']

        x2_min = box2['x']
        y2_min = box2['y']
        x2_max = box2['x'] + box2['width']
        y2_max = box2['y'] + box2['height']

        # Calculate intersection
        inter_x_min = max(x1_min, x2_min)
        inter_y_min = max(y1_min, y2_min)
        inter_x_max = min(x1_max, x2_max)
        inter_y_max = min(y1_max, y2_max)

        if inter_x_max < inter_x_min or inter_y_max < inter_y_min:
            return 0.0

        inter_area = (inter_x_max - inter_x_min) * (inter_y_max - inter_y_min)

        # Calculate union
        box1_area = box1['width'] * box1['height']
        box2_area = box2['width'] * box2['height']
        union_area = box1_area + box2_area - inter_area

        return inter_area / union_area if union_area > 0 else 0.0


def main():
    """Main entry point for CLI usage"""
    if len(sys.argv) < 3:
        print(json.dumps({
            "error": "Usage: template_matcher.py <screenshot_data> <template_data> [threshold]"
        }))
        sys.exit(1)

    screenshot_data = sys.argv[1]
    template_data = sys.argv[2]
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.7

    matcher = TemplateMatcher(threshold=threshold)
    matches = matcher.find_matches(screenshot_data, template_data, multi_scale=True)

    result = {
        "success": True,
        "matches": matches,
        "count": len(matches)
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
