#!/usr/bin/env python3
"""
UI Element Detector for Unity Games
Uses Computer Vision (Edge Detection + Contour Analysis) to detect UI elements
"""

import sys
import json
import base64
import cv2
import numpy as np
from typing import List, Dict, Tuple


class UIDetector:
    def __init__(self, min_area: int = 400, max_area: int = None):
        """
        Initialize UI detector

        Args:
            min_area: Minimum area for a UI element (pixels)
            max_area: Maximum area for a UI element (pixels), None = 50% of image
        """
        self.min_area = min_area
        self.max_area = max_area

    def detect_ui_elements(self, image_data: str) -> List[Dict]:
        """
        Detect UI elements in screenshot

        Args:
            image_data: Base64 encoded image or file path

        Returns:
            List of detected elements with coordinates and confidence
        """
        # Decode image
        img = self._load_image(image_data)
        if img is None:
            return []

        # Set max area if not specified
        if self.max_area is None:
            img_area = img.shape[0] * img.shape[1]
            self.max_area = img_area * 0.5

        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Apply Gaussian blur to reduce noise
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Edge detection
        edges = cv2.Canny(blurred, 50, 150)

        # Morphological operations to connect edges
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        dilated = cv2.dilate(edges, kernel, iterations=2)

        # Find contours
        contours, hierarchy = cv2.findContours(
            dilated, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
        )

        # Filter and extract UI elements
        elements = []
        for i, contour in enumerate(contours):
            element = self._analyze_contour(contour, hierarchy[0][i], img.shape)
            if element:
                elements.append(element)

        # Remove nested elements (keep parent only)
        elements = self._remove_nested_elements(elements)

        # Sort by area (larger first) and limit results
        elements.sort(key=lambda x: x['area'], reverse=True)

        return elements[:100]  # Limit to top 100 elements

    def _load_image(self, image_data: str) -> np.ndarray:
        """Load image from base64 or file path"""
        try:
            # Try base64 decode
            if image_data.startswith('data:image'):
                # Remove data URL prefix
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

    def _analyze_contour(
        self, contour: np.ndarray, hierarchy_info: np.ndarray, img_shape: Tuple
    ) -> Dict:
        """
        Analyze a contour to determine if it's a UI element

        Returns:
            Element dict with coordinates, or None if not a UI element
        """
        # Get bounding rectangle
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h

        # Filter by area
        if area < self.min_area or area > self.max_area:
            return None

        # Filter by aspect ratio (too thin/tall elements are likely not buttons)
        aspect_ratio = w / h if h > 0 else 0
        if aspect_ratio < 0.1 or aspect_ratio > 10:
            return None

        # Calculate shape metrics
        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * np.pi * cv2.contourArea(contour) / (perimeter ** 2) if perimeter > 0 else 0

        # Approximate polygon
        epsilon = 0.02 * perimeter
        approx = cv2.approxPolyDP(contour, epsilon, True)
        num_vertices = len(approx)

        # Determine element type based on shape
        element_type = "unknown"
        confidence = 0.5

        if num_vertices == 4:
            # Rectangular shape - likely button or text field
            element_type = "rectangle"
            confidence = 0.8
        elif circularity > 0.7:
            # Circular shape - likely icon or button
            element_type = "circle"
            confidence = 0.9
        elif num_vertices < 10:
            # Polygon - might be icon
            element_type = "polygon"
            confidence = 0.6

        return {
            "x": int(x),
            "y": int(y),
            "width": int(w),
            "height": int(h),
            "center_x": int(x + w // 2),
            "center_y": int(y + h // 2),
            "area": int(area),
            "type": element_type,
            "confidence": round(confidence, 2),
            "vertices": num_vertices
        }

    def _remove_nested_elements(self, elements: List[Dict]) -> List[Dict]:
        """Remove elements that are completely inside other elements"""
        filtered = []

        for i, elem1 in enumerate(elements):
            is_nested = False

            for j, elem2 in enumerate(elements):
                if i == j:
                    continue

                # Check if elem1 is inside elem2
                if (elem1['x'] >= elem2['x'] and
                    elem1['y'] >= elem2['y'] and
                    elem1['x'] + elem1['width'] <= elem2['x'] + elem2['width'] and
                    elem1['y'] + elem1['height'] <= elem2['y'] + elem2['height'] and
                    elem1['area'] < elem2['area'] * 0.9):  # Must be significantly smaller
                    is_nested = True
                    break

            if not is_nested:
                filtered.append(elem1)

        return filtered


def main():
    """Main entry point for CLI usage"""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ui_detector.py <base64_image_or_path> [min_area]"}))
        sys.exit(1)

    image_data = sys.argv[1]
    min_area = int(sys.argv[2]) if len(sys.argv) > 2 else 400

    detector = UIDetector(min_area=min_area)
    elements = detector.detect_ui_elements(image_data)

    result = {
        "success": True,
        "elements": elements,
        "count": len(elements)
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
