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

        # Filter and extract UI elements from edge detection
        elements = []
        for i, contour in enumerate(contours):
            element = self._analyze_contour(contour, hierarchy[0][i] if hierarchy is not None else None, img.shape)
            if element:
                elements.append(element)

        # Add color-based detection for buttons with distinct colors
        color_elements = self._detect_color_regions(img)
        
        # Prioritize color-based detections over edge-based detections
        # Remove edge-based elements that overlap significantly with color-based ones
        edge_elements = elements.copy()
        elements = []
        
        for color_elem in color_elements:
            # Check if this color element overlaps with any edge element
            is_duplicate = False
            for edge_elem in edge_elements:
                # Calculate overlap
                x_overlap = max(0, min(color_elem['x'] + color_elem['width'], edge_elem['x'] + edge_elem['width']) - max(color_elem['x'], edge_elem['x']))
                y_overlap = max(0, min(color_elem['y'] + color_elem['height'], edge_elem['y'] + edge_elem['height']) - max(color_elem['y'], edge_elem['y']))
                overlap_area = x_overlap * y_overlap
                
                # If overlap is more than 50%, prefer color-based detection
                min_area = min(color_elem['area'], edge_elem['area'])
                if overlap_area > min_area * 0.5:
                    is_duplicate = True
                    # Remove the edge element from list
                    if edge_elem in edge_elements:
                        edge_elements.remove(edge_elem)
                    break
            
            # Add color element (it's more specific)
            elements.append(color_elem)
        
        # Add remaining edge elements that don't overlap with color elements
        elements.extend(edge_elements)
        
        # Remove nested and duplicate elements
        elements = self._remove_nested_elements(elements)
        elements = self._remove_duplicate_elements(elements)

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

    def _detect_color_regions(self, img: np.ndarray) -> List[Dict]:
        """
        Detect UI elements based on color regions using universal color detection
        Automatically finds buttons of any color by detecting high saturation/value regions
        No hardcoded color ranges - works for any colored button
        """
        elements = []
        
        # Convert to HSV for better color detection
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        h, s, v = cv2.split(hsv)
        
        # Universal approach: Find regions with high saturation and brightness
        # This works for any colored button (green, blue, red, yellow, purple, etc.)
        # without needing to specify color ranges
        
        # Threshold for saturation (how colorful) - buttons are usually colorful
        # Lower threshold to catch more buttons, but not too low to avoid noise
        sat_threshold = 50  # Minimum saturation for a colored button
        
        # Threshold for value (brightness) - buttons are usually visible
        val_threshold = 40  # Minimum brightness
        
        # Create mask for regions with sufficient color saturation and brightness
        # This catches any colored button regardless of hue
        color_mask = cv2.bitwise_and(
            cv2.threshold(s, sat_threshold, 255, cv2.THRESH_BINARY)[1],
            cv2.threshold(v, val_threshold, 255, cv2.THRESH_BINARY)[1]
        )
        
        # Apply morphological operations to clean up the mask
        kernel_close = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
        kernel_open = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        
        # Close gaps in the mask (connect nearby regions)
        color_mask = cv2.morphologyEx(color_mask, cv2.MORPH_CLOSE, kernel_close, iterations=2)
        # Remove small noise
        color_mask = cv2.morphologyEx(color_mask, cv2.MORPH_OPEN, kernel_open, iterations=1)
        # Dilate slightly to ensure button edges are included
        color_mask = cv2.dilate(color_mask, kernel_open, iterations=1)
        
        # Find contours in the mask
        contours, _ = cv2.findContours(color_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            area = w * h
            
            # More lenient area filter for color-based detection
            min_area_for_color = max(200, self.min_area * 0.5)
            if area < min_area_for_color or area > self.max_area:
                continue
            
            # More lenient aspect ratio for buttons (can be wider)
            aspect_ratio = w / h if h > 0 else 0
            if aspect_ratio < 0.05 or aspect_ratio > 15:
                continue
            
            # Extract the region and analyze color properties
            roi_hsv = hsv[y:y+h, x:x+w]
            if roi_hsv.size == 0:
                continue
            
            # Calculate color statistics
            mean_saturation = np.mean(roi_hsv[:, :, 1])
            mean_value = np.mean(roi_hsv[:, :, 2])
            mean_hue = np.mean(roi_hsv[:, :, 0])
            
            # Skip if too desaturated or too dark (likely not a button)
            if mean_saturation < sat_threshold or mean_value < val_threshold:
                continue
            
            # Determine color name from hue (for labeling purposes)
            color_name = self._get_color_name_from_hue(mean_hue)
            
            # Calculate confidence based on color properties
            # Higher saturation and value = more confident it's a button
            confidence = min(0.95, 0.7 + (mean_saturation / 255.0) * 0.15 + (mean_value / 255.0) * 0.1)
            
            elements.append({
                "x": int(x),
                "y": int(y),
                "width": int(w),
                "height": int(h),
                "center_x": int(x + w // 2),
                "center_y": int(y + h // 2),
                "area": int(area),
                "type": f"color_button_{color_name}",
                "confidence": round(confidence, 2),
                "vertices": 4
            })
        
        return elements
    
    def _get_color_name_from_hue(self, hue: float) -> str:
        """
        Convert HSV hue value to color name for labeling
        Hue range: 0-179 (OpenCV uses 0-179 for hue)
        """
        if hue < 10 or hue > 170:
            return "red"
        elif hue < 20:
            return "orange"
        elif hue < 30:
            return "yellow"
        elif hue < 75:
            return "green"
        elif hue < 100:
            return "cyan"
        elif hue < 130:
            return "blue"
        elif hue < 150:
            return "purple"
        else:
            return "pink"

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
    
    def _remove_duplicate_elements(self, elements: List[Dict]) -> List[Dict]:
        """Remove duplicate elements that overlap significantly"""
        filtered = []
        
        for elem1 in elements:
            is_duplicate = False
            
            for elem2 in filtered:
                # Calculate overlap
                x_overlap = max(0, min(elem1['x'] + elem1['width'], elem2['x'] + elem2['width']) - max(elem1['x'], elem2['x']))
                y_overlap = max(0, min(elem1['y'] + elem1['height'], elem2['y'] + elem2['height']) - max(elem1['y'], elem2['y']))
                overlap_area = x_overlap * y_overlap
                
                # If overlap is more than 70%, consider it duplicate
                min_area = min(elem1['area'], elem2['area'])
                if overlap_area > min_area * 0.7:
                    is_duplicate = True
                    break
            
            if not is_duplicate:
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
