/**
 * Copyright 2025 mobile-next
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { execFileSync } from "child_process";
import path from "path";
import { trace } from "./logger";

export interface UIElement {
	x: number;
	y: number;
	width: number;
	height: number;
	center_x: number;
	center_y: number;
	area: number;
	type: string;
	confidence: number;
	vertices?: number;
}

export interface TemplateMatch {
	x: number;
	y: number;
	width: number;
	height: number;
	center_x: number;
	center_y: number;
	confidence: number;
	scale: number;
}

export interface CVDetectionResult {
	success: boolean;
	elements?: UIElement[];
	count?: number;
	error?: string;
}

export interface CVMatchResult {
	success: boolean;
	matches?: TemplateMatch[];
	count?: number;
	error?: string;
}

/**
 * Check if Python and OpenCV are available
 */
export const isPythonCVAvailable = (): { available: boolean; error?: string } => {
	try {
		// Check Python
		execFileSync("python3", ["--version"], { timeout: 5000 });

		// Check OpenCV
		const result = execFileSync("python3", ["-c", "import cv2; import numpy; print('OK')"], {
			timeout: 5000,
			encoding: "utf8"
		});

		if (result.trim() === "OK") {
			return { available: true };
		} else {
			return {
				available: false,
				error: "OpenCV not installed. Run: pip3 install -r src/cv/requirements.txt"
			};
		}
	} catch (error: any) {
		return {
			available: false,
			error: `Python CV environment not available: ${error.message}. Install: pip3 install -r src/cv/requirements.txt`
		};
	}
};

/**
 * Detect UI elements in a screenshot using Computer Vision
 *
 * @param screenshotBase64 - Base64 encoded screenshot image
 * @param minArea - Minimum area for UI elements (default: 400 pixels)
 * @returns Detection result with UI elements and coordinates
 */
export const detectUIElements = (
	screenshotBase64: string,
	minArea: number = 400
): CVDetectionResult => {
	const availability = isPythonCVAvailable();
	if (!availability.available) {
		return {
			success: false,
			error: availability.error
		};
	}

	try {
		const scriptPath = path.join(__dirname, "cv", "ui_detector.py");

		trace(`Running UI detector with min_area=${minArea}`);

		const result = execFileSync(
			"python3",
			[scriptPath, screenshotBase64, minArea.toString()],
			{
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024, // 10MB buffer
				timeout: 30000 // 30 second timeout
			}
		);

		const parsed = JSON.parse(result.trim());
		trace(`UI detector found ${parsed.count} elements`);

		return parsed as CVDetectionResult;
	} catch (error: any) {
		trace(`UI detection failed: ${error.message}`);
		return {
			success: false,
			error: `UI detection failed: ${error.message}`
		};
	}
};

/**
 * Find UI elements by template matching
 *
 * @param screenshotBase64 - Base64 encoded screenshot image
 * @param templateBase64 - Base64 encoded template image to find
 * @param threshold - Confidence threshold (0.0 - 1.0, default: 0.7)
 * @returns Match result with coordinates and confidence
 */
export const findElementByTemplate = (
	screenshotBase64: string,
	templateBase64: string,
	threshold: number = 0.7
): CVMatchResult => {
	const availability = isPythonCVAvailable();
	if (!availability.available) {
		return {
			success: false,
			error: availability.error
		};
	}

	try {
		const scriptPath = path.join(__dirname, "cv", "template_matcher.py");

		trace(`Running template matcher with threshold=${threshold}`);

		const result = execFileSync(
			"python3",
			[scriptPath, screenshotBase64, templateBase64, threshold.toString()],
			{
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
				timeout: 30000
			}
		);

		const parsed = JSON.parse(result.trim());
		trace(`Template matcher found ${parsed.count} matches`);

		return parsed as CVMatchResult;
	} catch (error: any) {
		trace(`Template matching failed: ${error.message}`);
		return {
			success: false,
			error: `Template matching failed: ${error.message}`
		};
	}
};
