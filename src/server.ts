import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { z, ZodRawShape, ZodTypeAny } from "zod";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { error, trace } from "./logger";
import { AndroidRobot, AndroidDeviceManager } from "./android";
import { ActionableError, Robot } from "./robot";
import { SimctlManager } from "./iphone-simulator";
import { IosManager, IosRobot } from "./ios";
import { PNG } from "./png";
import { getMobilecliPath } from "./mobilecli";
import { detectUIElements, findElementByTemplate, isPythonCVAvailable } from "./cv-bridge";

interface MobilecliDevicesResponse {
	status: "ok";
	data: {
		devices: Array<{
			id: string;
			name: string;
			platform: "android" | "ios";
			type: "real" | "emulator" | "simulator";
			version: string;
		}>;
	};
}

export const getAgentVersion = (): string => {
	const json = require("../package.json");
	return json.version;
};

export const createMcpServer = (): McpServer => {

	const server = new McpServer({
		name: "mobile-mcp",
		version: getAgentVersion(),
		capabilities: {
			resources: {},
			tools: {},
		},
	});

	// an empty object to satisfy windsurf
	const noParams = z.object({});

	const getClientName = (): string => {
		try {
			const clientInfo = server.server.getClientVersion();
			const clientName = clientInfo?.name || "unknown";
			return clientName;
		} catch (error: any) {
			return "unknown";
		}
	};

	const tool = (name: string, description: string, paramsSchema: ZodRawShape, cb: (args: z.objectOutputType<ZodRawShape, ZodTypeAny>) => Promise<string>) => {
		const wrappedCb = async (args: ZodRawShape): Promise<CallToolResult> => {
			try {
				trace(`Invoking ${name} with args: ${JSON.stringify(args)}`);
				const response = await cb(args);
				trace(`=> ${response}`);
				posthog("tool_invoked", { "ToolName": name }).then();
				return {
					content: [{ type: "text", text: response }],
				};
			} catch (error: any) {
				posthog("tool_failed", { "ToolName": name }).then();
				if (error instanceof ActionableError) {
					return {
						content: [{ type: "text", text: `${error.message}. Please fix the issue and try again.` }],
					};
				} else {
					// a real exception
					trace(`Tool '${description}' failed: ${error.message} stack: ${error.stack}`);
					return {
						content: [{ type: "text", text: `Error: ${error.message}` }],
						isError: true,
					};
				}
			}
		};

		server.tool(name, description, paramsSchema, args => wrappedCb(args));
	};

	const posthog = async (event: string, properties: Record<string, string | number>) => {
		try {
			const url = "https://us.i.posthog.com/i/v0/e/";
			const api_key = "phc_KHRTZmkDsU7A8EbydEK8s4lJpPoTDyyBhSlwer694cS";
			const name = os.hostname() + process.execPath;
			const distinct_id = crypto.createHash("sha256").update(name).digest("hex");
			const systemProps: any = {
				Platform: os.platform(),
				Product: "mobile-mcp",
				Version: getAgentVersion(),
				NodeVersion: process.version,
			};

			const clientName = getClientName();
			if (clientName !== "unknown") {
				systemProps.AgentName = clientName;
			}

			await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					api_key,
					event,
					properties: {
						...systemProps,
						...properties,
					},
					distinct_id,
				})
			});
		} catch (err: any) {
			// ignore
		}
	};

	const getMobilecliVersion = (): string => {
		try {
			const path = getMobilecliPath();
			const output = execFileSync(path, ["--version"], { encoding: "utf8" }).toString().trim();
			if (output.startsWith("mobilecli version ")) {
				return output.substring("mobilecli version ".length);
			}

			return "failed";
		} catch (error: any) {
			return "failed " + error.message;
		}
	};

	const getMobilecliDevices = (): MobilecliDevicesResponse => {
		const mobilecliPath = getMobilecliPath();
		const mobilecliOutput = execFileSync(mobilecliPath, ["devices"], { encoding: "utf8" }).toString().trim();
		return JSON.parse(mobilecliOutput) as MobilecliDevicesResponse;
	};

	const mobilecliVersion = getMobilecliVersion();
	posthog("launch", { "MobilecliVersion": mobilecliVersion }).then();

	const simulatorManager = new SimctlManager();

	const getRobotFromDevice = (device: string): Robot => {
		const iosManager = new IosManager();
		const androidManager = new AndroidDeviceManager();
		const simulators = simulatorManager.listBootedSimulators();
		const androidDevices = androidManager.getConnectedDevices();
		const iosDevices = iosManager.listDevices();

		// Check if it's a simulator
		const simulator = simulators.find(s => s.name === device);
		if (simulator) {
			return simulatorManager.getSimulator(device);
		}

		// Check if it's an Android device
		const androidDevice = androidDevices.find(d => d.deviceId === device);
		if (androidDevice) {
			return new AndroidRobot(device);
		}

		// Check if it's an iOS device
		const iosDevice = iosDevices.find(d => d.deviceId === device);
		if (iosDevice) {
			return new IosRobot(device);
		}

		throw new ActionableError(`Device "${device}" not found. Use the mobile_list_available_devices tool to see available devices.`);
	};

	tool(
		"mobile_list_available_devices",
		"List all available devices. This includes both physical devices and simulators. If there is more than one device returned, you need to let the user select one of them.",
		{
			noParams
		},
		async ({ }) => {
			const iosManager = new IosManager();
			const androidManager = new AndroidDeviceManager();
			const simulators = simulatorManager.listBootedSimulators();
			const simulatorNames = simulators.map(d => d.name);
			const androidDevices = androidManager.getConnectedDevices();
			const iosDevices = await iosManager.listDevices();
			const iosDeviceNames = iosDevices.map(d => d.deviceId);
			const androidTvDevices = androidDevices.filter(d => d.deviceType === "tv").map(d => d.deviceId);
			const androidMobileDevices = androidDevices.filter(d => d.deviceType === "mobile").map(d => d.deviceId);

			if (true) {
				// gilm: this is new code to verify first that mobilecli detects more or equal number of devices.
				// in an attempt to make the smoothest transition from go-ios+xcrun+adb+iproxy+sips+imagemagick+wda to
				// a single cli tool.
				const deviceCount = simulators.length + iosDevices.length + androidDevices.length;

				let mobilecliDeviceCount = 0;
				try {
					const response = getMobilecliDevices();
					if (response.status === "ok" && response.data && response.data.devices) {
						mobilecliDeviceCount = response.data.devices.length;
					}
				} catch (error: any) {
					// if mobilecli fails, we'll just set count to 0
				}

				if (deviceCount === mobilecliDeviceCount) {
					posthog("debug_mobilecli_same_number_of_devices", {
						"DeviceCount": deviceCount,
						"MobilecliDeviceCount": mobilecliDeviceCount,
					}).then();
				} else {
					posthog("debug_mobilecli_different_number_of_devices", {
						"DeviceCount": deviceCount,
						"MobilecliDeviceCount": mobilecliDeviceCount,
						"DeviceCountDifference": deviceCount - mobilecliDeviceCount,
					}).then();
				}
			}

			const resp = ["Found these devices:"];
			if (simulatorNames.length > 0) {
				resp.push(`iOS simulators: [${simulatorNames.join(",")}]`);
			}

			if (iosDevices.length > 0) {
				resp.push(`iOS devices: [${iosDeviceNames.join(",")}]`);
			}

			if (androidMobileDevices.length > 0) {
				resp.push(`Android devices: [${androidMobileDevices.join(",")}]`);
			}

			if (androidTvDevices.length > 0) {
				resp.push(`Android TV devices: [${androidTvDevices.join(",")}]`);
			}

			return resp.join("\n");
		}
	);


	tool(
		"mobile_list_apps",
		"List all the installed apps on the device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const result = await robot.listApps();
			return `Found these apps on device: ${result.map(app => `${app.appName} (${app.packageName})`).join(", ")}`;
		}
	);

	tool(
		"mobile_launch_app",
		"Launch an app on mobile device. Use this to open a specific app. You can find the package name of the app by calling list_apps_on_device.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			packageName: z.string().describe("The package name of the app to launch"),
		},
		async ({ device, packageName }) => {
			const robot = getRobotFromDevice(device);
			await robot.launchApp(packageName);
			return `Launched app ${packageName}`;
		}
	);

	tool(
		"mobile_terminate_app",
		"Stop and terminate an app on mobile device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			packageName: z.string().describe("The package name of the app to terminate"),
		},
		async ({ device, packageName }) => {
			const robot = getRobotFromDevice(device);
			await robot.terminateApp(packageName);
			return `Terminated app ${packageName}`;
		}
	);

	tool(
		"mobile_install_app",
		"Install an app on mobile device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			path: z.string().describe("The path to the app file to install. For iOS simulators, provide a .zip file or a .app directory. For Android provide an .apk file. For iOS real devices provide an .ipa file"),
		},
		async ({ device, path }) => {
			const robot = getRobotFromDevice(device);
			await robot.installApp(path);
			return `Installed app from ${path}`;
		}
	);

	tool(
		"mobile_uninstall_app",
		"Uninstall an app from mobile device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			bundle_id: z.string().describe("Bundle identifier (iOS) or package name (Android) of the app to be uninstalled"),
		},
		async ({ device, bundle_id }) => {
			const robot = getRobotFromDevice(device);
			await robot.uninstallApp(bundle_id);
			return `Uninstalled app ${bundle_id}`;
		}
	);

	tool(
		"mobile_get_screen_size",
		"Get the screen size of the mobile device in pixels",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const screenSize = await robot.getScreenSize();
			return `Screen size is ${screenSize.width}x${screenSize.height} pixels`;
		}
	);

	tool(
		"mobile_click_on_screen_at_coordinates",
		"Click on the screen at given x,y coordinates. If clicking on an element, use the list_elements_on_screen tool to find the coordinates.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			x: z.number().describe("The x coordinate to click on the screen, in pixels"),
			y: z.number().describe("The y coordinate to click on the screen, in pixels"),
		},
		async ({ device, x, y }) => {
			const robot = getRobotFromDevice(device);
			await robot.tap(x, y);
			return `Clicked on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_double_tap_on_screen",
		"Double-tap on the screen at given x,y coordinates.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			x: z.number().describe("The x coordinate to double-tap, in pixels"),
			y: z.number().describe("The y coordinate to double-tap, in pixels"),
		},
		async ({ device, x, y }) => {
			const robot = getRobotFromDevice(device);
			await robot!.doubleTap(x, y);
			return `Double-tapped on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_long_press_on_screen_at_coordinates",
		"Long press on the screen at given x,y coordinates. If long pressing on an element, use the list_elements_on_screen tool to find the coordinates.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			x: z.number().describe("The x coordinate to long press on the screen, in pixels"),
			y: z.number().describe("The y coordinate to long press on the screen, in pixels"),
		},
		async ({ device, x, y }) => {
			const robot = getRobotFromDevice(device);
			await robot.longPress(x, y);
			return `Long pressed on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_list_elements_on_screen",
		"List elements on screen and their coordinates, with display text or accessibility label. Do not cache this result.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const elements = await robot.getElementsOnScreen();

			const result = elements.map(element => {
				const out: any = {
					type: element.type,
					text: element.text,
					label: element.label,
					name: element.name,
					value: element.value,
					identifier: element.identifier,
					coordinates: {
						x: element.rect.x,
						y: element.rect.y,
						width: element.rect.width,
						height: element.rect.height,
					},
				};

				if (element.focused) {
					out.focused = true;
				}

				return out;
			});

			return `Found these elements on screen: ${JSON.stringify(result)}`;
		}
	);

	tool(
		"mobile_press_button",
		"Press a button on device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			button: z.string().describe("The button to press. Supported buttons: BACK (android only), HOME, VOLUME_UP, VOLUME_DOWN, ENTER, DPAD_CENTER (android tv only), DPAD_UP (android tv only), DPAD_DOWN (android tv only), DPAD_LEFT (android tv only), DPAD_RIGHT (android tv only)"),
		},
		async ({ device, button }) => {
			const robot = getRobotFromDevice(device);
			await robot.pressButton(button);
			return `Pressed the button: ${button}`;
		}
	);

	tool(
		"mobile_open_url",
		"Open a URL in browser on device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			url: z.string().describe("The URL to open"),
		},
		async ({ device, url }) => {
			const robot = getRobotFromDevice(device);
			await robot.openUrl(url);
			return `Opened URL: ${url}`;
		}
	);

	tool(
		"mobile_swipe_on_screen",
		"Swipe on the screen",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			direction: z.enum(["up", "down", "left", "right"]).describe("The direction to swipe"),
			x: z.number().optional().describe("The x coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			y: z.number().optional().describe("The y coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			distance: z.number().optional().describe("The distance to swipe in pixels. Defaults to 400 pixels for iOS or 30% of screen dimension for Android"),
		},
		async ({ device, direction, x, y, distance }) => {
			const robot = getRobotFromDevice(device);

			if (x !== undefined && y !== undefined) {
				// Use coordinate-based swipe
				await robot.swipeFromCoordinate(x, y, direction, distance);
				const distanceText = distance ? ` ${distance} pixels` : "";
				return `Swiped ${direction}${distanceText} from coordinates: ${x}, ${y}`;
			} else {
				// Use center-based swipe
				await robot.swipe(direction);
				return `Swiped ${direction} on screen`;
			}
		}
	);

	tool(
		"mobile_type_keys",
		"Type text into the focused element",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			text: z.string().describe("The text to type"),
			submit: z.boolean().describe("Whether to submit the text. If true, the text will be submitted as if the user pressed the enter key."),
		},
		async ({ device, text, submit }) => {
			const robot = getRobotFromDevice(device);
			await robot.sendKeys(text);

			if (submit) {
				await robot.pressButton("ENTER");
			}

			return `Typed text: ${text}`;
		}
	);

	tool(
		"mobile_save_screenshot",
		"Save a screenshot of the mobile device to a file",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			saveTo: z.string().describe("The path to save the screenshot to"),
		},
		async ({ device, saveTo }) => {
			const robot = getRobotFromDevice(device);

			const screenshot = await robot.getScreenshot();
			fs.writeFileSync(saveTo, screenshot);
			return `Screenshot saved to: ${saveTo}`;
		}
	);

	server.tool(
		"mobile_take_screenshot",
		"Take a screenshot of the mobile device. Use this to understand what's on screen, if you need to press an element that is available through view hierarchy then you must list elements on screen instead. Do not cache this result.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		async ({ device }) => {
			try {
				const robot = getRobotFromDevice(device);

				const screenshot = await robot.getScreenshot();
				const mimeType = "image/png";

				// validate we received a png, will throw exception otherwise
				const image = new PNG(screenshot);
				const pngSize = image.getDimensions();
				if (pngSize.width <= 0 || pngSize.height <= 0) {
					throw new ActionableError("Screenshot is invalid. Please try again.");
				}

				const screenshot64 = screenshot.toString("base64");
				trace(`Screenshot taken: ${screenshot.length} bytes`);
				posthog("tool_invoked", {
					"ToolName": "mobile_take_screenshot",
					"ScreenshotFilesize": screenshot64.length,
					"ScreenshotMimeType": mimeType,
					"ScreenshotWidth": pngSize.width,
					"ScreenshotHeight": pngSize.height,
				}).then();

				return {
					content: [{ type: "image", data: screenshot64, mimeType }]
				};
			} catch (err: any) {
				error(`Error taking screenshot: ${err.message} ${err.stack}`);
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					isError: true,
				};
			}
		}
	);

	tool(
		"mobile_set_orientation",
		"Change the screen orientation of the device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			orientation: z.enum(["portrait", "landscape"]).describe("The desired orientation"),
		},
		async ({ device, orientation }) => {
			const robot = getRobotFromDevice(device);
			await robot.setOrientation(orientation);
			return `Changed device orientation to ${orientation}`;
		}
	);

	tool(
		"mobile_get_orientation",
		"Get the current screen orientation of the device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const orientation = await robot.getOrientation();
			return `Current device orientation is ${orientation}`;
		}
	);

	tool(
		"mobile_detect_ui_elements",
		"Detect UI elements in Unity games or apps where native accessibility APIs don't work. Uses Computer Vision (edge detection + contour analysis) to find buttons, icons, and other UI elements. Returns coordinates that can be used with mobile_click_on_screen_at_coordinates. Requires Python 3 and OpenCV (pip3 install -r src/cv/requirements.txt).",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			min_area: z.number().optional().describe("Minimum area in pixels for UI elements (default: 400). Smaller values detect smaller elements but may include noise."),
		},
		async ({ device, min_area }) => {
			// Check if Python CV is available
			const availability = isPythonCVAvailable();
			if (!availability.available) {
				throw new ActionableError(
					`Computer Vision features require Python 3 and OpenCV. ${availability.error}`
				);
			}

			const robot = getRobotFromDevice(device);

			// Take screenshot
			const screenshot = await robot.getScreenshot();
			const screenshotBase64 = screenshot.toString("base64");

			// Detect UI elements
			const result = detectUIElements(screenshotBase64, min_area || 400);

			if (!result.success) {
				throw new ActionableError(result.error || "UI detection failed");
			}

			// Format response
			const elements = result.elements || [];
			return `Found ${result.count} UI elements using Computer Vision:\n${JSON.stringify(elements, null, 2)}\n\nYou can click on these elements using mobile_click_on_screen_at_coordinates with the center_x and center_y values.`;
		}
	);

	tool(
		"mobile_click_similar_ui_element",
		"Detect UI elements and automatically click on the most similar element matching the criteria. Useful for clicking buttons by type, position, or other properties. Returns coordinates that can be used with mobile_click_on_screen_at_coordinates. Requires Python 3 and OpenCV (pip3 install -r src/cv/requirements.txt).",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			element_type: z.string().optional().describe("Filter by element type (e.g., 'color_button_green', 'rectangle', 'circle', 'polygon'). If not specified, finds the most clickable element."),
			min_confidence: z.number().optional().describe("Minimum confidence threshold (0.0-1.0, default: 0.6). Higher values = more strict matching."),
			position: z.enum(["top", "bottom", "center", "left", "right"]).optional().describe("Preferred position on screen. If multiple elements match, prefers this position."),
			min_area: z.number().optional().describe("Minimum area in pixels for UI elements (default: 400). Smaller values detect smaller elements but may include noise."),
		},
		async ({ device, element_type, min_confidence, position, min_area }) => {
			// Check if Python CV is available
			const availability = isPythonCVAvailable();
			if (!availability.available) {
				throw new ActionableError(
					`Computer Vision features require Python 3 and OpenCV. ${availability.error}`
				);
			}

			const robot = getRobotFromDevice(device);
			const screenSize = await robot.getScreenSize();

			// Take screenshot
			const screenshot = await robot.getScreenshot();
			const screenshotBase64 = screenshot.toString("base64");

			// Detect UI elements
			const result = detectUIElements(screenshotBase64, min_area || 400);

			if (!result.success) {
				throw new ActionableError(result.error || "UI detection failed");
			}

			const elements = result.elements || [];
			if (elements.length === 0) {
				throw new ActionableError("No UI elements detected. Try lowering min_area parameter.");
			}

			// Filter and score elements
			let candidates = elements;

			// Filter by type if specified
			if (element_type) {
				candidates = candidates.filter(e => e.type === element_type);
				if (candidates.length === 0) {
					throw new ActionableError(`No elements found with type "${element_type}". Available types: ${[...new Set(elements.map(e => e.type))].join(", ")}`);
				}
			}

			// Filter by confidence
			const confidenceThreshold = min_confidence || 0.6;
			candidates = candidates.filter(e => e.confidence >= confidenceThreshold);
			if (candidates.length === 0) {
				throw new ActionableError(`No elements found with confidence >= ${confidenceThreshold}. Try lowering min_confidence.`);
			}

			// Score elements based on various factors
			const scored = candidates.map(elem => {
				let score = elem.confidence;

				// Prefer color-based detections (more reliable for buttons)
				if (elem.type.startsWith("color_button_")) {
					score += 0.2;
				}

				// Prefer rectangles and circles over polygons (more likely to be buttons)
				if (elem.type === "rectangle" || elem.type === "circle") {
					score += 0.1;
				}

				// Prefer elements with reasonable size (not too small, not too large)
				const areaRatio = elem.area / (screenSize.width * screenSize.height);
				if (areaRatio > 0.001 && areaRatio < 0.3) {
					score += 0.1;
				}

				// Position preference
				if (position) {
					const centerX = elem.center_x / screenSize.width;
					const centerY = elem.center_y / screenSize.height;

					if (position === "top" && centerY < 0.3) {
						score += 0.15;
					} else if (position === "bottom" && centerY > 0.7) {
						score += 0.15;
					} else if (position === "center" && centerY > 0.3 && centerY < 0.7) {
						score += 0.15;
					} else if (position === "left" && centerX < 0.3) {
						score += 0.15;
					} else if (position === "right" && centerX > 0.7) {
						score += 0.15;
					}
				}

				return { ...elem, score };
			});

			// Sort by score (highest first)
			scored.sort((a, b) => b.score - a.score);

			// Get the best match
			const bestMatch = scored[0];

			// Click on the best match
			await robot.tap(bestMatch.center_x, bestMatch.center_y);

			return `Clicked on the most similar UI element:\nType: ${bestMatch.type}\nConfidence: ${bestMatch.confidence}\nScore: ${bestMatch.score.toFixed(2)}\nPosition: (${bestMatch.center_x}, ${bestMatch.center_y})\nArea: ${bestMatch.area}px²\n\nMatched from ${candidates.length} candidate(s) out of ${elements.length} total detected elements.`;
		}
	);

	tool(
		"mobile_find_element_by_template",
		"Find UI elements in Unity games by matching a template image. Useful when you have a screenshot of a button/icon you want to find. Works with different scales and returns all matches with confidence scores. Requires Python 3 and OpenCV (pip3 install -r src/cv/requirements.txt).",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			template_image_base64: z.string().describe("Base64 encoded template image to search for (the UI element you want to find)"),
			confidence_threshold: z.number().optional().describe("Minimum confidence threshold 0.0-1.0 (default: 0.7). Higher values = more strict matching."),
		},
		async ({ device, template_image_base64, confidence_threshold }) => {
			// Check if Python CV is available
			const availability = isPythonCVAvailable();
			if (!availability.available) {
				throw new ActionableError(
					`Computer Vision features require Python 3 and OpenCV. ${availability.error}`
				);
			}

			const robot = getRobotFromDevice(device);

			// Take screenshot
			const screenshot = await robot.getScreenshot();
			const screenshotBase64 = screenshot.toString("base64");

			// Find matches
			const result = findElementByTemplate(
				screenshotBase64,
				template_image_base64,
				confidence_threshold || 0.7
			);

			if (!result.success) {
				throw new ActionableError(result.error || "Template matching failed");
			}

			// Format response
			const matches = result.matches || [];
			if (matches.length === 0) {
				return `No matches found. Try lowering the confidence threshold (current: ${confidence_threshold || 0.7})`;
			}

			return `Found ${result.count} matches:\n${JSON.stringify(matches, null, 2)}\n\nYou can click on these elements using mobile_click_on_screen_at_coordinates with the center_x and center_y values.`;
		}
	);

	// Unity game button tools
	interface UnityButton {
		GameObjectName: string;
		SpecifiedName: string;
		Description: string;
		PositionX: number;
		PositionY: number;
	}

	tool(
		"mobile_unity_find_buttons",
		"Find all available buttons in Unity game screen. Calls the Unity findButtons API to get button information including names, descriptions, and positions.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			api_url: z.string().optional().describe("Optional URL for the findButtons API. Defaults to http://localhost:37772/api/findButtons"),
		},
		async ({ device, api_url }) => {
			const url = api_url || "http://localhost:37772/api/findButtons";

			try {
				// Verify device exists
				getRobotFromDevice(device);

				// Call the Unity findButtons API
				const response = await fetch(url);

				if (!response.ok) {
					throw new ActionableError(
						`Failed to fetch buttons from Unity API at ${url}. Status: ${response.status}. ` +
						`Make sure the Unity game and API server are running at the specified URL.`
					);
				}

				const buttons: UnityButton[] = await response.json();

				if (!Array.isArray(buttons)) {
					throw new ActionableError(
						`Unity API returned invalid data format. Expected an array of buttons.`
					);
				}

				if (buttons.length === 0) {
					return `No buttons found on the Unity game screen. Make sure the game is displaying the expected screen.`;
				}

				// Format the response
				const buttonList = buttons.map((btn, index) => ({
					index: index + 1,
					name: btn.SpecifiedName,
					description: btn.Description,
					position: { x: btn.PositionX, y: btn.PositionY },
					gameObject: btn.GameObjectName,
				}));

				return `Found ${buttons.length} buttons on Unity game screen:\n${JSON.stringify(buttonList, null, 2)}\n\nYou can click on these buttons using mobile_unity_click_button with the button name.`;
			} catch (error: any) {
				if (error instanceof ActionableError) {
					throw error;
				}

				// Handle network errors
				if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
					throw new ActionableError(
						`Cannot connect to Unity API at ${url}. ` +
						`Please verify that the Unity game and API server are running and accessible.`
					);
				}

				throw new ActionableError(
					`Error fetching Unity buttons: ${error.message}`
				);
			}
		}
	);

	tool(
		"mobile_unity_click_button",
		"Click a specific button in Unity game by button name. Finds the button using the Unity findButtons API and clicks at its position.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			button_name: z.string().describe("The SpecifiedName of the button to click (e.g., 'DailyShop_daily_demon_stone_50')"),
			api_url: z.string().optional().describe("Optional URL for the findButtons API. Defaults to http://localhost:37772/api/findButtons"),
		},
		async ({ device, button_name, api_url }) => {
			const url = api_url || "http://localhost:37772/api/findButtons";

			try {
				// Get the robot for this device
				const robot = getRobotFromDevice(device);

				// Call the Unity findButtons API
				const response = await fetch(url);

				if (!response.ok) {
					throw new ActionableError(
						`Failed to fetch buttons from Unity API at ${url}. Status: ${response.status}. ` +
						`Make sure the Unity game and API server are running at the specified URL.`
					);
				}

				const buttons: UnityButton[] = await response.json();

				if (!Array.isArray(buttons)) {
					throw new ActionableError(
						`Unity API returned invalid data format. Expected an array of buttons.`
					);
				}

				// Find the button by SpecifiedName
				const button = buttons.find(btn => btn.SpecifiedName === button_name);

				if (!button) {
					const availableButtons = buttons.map(b => b.SpecifiedName).join(", ");
					throw new ActionableError(
						`Button "${button_name}" not found. Available buttons: ${availableButtons || "none"}. ` +
						`Use mobile_unity_find_buttons to see all available buttons.`
					);
				}

				// Get screen size to convert Unity coordinates (bottom-left origin) to screen coordinates (top-left origin)
				const screenSize = await robot.getScreenSize();

				// Convert Unity Y coordinate (bottom-left origin) to screen Y coordinate (top-left origin)
				const screenX = button.PositionX;
				const screenY = screenSize.height - button.PositionY;

				// Click at the button's position
				await robot.tap(screenX, screenY);

				return `Clicked button "${button_name}" at Unity position (${button.PositionX}, ${button.PositionY}), converted to screen position (${screenX}, ${screenY}). Description: ${button.Description}`;
			} catch (error: any) {
				if (error instanceof ActionableError) {
					throw error;
				}

				// Handle network errors
				if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
					throw new ActionableError(
						`Cannot connect to Unity API at ${url}. ` +
						`Please verify that the Unity game and API server are running and accessible.`
					);
				}

				throw new ActionableError(
					`Error clicking Unity button: ${error.message}`
				);
			}
		}
	);

	tool(
		"mobile_click_button_by_inference",
		"Run vLLM inference on a screenshot to extract UI information from the current screen. Use mobile_take_screenshot first to get a screenshot, then pass the base64 image data to this tool. This tool automatically detects and extracts UI elements using AI inference without clicking.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			text: z.string().optional().describe("Exact text match to filter elements. If provided, will search for elements with matching text."),
			text_contains: z.string().optional().describe("Partial text match to filter elements. If provided, will search for elements containing this text."),
			category: z.string().optional().describe("Category filter (e.g., 'Text', 'Picture', 'Button'). If provided, will filter elements by category."),
			screenshot_base64: z.string().optional().describe("Base64 encoded screenshot image from mobile_take_screenshot tool. If not provided, will take a new screenshot from the device."),
			image_path: z.string().optional().describe("Optional path to image file. If screenshot_base64 is provided, this will be ignored."),
			prompt_mode: z.string().optional().describe("Prompt mode for inference (default: 'prompt_layout_all_en')"),
			ip: z.string().optional().describe("vLLM server IP (default: 'localhost')"),
			port: z.number().optional().describe("vLLM server port (default: 8000)"),
			model_name: z.string().optional().describe("Model name for inference (default: 'rednote-hilab/dots.ocr')"),
		},
		async ({ device, text, text_contains, category, screenshot_base64, image_path, prompt_mode, ip, port, model_name }) => {
			const robot = getRobotFromDevice(device);
			let screenshotBuffer: Buffer;

			// Priority: screenshot_base64 > image_path > take new screenshot
			if (screenshot_base64) {
				// Use base64 screenshot from mobile_take_screenshot tool
				screenshotBuffer = Buffer.from(screenshot_base64, "base64");
			} else if (image_path) {
				// Use provided image path
				if (!fs.existsSync(image_path)) {
					throw new ActionableError(`Image file not found: ${image_path}`);
				}
				screenshotBuffer = fs.readFileSync(image_path);
			} else {
				// Take new screenshot using the same logic as mobile_take_screenshot tool
				const screenshot = await robot.getScreenshot();

				// Validate screenshot
				const image = new PNG(screenshot);
				const pngSize = image.getDimensions();
				if (pngSize.width <= 0 || pngSize.height <= 0) {
					throw new ActionableError("Screenshot is invalid. Please try again.");
				}

				screenshotBuffer = screenshot;
			}

			try {
				// Convert image to base64 (same format as Python PILimage_to_base64)
				// Detect image format from buffer
				let mimeType = "image/png";
				if (screenshotBuffer[0] === 0xFF && screenshotBuffer[1] === 0xD8) {
					mimeType = "image/jpeg";
				}
				const imageBase64 = screenshotBuffer.toString("base64");
				const imageDataUrl = `data:${mimeType};base64,${imageBase64}`;

				// Prompt mode mapping (same as Python dict_promptmode_to_prompt)
				const promptModes: Record<string, string> = {
					"prompt_layout_all_en": `Please output the layout information from the PDF image, including each layout element's bbox, its category, and the corresponding text content within the bbox.

1. Bbox format: [x1, y1, x2, y2]

2. Layout Categories: The possible categories are ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title'].

3. Text Extraction & Formatting Rules:
    - Picture: For the 'Picture' category, the text field should be omitted.
    - Formula: Format its text as LaTeX.
    - Table: Format its text as HTML.
    - All Others (Text, Title, etc.): Format their text as Markdown.

4. Constraints:
    - The output text must be the original text from the image, with no translation.
    - All layout elements must be sorted according to human reading order.

5. Final Output: The entire output must be a single JSON object.`,
					"prompt_layout_only_en": `Please output the layout information from this PDF image, including each layout's bbox and its category. The bbox should be in the format [x1, y1, x2, y2]. The layout categories for the PDF document include ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title']. Do not output the corresponding text. The layout result should be in JSON format.`,
					"prompt_ocr": "Extract the text content from this image.",
					"prompt_grounding_ocr": "Extract text from the given bounding box on the image (format: [x1, y1, x2, y2]).\nBounding Box:\n"
				};

				const selectedPromptMode = prompt_mode || "prompt_layout_all_en";
				const prompt = promptModes[selectedPromptMode];
				if (!prompt) {
					throw new ActionableError(`Invalid prompt_mode: ${selectedPromptMode}. Available modes: ${Object.keys(promptModes).join(", ")}`);
				}

				// Call vLLM API (same as Python inference_with_vllm)
				const vllmIp = ip || "210.109.83.123";
				const vllmPort = port || 8000;
				const vllmModel = model_name || "model";
				const apiKey = process.env.API_KEY || "0";
				const vllmUrl = `http://${vllmIp}:${vllmPort}/v1/chat/completions`;

				const requestBody = {
					model: vllmModel,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image_url",
									image_url: { url: imageDataUrl }
								},
								{
									type: "text",
									text: `<|img|><|imgpad|><|endofimg|>${prompt}`
								}
							]
						}
					],
					temperature: 0.1,
					top_p: 0.9,
					max_completion_tokens: 32768
				};

				trace(`Calling vLLM API at ${vllmUrl} with model ${vllmModel}`);
				trace(`Request body: ${JSON.stringify({ ...requestBody, messages: [{ ...requestBody.messages[0], content: [{ type: "image_url", image_url: { url: "[IMAGE_DATA]" } }, requestBody.messages[0].content[1]] }] })}`);

				let response: Response;
				try {
					// Add timeout using AbortController (60 seconds for inference)
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 60000);

					response = await fetch(vllmUrl, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Authorization": `Bearer ${apiKey}`
						},
						body: JSON.stringify(requestBody),
						signal: controller.signal
					});

					clearTimeout(timeoutId);
				} catch (fetchError: any) {
					// Handle network errors (connection refused, DNS errors, timeout, etc.)
					const errorMessage = fetchError.message || String(fetchError);
					const errorCode = fetchError.code || (fetchError.name === "AbortError" ? "TIMEOUT" : "UNKNOWN");
					const errorCause = fetchError.cause ? ` (cause: ${fetchError.cause})` : "";

					if (fetchError.name === "AbortError") {
						throw new ActionableError(
							`Request to vLLM server at ${vllmUrl} timed out after 60 seconds. ` +
							`The server may be processing a large request. Please verify that the FastAPI server is running and responsive.`
						);
					}

					// Check if it's a network error that might occur after server responds
					if (errorMessage.includes("fetch failed") || errorMessage.includes("network") || errorCode === "ECONNRESET" || errorCode === "EPIPE") {
						error(`Network error after request sent: ${errorMessage} (code: ${errorCode})${errorCause}`);
						throw new ActionableError(
							`Network error while communicating with vLLM server at ${vllmUrl}. ` +
							`The server may have responded but the connection was interrupted while reading the response. ` +
							`Error: ${errorMessage} (code: ${errorCode}). ` +
							`This might happen if the response is very large. Please check server logs.`
						);
					}

					error(`Fetch error: ${errorMessage} (code: ${errorCode})${errorCause}`);
					throw new ActionableError(
						`Failed to connect to vLLM server at ${vllmUrl}. Error: ${errorMessage} (code: ${errorCode}). ` +
						`Please verify that the FastAPI server is running at ${vllmIp}:${vllmPort} and accessible. ` +
						`Check if the server expects a different request format.`
					);
				}

				if (!response.ok) {
					let errorText = "";
					try {
						errorText = await response.text();
					} catch (e) {
						errorText = `Failed to read error response: ${e instanceof Error ? e.message : String(e)}`;
					}
					error(`vLLM API error: ${response.status} ${response.statusText}. Response: ${errorText}`);
					throw new ActionableError(
						`vLLM API request failed: ${response.status} ${response.statusText}. ${errorText}`
					);
				}

				let responseData: any;
				try {
					// Read response with timeout protection
					const responseText = await response.text();
					if (!responseText || responseText.trim().length === 0) {
						throw new ActionableError(
							`vLLM API returned empty response body. Status was ${response.status} ${response.statusText}. ` +
							`This might indicate the server closed the connection prematurely.`
						);
					}

					try {
						responseData = JSON.parse(responseText);
					} catch (parseError: any) {
						error(`Failed to parse JSON response. Response text (first 1000 chars): ${responseText.substring(0, 1000)}`);
						throw new ActionableError(
							`Failed to parse vLLM API response as JSON: ${parseError.message || String(parseError)}. ` +
							`The server returned a response but it's not valid JSON. Response preview: ${responseText.substring(0, 200)}`
						);
					}
				} catch (readError: any) {
					if (readError instanceof ActionableError) {
						throw readError;
					}
					// Handle errors while reading response body
					error(`Error reading response body: ${readError.message || String(readError)}`);
					throw new ActionableError(
						`Failed to read response from vLLM server. The server may have closed the connection. ` +
						`Error: ${readError.message || String(readError)}. ` +
						`Check server logs - the request may have been processed but the response was interrupted.`
					);
				}

				const responseText = responseData.choices?.[0]?.message?.content;

				if (!responseText) {
					error(`vLLM API returned empty content. Full response: ${JSON.stringify(responseData)}`);
					throw new ActionableError(
						`vLLM API returned empty response content. Check server logs for details. ` +
						`Response structure: ${JSON.stringify(responseData).substring(0, 200)}`
					);
				}

				// Parse JSON from response (same as Python inference_from_image_path)
				let responseClean = responseText.trim();

				// Remove markdown code blocks if present
				if (responseClean.startsWith("```")) {
					const lines = responseClean.split("\n");
					let jsonStart: number | null = null;
					let jsonEnd: number | null = null;
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].trim().startsWith("```")) {
							if (jsonStart === null) {
								jsonStart = i + 1;
							} else {
								jsonEnd = i;
								break;
							}
						}
					}
					if (jsonStart !== null && jsonEnd !== null) {
						responseClean = lines.slice(jsonStart, jsonEnd).join("\n");
					}
				}

				// Try to parse JSON
				let elements: Array<{ bbox: [number, number, number, number]; category: string; text?: string }>;
				try {
					elements = JSON.parse(responseClean);
				} catch (e) {
					// Try to extract JSON array from text
					const jsonMatch = responseClean.match(/\[[\s\S]*\]/);
					if (jsonMatch) {
						try {
							elements = JSON.parse(jsonMatch[0]);
						} catch (e2) {
							throw new ActionableError(
								`Failed to parse JSON from vLLM response: ${e instanceof Error ? e.message : String(e)}`
							);
						}
					} else {
						throw new ActionableError(
							`Failed to parse JSON from vLLM response: ${e instanceof Error ? e.message : String(e)}`
						);
					}
				}

				if (!Array.isArray(elements)) {
					throw new ActionableError("vLLM response is not a JSON array");
				}
				if (elements.length === 0) {
					throw new ActionableError("No elements detected in the image. Try taking a new screenshot.");
				}

				// Filter elements based on criteria
				let candidates = elements;

				// Filter by category
				if (category) {
					candidates = candidates.filter(e => e.category === category);
					if (candidates.length === 0) {
						const availableCategories = [...new Set(elements.map(e => e.category))].join(", ");
						throw new ActionableError(
							`No elements found with category "${category}". Available categories: ${availableCategories || "none"}`
						);
					}
				}

				// Filter by exact text match
				if (text) {
					candidates = candidates.filter(e => e.text === text);
					if (candidates.length === 0) {
						const availableTexts = candidates
							.map(e => e.text)
							.filter(t => t)
							.join(", ");
						throw new ActionableError(
							`No elements found with exact text "${text}". Available texts: ${availableTexts || "none"}`
						);
					}
				}

				// Filter by partial text match
				if (text_contains) {
					candidates = candidates.filter(e => e.text && e.text.includes(text_contains));
					if (candidates.length === 0) {
						const availableTexts = elements
							.map(e => e.text)
							.filter(t => t)
							.join(", ");
						throw new ActionableError(
							`No elements found containing text "${text_contains}". Available texts: ${availableTexts || "none"}`
						);
					}
				}

				// If no filters specified, return all elements
				// candidates already contains all elements if no filters were applied

				if (candidates.length === 0) {
					throw new ActionableError("No elements detected in the image. Try taking a new screenshot.");
				}

				// Format all matching elements with center coordinates
				const formattedElements = candidates.map(element => {
					const [x1, y1, x2, y2] = element.bbox;
					const centerX = Math.round((x1 + x2) / 2);
					const centerY = Math.round((y1 + y2) / 2);

					const elementInfo: any = {
						bbox: [x1, y1, x2, y2],
						center: { x: centerX, y: centerY },
						category: element.category,
					};

					if (element.text) {
						elementInfo.text = element.text;
					}

					return elementInfo;
				});

				const filterInfo = [];
				if (text) {
					filterInfo.push(`text: "${text}"`);
				}
				if (text_contains) {
					filterInfo.push(`text_contains: "${text_contains}"`);
				}
				if (category) {
					filterInfo.push(`category: "${category}"`);
				}

				const filterText = filterInfo.length > 0
					? `\n\nFilters applied: ${filterInfo.join(", ")}`
					: "";

				return `Extracted ${candidates.length} UI element(s) from ${elements.length} total detected elements:${filterText}\n\n${JSON.stringify(formattedElements, null, 2)}`;
			} catch (error: any) {
				if (error instanceof ActionableError) {
					throw error;
				}
				throw new ActionableError(
					`Inference failed: ${error.message || String(error)}`
				);
			}
		}
	);

	return server;
};
