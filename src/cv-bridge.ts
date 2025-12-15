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
import fs from "fs";
import os from "os";
import { trace } from "./logger";

/**
 * Get Python executable path
 * Priority: MOBILE_MCP_PYTHON env var > venv/bin/python > python3
 */
const getPythonPath = (): string => {
	// Check environment variable
	if (process.env.MOBILE_MCP_PYTHON) {
		return process.env.MOBILE_MCP_PYTHON;
	}

	// Check for venv in project root
	// __dirname could be src/ (ts-node) or lib/ (compiled)
	const projectRoot = __dirname.includes("lib")
		? path.join(__dirname, "..")  // lib/ -> project root
		: path.join(__dirname, "..");  // src/ -> project root
	const venvPython = path.join(projectRoot, "venv", "bin", "python");

	if (fs.existsSync(venvPython)) {
		trace(`Using venv Python: ${venvPython}`);
		return venvPython;
	}

	// Fallback to system python3
	return "python3";
};

/**
 * Get CV script path (works for both src/ and lib/ execution)
 */
const getCVScriptPath = (scriptName: string): string => {
	// If running from lib/ (compiled), use lib/cv/
	if (__dirname.includes("lib")) {
		return path.join(__dirname, "cv", scriptName);
	}
	// If running from src/ (ts-node), use src/cv/
	return path.join(__dirname, "cv", scriptName);
};

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
		const pythonPath = getPythonPath();

		// Check Python
		execFileSync(pythonPath, ["--version"], { timeout: 5000 });

		// Check OpenCV
		const result = execFileSync(pythonPath, ["-c", "import cv2; import numpy; print('OK')"], {
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

	let tempFile: string | null = null;

	try {
		const scriptPath = getCVScriptPath("ui_detector.py");
		const pythonPath = getPythonPath();

		// Write base64 to temp file to avoid E2BIG error
		tempFile = path.join(os.tmpdir(), `mcp-screenshot-${Date.now()}.png`);
		const imageBuffer = Buffer.from(screenshotBase64, "base64");
		fs.writeFileSync(tempFile, imageBuffer);

		trace(`Running UI detector with min_area=${minArea}, temp file: ${tempFile}, python: ${pythonPath}`);

		const result = execFileSync(
			pythonPath,
			[scriptPath, tempFile, minArea.toString()],
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

		// Capture stderr if available
		let errorDetails = error.message;
		if (error.stderr) {
			errorDetails += `\nStderr: ${error.stderr.toString()}`;
		}
		if (error.stdout) {
			errorDetails += `\nStdout: ${error.stdout.toString()}`;
		}

		return {
			success: false,
			error: `UI detection failed: ${errorDetails}`
		};
	} finally {
		// Clean up temp file
		if (tempFile && fs.existsSync(tempFile)) {
			try {
				fs.unlinkSync(tempFile);
			} catch (e) {
				// Ignore cleanup errors
			}
		}
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

	let screenshotFile: string | null = null;
	let templateFile: string | null = null;

	try {
		const scriptPath = getCVScriptPath("template_matcher.py");
		const pythonPath = getPythonPath();

		// Write images to temp files to avoid E2BIG error
		const timestamp = Date.now();
		screenshotFile = path.join(os.tmpdir(), `mcp-screenshot-${timestamp}.png`);
		templateFile = path.join(os.tmpdir(), `mcp-template-${timestamp}.png`);

		const screenshotBuffer = Buffer.from(screenshotBase64, "base64");
		const templateBuffer = Buffer.from(templateBase64, "base64");

		fs.writeFileSync(screenshotFile, screenshotBuffer);
		fs.writeFileSync(templateFile, templateBuffer);

		trace(`Running template matcher with threshold=${threshold}, python: ${pythonPath}`);

		const result = execFileSync(
			pythonPath,
			[scriptPath, screenshotFile, templateFile, threshold.toString()],
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

		// Capture stderr if available
		let errorDetails = error.message;
		if (error.stderr) {
			errorDetails += `\nStderr: ${error.stderr.toString()}`;
		}
		if (error.stdout) {
			errorDetails += `\nStdout: ${error.stdout.toString()}`;
		}

		return {
			success: false,
			error: `Template matching failed: ${errorDetails}`
		};
	} finally {
		// Clean up temp files
		if (screenshotFile && fs.existsSync(screenshotFile)) {
			try {
				fs.unlinkSync(screenshotFile);
			} catch (e) {
				// Ignore cleanup errors
			}
		}
		if (templateFile && fs.existsSync(templateFile)) {
			try {
				fs.unlinkSync(templateFile);
			} catch (e) {
				// Ignore cleanup errors
			}
		}
	}
};
