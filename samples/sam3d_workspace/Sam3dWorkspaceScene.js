import * as THREE from 'three';
import * as xb from 'xrblocks';
import {Keyboard} from 'xrblocks/addons/virtualkeyboard/Keyboard.js';

import {Sam3dApiClient} from './Sam3dApiClient.js';
import {MeshSelectionController} from './MeshSelectionController.js';

const POLL_INTERVAL_MS = 1000;
const DEFAULT_PROMPT = 'Generate this coffee mug';
const OVERLAY_ON_CAMERA = xb.getUrlParamBool('overlayOnCamera', false);
const USE_DESKTOP_GEMINI_CAPTURE = xb.getUrlParamBool(
  'useDesktopGeminiCapture',
  false
);
const DESKTOP_GEMINI_CAPTURE_URL = '../../assets/desktop_gemini.png';
const SAMPLE_VERSION = 'workspace-selection-v1';

function getUrlParamString(name, defaultValue = '') {
  const value = new URL(window.location.href).searchParams.get(name);
  return value ?? defaultValue;
}

function matrixToArray(object3D) {
  object3D.updateMatrix();
  return object3D.matrix.toArray();
}

function normalizeTransformMatrix(assetRecord) {
  return assetRecord?.transformMatrix || assetRecord?.transform || null;
}

async function loadImageAsDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch test capture: ${response.status}`);
  }

  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read test capture blob.'));
    reader.readAsDataURL(blob);
  });
}

export class Sam3dWorkspaceScene extends xb.Script {
  constructor() {
    super();
    this.apiClient = new Sam3dApiClient();
    this.sessionId = `session-${crypto.randomUUID()}`;
    this.currentPrompt = getUrlParamString('prompt', DEFAULT_PROMPT);
    this.lastScreenshotDataUrl = '';
    this.currentJobId = null;
    this.pollHandle = null;
    this.isRecordingPrompt = false;
    this.isPromptEditorOpen = false;
    this.promptKeyboard = null;
    this.assetInstances = new Map();
    this.activeAssetId = null;
    this.selectionController = null;
    this.isSelectionMode = false;
    this.workspaceState = this.createEmptyWorkspaceState();
  }

  createEmptyWorkspaceState() {
    return {
      sessionId: this.sessionId,
      prompt: this.currentPrompt,
      lastScreenshotDataUrl: this.lastScreenshotDataUrl,
      assets: [],
    };
  }

  init() {
    xb.core.input.addReticles();
    this.addLights();
    this.createWorkspaceUI();
    this.createPromptKeyboard();
    this.createSelectionController();
    this.bindSpeechRecognizer();
    this.updateMicDiagnostics();
    this.refreshPromptText();
    this.updateSelectionUi();
    this.setStatus(
      USE_DESKTOP_GEMINI_CAPTURE
        ? 'Ready. Capture will use assets/desktop_gemini.png for testing.'
        : 'Ready. Capture a screenshot, record a prompt, or edit it manually.'
    );
  }

  addLights() {
    this.add(new THREE.HemisphereLight(0xbbbbbb, 0x777788, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(0, 3, -1);
    this.add(light);
  }

  createWorkspaceUI() {
    this.panel = new xb.SpatialPanel({
      width: 0.92,
      height: 1.18,
      backgroundColor: '#1f2937EE',
      useDefaultPosition: false,
    });
    this.panel.isRoot = true;
    this.panel.position.set(0, xb.user.height + 0.02, -0.95);
    this.add(this.panel);

    const grid = this.panel.addGrid();

    grid.addRow({weight: 0.08}).addText({
      text: 'SAM3D Workspace',
      fontSizeDp: 28,
      fontColor: '#d1fae5',
    });

    this.statusText = grid.addRow({weight: 0.08}).addText({
      text: 'Initializing...',
      fontSizeDp: 18,
      fontColor: '#fde68a',
      anchorX: 'left',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
    });

    this.promptText = grid.addRow({weight: 0.1}).addText({
      text: '',
      fontSizeDp: 18,
      fontColor: '#bfdbfe',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.9,
      paddingX: 0.03,
      paddingY: 0.01,
    });

    const promptActionsRow = grid.addRow({weight: 0.08});
    const editPromptButton = promptActionsRow
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Edit Prompt',
        backgroundColor: '#1d4ed8',
        fontColor: '#ffffff',
        fontSizeDp: 16,
        opacity: 0.98,
        width: 0.86,
        height: 0.56,
      });
    editPromptButton.onTriggered = () => this.togglePromptEditor();

    const backspacePromptButton = promptActionsRow
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Backspace',
        backgroundColor: '#7c2d12',
        fontColor: '#ffffff',
        fontSizeDp: 16,
        opacity: 0.98,
        width: 0.86,
        height: 0.56,
      });
    backspacePromptButton.onTriggered = () => this.removeLastPromptCharacter();

    const defaultPromptButton = promptActionsRow
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Use Default',
        backgroundColor: '#475569',
        fontColor: '#ffffff',
        fontSizeDp: 16,
        opacity: 0.98,
        width: 0.86,
        height: 0.56,
      });
    defaultPromptButton.onTriggered = () => this.restoreDefaultPrompt();

    const controlsHeaderRow = grid.addRow({weight: 0.05});
    controlsHeaderRow.addText({
      text: 'Controls',
      fontSizeDp: 16,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const actionsRowTop = grid.addRow({weight: 0.11});
    const captureButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Capture',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    captureButton.onTriggered = () => this.captureScreenshot();

    this.recordButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Record',
      backgroundColor: '#9a3412',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    this.recordButton.onTriggered = () => this.togglePromptRecording();

    const generateButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Generate',
      backgroundColor: '#2563eb',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    generateButton.onTriggered = () => this.generateAsset();

    const actionsRowBottom = grid.addRow({weight: 0.11});
    const resetButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Reset',
      backgroundColor: '#6b7280',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    resetButton.onTriggered = () => this.resetWorkspace();

    this.testMicButton = actionsRowBottom
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Test Mic',
        backgroundColor: '#b45309',
        fontColor: '#ffffff',
        fontSizeDp: 18,
        opacity: 0.98,
        width: 0.82,
        height: 0.62,
      });
    this.testMicButton.onTriggered = () => this.runMicCapabilityTest();

    const loadButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Load',
      backgroundColor: '#7c3aed',
      fontColor: '#ffffff',
      fontSizeDp: 18,
      opacity: 0.98,
      width: 0.82,
      height: 0.62,
    });
    loadButton.onTriggered = () => this.loadWorkspace();

    const selectionHeaderRow = grid.addRow({weight: 0.05});
    selectionHeaderRow.addText({
      text: 'Selection',
      fontSizeDp: 16,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const selectionRow = grid.addRow({weight: 0.11});
    this.selectionModeButton = selectionRow
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Select: OFF',
        backgroundColor: '#374151',
        fontColor: '#ffffff',
        fontSizeDp: 17,
        opacity: 0.98,
        width: 0.82,
        height: 0.62,
      });
    this.selectionModeButton.onTriggered = () => this.toggleSelectionMode();

    this.paintModeButton = selectionRow
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Mode: Drop',
        backgroundColor: '#991b1b',
        fontColor: '#ffffff',
        fontSizeDp: 17,
        opacity: 0.98,
        width: 0.82,
        height: 0.62,
      });
    this.paintModeButton.onTriggered = () => this.togglePaintMode();

    this.previewSelectionButton = selectionRow
      .addCol({weight: 1 / 3})
      .addTextButton({
        text: 'Preview',
        backgroundColor: '#166534',
        fontColor: '#ffffff',
        fontSizeDp: 17,
        opacity: 0.98,
        width: 0.82,
        height: 0.62,
      });
    this.previewSelectionButton.onTriggered = () => this.previewSelection();

    const selectionActionsRow = grid.addRow({weight: 0.08});
    this.clearSelectionButton = selectionActionsRow.addTextButton({
      text: 'Reset To Full Keep',
      backgroundColor: '#4b5563',
      fontColor: '#ffffff',
      fontSizeDp: 16,
      opacity: 0.98,
      width: 0.9,
      height: 0.56,
    });
    this.clearSelectionButton.onTriggered = () => this.clearSelection();

    const diagnosticsHeaderRow = grid.addRow({weight: 0.05});
    diagnosticsHeaderRow.addText({
      text: 'Diagnostics',
      fontSizeDp: 16,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const micRow = grid.addRow({weight: 0.1});
    this.micDiagnosticsText = micRow.addText({
      text: 'Mic diagnostics: checking...',
      fontSizeDp: 15,
      fontColor: '#fbcfe8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
    });

    const previewHeaderRow = grid.addRow({weight: 0.05});
    previewHeaderRow.addText({
      text: 'Latest Capture',
      fontSizeDp: 16,
      fontColor: '#9ca3af',
      anchorX: 'left',
      textAlign: 'left',
      paddingX: 0.03,
    });

    const previewFrameRow = grid.addRow({weight: 0.22});
    const previewFrame = previewFrameRow.addPanel({
      backgroundColor: '#0f172acc',
      height: 0.92,
      width: 0.94,
      showEdge: true,
    });
    const previewGrid = previewFrame.addGrid();
    previewGrid.addRow({weight: 1.0});
    this.previewImage = previewGrid.addImage({
      src: '',
      paddingX: 0.04,
      paddingY: 0.04,
    });
    previewFrame.updateLayouts();

    const saveLoadRow = grid.addRow({weight: 0.11});
    const saveButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Save Workspace',
      backgroundColor: '#065f46',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    saveButton.onTriggered = () => this.saveWorkspace();

    const clearButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Clear Preview',
      backgroundColor: '#374151',
      fontColor: '#ffffff',
      fontSizeDp: 17,
      opacity: 0.98,
      width: 0.88,
      height: 0.58,
    });
    clearButton.onTriggered = () => {
      this.lastScreenshotDataUrl = '';
      this.workspaceState.lastScreenshotDataUrl = '';
      this.previewImage.load('');
      this.setStatus('Screenshot preview cleared.');
    };

    grid.addRow({weight: 0.1}).addText({
      text:
        'Version: ' + SAMPLE_VERSION + '\n' +
        'Workspace assets now persist canonical mesh selections per asset.',
      fontSizeDp: 12,
      fontColor: '#94a3b8',
      anchorX: 'left',
      anchorY: 'top',
      textAlign: 'left',
      maxWidth: 0.92,
      paddingX: 0.03,
    });

    this.panel.updateLayouts();
  }

  createPromptKeyboard() {
    this.promptKeyboard = new Keyboard();
    this.add(this.promptKeyboard);
    this.promptKeyboard.visible = false;
    this.promptKeyboard.position.set(0, -0.42, 0.1);
    this.promptKeyboard.setText(this.currentPrompt);

    this.promptKeyboard.onTextChanged = (text) => {
      this.currentPrompt = text || '';
      this.workspaceState.prompt = this.currentPrompt;
      this.refreshPromptText();
      this.setStatus('Editing prompt manually...');
    };

    this.promptKeyboard.onEnterPressed = (text) => {
      this.currentPrompt = text || this.currentPrompt;
      this.workspaceState.prompt = this.currentPrompt;
      this.refreshPromptText();
      this.hidePromptEditor('Prompt updated from keyboard.');
    };
  }

  createSelectionController() {
    this.selectionController = new MeshSelectionController({
      sceneRoot: this,
      onSelectionChanged: ({assetId, selections, selectedVertexCount}) => {
        this.handleSelectionChanged(assetId, selections, selectedVertexCount);
      },
      onStatus: (text) => this.setStatus(text),
    });
  }

  bindSpeechRecognizer() {
    const recognizer = xb.core.sound.speechRecognizer;
    if (!recognizer) {
      this.setStatus(
        'Speech recognition unavailable. Use Edit Prompt or the default prompt.'
      );
      return;
    }

    recognizer.addEventListener('result', (event) => {
      const {transcript, isFinal} = event;
      this.currentPrompt = transcript || this.currentPrompt;
      this.workspaceState.prompt = this.currentPrompt;
      if (this.promptKeyboard) {
        this.promptKeyboard.setText(this.currentPrompt);
      }
      this.refreshPromptText();
      if (isFinal) {
        this.isRecordingPrompt = false;
        this.updateRecordButton();
        this.setStatus('Prompt captured. You can generate now.');
      }
    });

    recognizer.addEventListener('error', (event) => {
      this.isRecordingPrompt = false;
      this.updateRecordButton();
      this.updateMicDiagnostics(`Speech error: ${event.error}`);
      this.setStatus(`Speech error: ${event.error}`);
    });

    recognizer.addEventListener('end', () => {
      this.isRecordingPrompt = false;
      this.updateRecordButton();
    });
  }

  refreshPromptText() {
    if (!this.promptText) {
      return;
    }

    const prompt = this.currentPrompt || '(empty)';
    const assetCount = this.workspaceState.assets.length;
    const activeAsset = this.activeAssetId ? this.getAssetRecord(this.activeAssetId) : null;
    const activeSuffix = this.activeAssetId
      ? ` | Active asset: ${this.activeAssetId}`
      : '';
    const selectionSuffix = activeAsset?.selections?.length
      ? ` | Selection groups: ${activeAsset.selections.length}`
      : '';
    this.promptText.text =
      `Prompt: ${prompt}\nAssets: ${assetCount}${activeSuffix}${selectionSuffix}`;
  }

  updateMicDiagnostics(extraMessage = '') {
    if (!this.micDiagnosticsText) return;
    const hasMediaDevices = !!navigator.mediaDevices?.getUserMedia;
    const hasSpeechRecognition =
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    const recognizerReady = !!xb.core.sound.speechRecognizer;

    const summary =
      `Mic API: ${hasMediaDevices ? 'yes' : 'no'} | ` +
      `Speech API: ${hasSpeechRecognition ? 'yes' : 'no'} | ` +
      `Recognizer: ${recognizerReady ? 'yes' : 'no'}`;

    this.micDiagnosticsText.text = extraMessage
      ? `${summary}\n${extraMessage}`
      : summary;
  }

  updateRecordButton() {
    if (!this.recordButton) return;
    this.recordButton.text = this.isRecordingPrompt ? 'Stop' : 'Record';
  }

  updateSelectionUi() {
    if (!this.selectionModeButton || !this.paintModeButton || !this.previewSelectionButton || !this.clearSelectionButton) {
      return;
    }

    const hasTarget = !!this.activeAssetId && !!this.assetInstances.get(this.activeAssetId);
    const paintMode = this.selectionController?.getPaintMode?.() || 'discard';

    this.selectionModeButton.text = hasTarget
      ? this.isSelectionMode
        ? 'Select: ON'
        : 'Select: OFF'
      : 'Select: N/A';
    this.selectionModeButton.backgroundColor = hasTarget
      ? this.isSelectionMode
        ? '#0f766e'
        : '#374151'
      : '#1f2937';

    this.paintModeButton.text = paintMode === 'keep' ? 'Mode: Keep' : 'Mode: Drop';
    this.paintModeButton.backgroundColor = paintMode === 'keep' ? '#166534' : '#991b1b';

    this.previewSelectionButton.text = 'Preview';
    this.previewSelectionButton.backgroundColor = hasTarget ? '#166534' : '#1f2937';

    this.clearSelectionButton.backgroundColor = hasTarget ? '#4b5563' : '#1f2937';
  }
  setStatus(text) {
    if (this.statusText) {
      this.statusText.text = text;
    }
  }

  togglePromptEditor() {
    if (!this.promptKeyboard) return;
    if (this.isPromptEditorOpen) {
      this.hidePromptEditor('Prompt editor closed.');
      return;
    }

    this.isPromptEditorOpen = true;
    this.promptKeyboard.setText(this.currentPrompt || '');
    this.promptKeyboard.visible = true;
    this.setStatus('Prompt editor open. Type on the XR keyboard and press Enter.');
  }

  hidePromptEditor(statusText = 'Prompt editor closed.') {
    if (!this.promptKeyboard) return;
    this.isPromptEditorOpen = false;
    this.promptKeyboard.visible = false;
    this.setStatus(statusText);
  }

  restoreDefaultPrompt() {
    this.currentPrompt = DEFAULT_PROMPT;
    this.workspaceState.prompt = this.currentPrompt;
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
    }
    this.refreshPromptText();
    this.setStatus('Default prompt restored.');
  }

  removeLastPromptCharacter() {
    if (!this.currentPrompt) {
      this.setStatus('Prompt is already empty.');
      return;
    }

    this.currentPrompt = this.currentPrompt.slice(0, -1);
    this.workspaceState.prompt = this.currentPrompt;
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
    }
    this.refreshPromptText();
    this.setStatus('Removed the last prompt character.');
  }

  async captureScreenshot() {
    this.setStatus('Capturing screenshot...');
    try {
      let image = '';
      if (USE_DESKTOP_GEMINI_CAPTURE) {
        image = await loadImageAsDataUrl(DESKTOP_GEMINI_CAPTURE_URL);
      } else {
        const useCameraOverlay = OVERLAY_ON_CAMERA && !!xb.core.deviceCamera;
        image = await xb.core.screenshotSynthesizer.getScreenshot(useCameraOverlay);
      }

      this.lastScreenshotDataUrl = image;
      this.workspaceState.lastScreenshotDataUrl = image;
      this.previewImage.load(image);
      this.setStatus(
        USE_DESKTOP_GEMINI_CAPTURE
          ? 'Loaded test capture from assets/desktop_gemini.png.'
          : OVERLAY_ON_CAMERA && !!xb.core.deviceCamera
            ? 'Camera-overlay screenshot captured.'
            : 'Scene screenshot captured.'
      );
    } catch (error) {
      console.error('Failed to capture screenshot.', error);
      this.setStatus('Screenshot capture failed.');
    }
  }

  togglePromptRecording() {
    const recognizer = xb.core.sound.speechRecognizer;
    if (!recognizer) {
      this.setStatus('Speech recognition is unavailable in this browser.');
      this.updateMicDiagnostics('No recognizer instance is available.');
      return;
    }

    if (this.isRecordingPrompt) {
      recognizer.stop();
      this.isRecordingPrompt = false;
      this.setStatus('Stopped listening for prompt.');
    } else {
      this.isRecordingPrompt = true;
      this.updateMicDiagnostics('Speech recognizer start requested.');
      this.setStatus('Listening for prompt...');
      recognizer.start();
    }
    this.updateRecordButton();
  }

  async runMicCapabilityTest() {
    this.setStatus('Requesting microphone access...');
    this.updateMicDiagnostics('Testing microphone access...');

    if (!navigator.mediaDevices?.getUserMedia) {
      this.updateMicDiagnostics('getUserMedia is not available in this browser.');
      this.setStatus('Microphone API is unavailable.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const trackLabels = stream
        .getAudioTracks()
        .map((track) => track.label || 'unlabeled-track');
      stream.getTracks().forEach((track) => track.stop());

      const labelSummary =
        trackLabels.length > 0 ? trackLabels.join(', ') : 'audio track opened';
      this.updateMicDiagnostics(`Mic test passed: ${labelSummary}`);
      this.setStatus(
        'Microphone access succeeded. Speech API may still be unsupported.'
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown mic test failure';
      this.updateMicDiagnostics(`Mic test failed: ${message}`);
      this.setStatus(`Microphone test failed: ${message}`);
    }
  }

  setActiveAsset(assetId) {
    this.activeAssetId = assetId;
    this.syncSelectionController();
    this.refreshPromptText();
  }

  getAssetRecord(assetId) {
    return this.workspaceState.assets.find((asset) => asset.assetId === assetId) || null;
  }

  upsertAssetRecord(assetRecord) {
    const index = this.workspaceState.assets.findIndex(
      (asset) => asset.assetId === assetRecord.assetId
    );
    if (index >= 0) {
      this.workspaceState.assets[index] = assetRecord;
    } else {
      this.workspaceState.assets.push(assetRecord);
    }
    this.refreshPromptText();
    this.updateSelectionUi();
  }

  removeAssetInstance(assetId) {
    const model = this.assetInstances.get(assetId);
    if (!model) return;
    this.remove(model);
    this.assetInstances.delete(assetId);
    if (this.activeAssetId === assetId) {
      this.activeAssetId = null;
    }
  }

  clearAssetInstances() {
    for (const assetId of [...this.assetInstances.keys()]) {
      this.removeAssetInstance(assetId);
    }
    this.syncSelectionController();
  }

  getDefaultPlacementForIndex(index) {
    return {
      x: ((index % 3) - 1) * 0.32,
      y: 0.78,
      z: -1.1 - Math.floor(index / 3) * 0.16,
    };
  }

  createAssetRecordFromResponse(asset, existingRecord = null) {
    return {
      assetId: asset.assetId,
      latentHandle: asset.latentHandle,
      glbUrl: asset.glbUrl,
      prompt: asset.metadata?.prompt || this.currentPrompt,
      thumbnailUrl: asset.thumbnailUrl || this.lastScreenshotDataUrl,
      transformMatrix: normalizeTransformMatrix(existingRecord) || null,
      selections: existingRecord?.selections || [],
    };
  }

  buildWorkspaceSnapshot() {
    const assets = this.workspaceState.assets.map((assetRecord) => {
      const model = this.assetInstances.get(assetRecord.assetId);
      return {
        assetId: assetRecord.assetId,
        latentHandle: assetRecord.latentHandle,
        glbUrl: assetRecord.glbUrl,
        prompt: assetRecord.prompt,
        thumbnailUrl: assetRecord.thumbnailUrl,
        transformMatrix: model
          ? matrixToArray(model)
          : normalizeTransformMatrix(assetRecord),
        selections: assetRecord.selections || [],
      };
    });

    return {
      sessionId: this.workspaceState.sessionId,
      prompt: this.currentPrompt,
      lastScreenshotDataUrl: this.lastScreenshotDataUrl,
      assets,
    };
  }

  handleSelectionChanged(assetId, selections, selectedVertexCount) {
    if (!assetId) {
      return;
    }
    const assetRecord = this.getAssetRecord(assetId);
    if (!assetRecord) {
      return;
    }

    this.upsertAssetRecord({
      ...assetRecord,
      selections,
    });

    if (selectedVertexCount === 0) {
      this.setStatus(`Selection reset for ${assetId}. Whole asset is implicitly kept again.`);
    }
  }

  syncSelectionController() {
    if (!this.selectionController) {
      return;
    }

    const activeAssetId = this.activeAssetId;
    const activeModel = activeAssetId ? this.assetInstances.get(activeAssetId) : null;
    const activeAssetRecord = activeAssetId ? this.getAssetRecord(activeAssetId) : null;

    if (activeAssetId && activeModel && activeAssetRecord) {
      this.selectionController.attach({
        assetId: activeAssetId,
        model: activeModel,
        selections: activeAssetRecord.selections || [],
      });
      this.selectionController.setDrawMode(this.isSelectionMode);
    } else {
      this.selectionController.detach();
    }

    this.applyWorkspaceInteractionPolicy();
    this.updateSelectionUi();
  }

  applyWorkspaceInteractionPolicy() {
    const allowModelInteraction =
      !this.isSelectionMode || !this.selectionController?.hasTarget();

    for (const model of this.assetInstances.values()) {
      model.draggable = allowModelInteraction;
      model.rotatable = allowModelInteraction;
      model.scalable = allowModelInteraction;
      model.traverse((node) => {
        node.ignoreReticleRaycast = !allowModelInteraction;
      });
    }
  }

  togglePaintMode() {
    if (!this.selectionController) {
      return;
    }
    const nextMode = this.selectionController.getPaintMode() === 'keep'
      ? 'discard'
      : 'keep';
    this.selectionController.setPaintMode(nextMode);
    this.updateSelectionUi();
    this.setStatus(
      nextMode === 'keep'
        ? 'Paint mode set to keep. Green sculpt strokes will preserve geometry.'
        : 'Paint mode set to discard. Red sculpt strokes will remove geometry from the keep set.'
    );
  }
  toggleSelectionMode() {
    if (!this.activeAssetId || !this.assetInstances.get(this.activeAssetId)) {
      this.setStatus('Load or generate an asset before entering selection mode.');
      return;
    }

    this.isSelectionMode = !this.isSelectionMode;
    this.selectionController.setDrawMode(this.isSelectionMode);
    this.applyWorkspaceInteractionPolicy();
    this.updateSelectionUi();
    this.setStatus(
      this.isSelectionMode
        ? `Selection mode enabled for ${this.activeAssetId}. Pinch-drag to ${this.selectionController.getPaintMode() === 'keep' ? 'keep' : 'discard'} geometry with the sculpt brush.`
        : 'Selection mode disabled. Object manipulation restored.'
    );
  }

  previewSelection() {
    if (!this.selectionController?.hasTarget()) {
      this.setStatus('No active asset is ready for selection preview.');
      return;
    }

    const count = this.selectionController.renderSelectionPreview();
    this.updateSelectionUi();
    if (count === 0) {
      this.setStatus('No kept vertices to preview yet.');
      return;
    }
    this.setStatus(`Previewing ${count} kept vertices in green.`);
  }

  clearSelection() {
    if (!this.selectionController?.hasTarget()) {
      this.setStatus('No active asset is ready for selection editing.');
      return;
    }

    this.selectionController.clearSelection();
    this.updateSelectionUi();
    this.setStatus(`Selection reset for ${this.activeAssetId}. Whole asset is implicitly kept again.`);
  }
  async generateAsset() {
    if (!this.lastScreenshotDataUrl) {
      this.setStatus('Capture a screenshot before generating.');
      return;
    }

    if (!this.currentPrompt) {
      this.setStatus('Provide a prompt before generating.');
      return;
    }

    if (this.currentJobId) {
      this.setStatus('A generation job is already running.');
      return;
    }

    const job = await this.apiClient.createGenerationJob({
      sessionId: this.sessionId,
      prompt: this.currentPrompt,
      image: this.lastScreenshotDataUrl,
    });

    this.currentJobId = job.jobId;
    this.setStatus(`Job queued: ${job.jobId}`);
    this.startPollingJob(job.jobId);
  }

  startPollingJob(jobId) {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
    }

    this.pollHandle = setInterval(async () => {
      const update = await this.apiClient.getJob(jobId);
      if (update.status === 'running' || update.status === 'queued') {
        const progress = update.progress
          ? `${Math.round(update.progress * 100)}%`
          : 'starting';
        this.setStatus(
          `Generation ${update.status}: ${progress}${
            update.message ? ` - ${update.message}` : ''
          }`
        );
        return;
      }

      clearInterval(this.pollHandle);
      this.pollHandle = null;
      this.currentJobId = null;

      if (update.status === 'failed') {
        this.setStatus(update.error || 'Generation failed.');
        return;
      }

      await this.loadGeneratedAsset(update.asset);
    }, POLL_INTERVAL_MS);
  }

  async instantiateAssetRecord(assetRecord, {setActive = true} = {}) {
    this.setStatus(`Loading asset ${assetRecord.assetId}...`);

    this.removeAssetInstance(assetRecord.assetId);

    const model = new xb.ModelViewer({});
    this.add(model);

    const {path, model: modelName} = this.splitAssetUrl(assetRecord.glbUrl);
    await model.loadGLTFModel({
      data: {
        path,
        model: modelName,
        scale: {x: 0.9, y: 0.9, z: 0.9},
      },
      renderer: xb.core.renderer,
    });

    const transformMatrix = normalizeTransformMatrix(assetRecord);
    if (transformMatrix) {
      this.applyTransformToModel(model, transformMatrix);
    } else {
      const placement = this.getDefaultPlacementForIndex(this.workspaceState.assets.length);
      model.position.set(placement.x, placement.y, placement.z);
      model.updateMatrix();
      assetRecord.transformMatrix = matrixToArray(model);
    }

    this.assetInstances.set(assetRecord.assetId, model);
    this.upsertAssetRecord({
      ...assetRecord,
      transformMatrix: normalizeTransformMatrix(assetRecord) || matrixToArray(model),
      selections: assetRecord.selections || [],
    });

    if (setActive) {
      this.setActiveAsset(assetRecord.assetId);
    } else {
      this.applyWorkspaceInteractionPolicy();
      this.updateSelectionUi();
    }

    return model;
  }

  async loadGeneratedAsset(asset) {
    const existingRecord = this.getAssetRecord(asset.assetId);
    const assetRecord = this.createAssetRecordFromResponse(asset, existingRecord);
    const model = await this.instantiateAssetRecord(assetRecord);
    assetRecord.transformMatrix = matrixToArray(model);
    this.upsertAssetRecord(assetRecord);
    this.currentPrompt = assetRecord.prompt || this.currentPrompt;
    this.workspaceState.prompt = this.currentPrompt;
    this.refreshPromptText();
    this.setStatus(
      `Generated asset loaded. Active asset: ${assetRecord.assetId}. Workspace assets: ${this.workspaceState.assets.length}.`
    );
  }

  splitAssetUrl(url) {
    const lastSlash = url.lastIndexOf('/') + 1;
    return {
      path: url.slice(0, lastSlash),
      model: url.slice(lastSlash),
    };
  }

  async saveWorkspace() {
    const workspace = this.buildWorkspaceSnapshot();
    const saved = await this.apiClient.saveWorkspace(workspace);
    const destination = this.apiClient.getStorageLabel();
    const savedAt = saved?.savedAt
      ? new Date(saved.savedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'just now';

    if (workspace.assets.length === 0) {
      this.setStatus(`Workspace saved to ${destination} with no assets yet (${savedAt}).`);
      return;
    }
    this.setStatus(
      `Workspace saved to ${destination} at ${savedAt} with ${workspace.assets.length} asset(s).`
    );
  }

  async loadWorkspace() {
    const saved = await this.apiClient.loadWorkspace();
    if (!saved?.workspace) {
      this.setStatus(`No saved workspace found in ${this.apiClient.getStorageLabel()}.`);
      return;
    }

    this.clearAssetInstances();
    this.workspaceState = {
      sessionId: saved.workspace.sessionId || this.sessionId,
      prompt: saved.workspace.prompt || this.currentPrompt,
      lastScreenshotDataUrl: saved.workspace.lastScreenshotDataUrl || '',
      assets: [],
    };
    this.activeAssetId = null;

    this.currentPrompt = this.workspaceState.prompt;
    this.refreshPromptText();
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
    }

    this.lastScreenshotDataUrl = this.workspaceState.lastScreenshotDataUrl;
    this.previewImage.load(this.lastScreenshotDataUrl || '');

    const savedAssets = saved.workspace.assets || [];
    for (const savedAsset of savedAssets) {
      const normalizedRecord = {
        assetId: savedAsset.assetId,
        latentHandle: savedAsset.latentHandle,
        glbUrl: savedAsset.glbUrl,
        prompt: savedAsset.prompt,
        thumbnailUrl: savedAsset.thumbnailUrl,
        transformMatrix: normalizeTransformMatrix(savedAsset),
        selections: savedAsset.selections || [],
      };
      await this.instantiateAssetRecord(normalizedRecord, {setActive: false});
    }

    if (savedAssets.length > 0) {
      this.setActiveAsset(savedAssets[savedAssets.length - 1].assetId);
      this.setStatus(
        `Workspace restored from ${this.apiClient.getStorageLabel()} with ${savedAssets.length} asset(s).`
      );
      return;
    }

    this.syncSelectionController();
    this.setStatus(
      `Workspace restored from ${this.apiClient.getStorageLabel()} with no assets.`
    );
  }

  applyTransformToModel(model, transformArray) {
    if (!model || !transformArray) return;
    const matrix = new THREE.Matrix4().fromArray(transformArray);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    model.position.copy(position);
    model.quaternion.copy(quaternion);
    model.scale.copy(scale);
    model.updateMatrix();
  }

  resetWorkspace() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.currentJobId = null;
    this.clearAssetInstances();
    this.activeAssetId = null;
    this.isSelectionMode = false;
    this.selectionController?.detach();
    this.lastScreenshotDataUrl = '';
    this.previewImage.load('');
    this.workspaceState = this.createEmptyWorkspaceState();
    this.workspaceState.assets = [];
    if (this.promptKeyboard) {
      this.promptKeyboard.setText(this.currentPrompt);
      this.hidePromptEditor('Workspace reset.');
    }
    this.updateMicDiagnostics();
    this.updateSelectionUi();
    this.refreshPromptText();
    this.setStatus('Workspace reset.');
  }

  onSelectStart(event) {
    this.selectionController?.onSelectStart(event);
  }

  onSelecting(event) {
    this.selectionController?.onSelecting(event);
  }

  onSelectEnd(event) {
    this.selectionController?.onSelectEnd(event);
  }

  update() {
    this.selectionController?.update();
  }

  dispose() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.selectionController?.dispose();
    this.selectionController = null;
    this.clearAssetInstances();
    super.dispose();
  }
}


