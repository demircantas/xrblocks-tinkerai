import * as THREE from 'three';
import * as xb from 'xrblocks';

import {Sam3dApiClient} from './Sam3dApiClient.js';

const POLL_INTERVAL_MS = 1000;
const DEFAULT_PROMPT = 'Generate this coffee mug';
const OVERLAY_ON_CAMERA = xb.getUrlParamBool('overlayOnCamera', false);
const SAMPLE_VERSION = 'ui-debug-v4';

const PANEL_WIDTH = 1.0;
const PANEL_HEIGHT = 1.4;
const PANEL_Y_OFFSET = 0.04;

const TITLE_FONT_DP = 20;
const BODY_FONT_DP = 16;
const FOOTER_FONT_DP = 16;
const BUTTON_FONT_DP = 22;
const BUTTON_FONT_DP_WIDE = 22;
const MIC_DIAGNOSTICS_FONT_DP = 22;

const ACTION_BUTTON_HEIGHT = 0.25;
const SECONDARY_BUTTON_HEIGHT = 0.25;

const ROW_WEIGHT_TITLE = 0.05;
const ROW_WEIGHT_STATUS = 0.08;
const ROW_WEIGHT_PROMPT = 0.12;
const ROW_WEIGHT_ACTION = 0.08;
const ROW_WEIGHT_MIC = 0.18;
const ROW_WEIGHT_PREVIEW = 0.3;
const ROW_WEIGHT_SAVE = 0.08;
const ROW_WEIGHT_FOOTER = 0.08;

function getUrlParamString(name, defaultValue = '') {
  const value = new URL(window.location.href).searchParams.get(name);
  return value ?? defaultValue;
}

function matrixToArray(object3D) {
  object3D.updateMatrix();
  return object3D.matrix.toArray();
}

export class Sam3dWorkspaceScene extends xb.Script {
  constructor() {
    super();
    this.apiClient = new Sam3dApiClient();
    this.sessionId = `session-${crypto.randomUUID()}`;
    this.currentPrompt = getUrlParamString('prompt', DEFAULT_PROMPT);
    this.lastScreenshotDataUrl = '';
    this.currentJobId = null;
    this.currentAssetRecord = null;
    this.activeModelViewer = null;
    this.pollHandle = null;
    this.isRecordingPrompt = false;
  }

  init() {
    xb.core.input.addReticles();
    this.addLights();
    this.createWorkspaceUI();
    this.bindSpeechRecognizer();
    this.updateMicDiagnostics();
    this.refreshPromptText();
    this.setStatus(
      'Ready. Capture a screenshot, record a prompt, and generate an asset.'
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
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      backgroundColor: '#111827F0',
      useDefaultPosition: false,
    });
    this.panel.isRoot = true;
    this.panel.position.set(0, xb.user.height + PANEL_Y_OFFSET, -1.0);
    this.add(this.panel);

    const grid = this.panel.addGrid();

    grid.addRow({weight: ROW_WEIGHT_TITLE}).addText({
      text: 'SAM3D Workspace',
      fontSizeDp: TITLE_FONT_DP,
      fontColor: '#d1fae5',
    });

    this.statusText = grid.addRow({weight: ROW_WEIGHT_STATUS}).addText({
      text: 'Initializing...',
      fontSizeDp: BODY_FONT_DP,
      fontColor: '#fde68a',
      anchorX: 'left',
    });

    this.promptText = grid.addRow({weight: ROW_WEIGHT_PROMPT}).addText({
      text: '',
      fontSizeDp: BODY_FONT_DP,
      fontColor: '#bfdbfe',
      anchorX: 'left',
      anchorY: 'top',
    });

    const actionsRowTop = grid.addRow({weight: ROW_WEIGHT_ACTION});
    const captureButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Capture',
      backgroundColor: '#0f766e',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP,
      opacity: 0.95,
      height: ACTION_BUTTON_HEIGHT,
    });
    captureButton.onTriggered = () => this.captureScreenshot();

    this.recordButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Record Prompt',
      backgroundColor: '#7c2d12',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP_WIDE,
      opacity: 0.95,
      height: ACTION_BUTTON_HEIGHT,
    });
    this.recordButton.onTriggered = () => this.togglePromptRecording();

    const generateButton = actionsRowTop.addCol({weight: 1 / 3}).addTextButton({
      text: 'Generate',
      backgroundColor: '#1d4ed8',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP,
      opacity: 0.95,
      height: ACTION_BUTTON_HEIGHT,
    });
    generateButton.onTriggered = () => this.generateAsset();

    const actionsRowBottom = grid.addRow({weight: ROW_WEIGHT_ACTION});
    const resetButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Reset',
      backgroundColor: '#4b5563',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP,
      opacity: 0.95,
      height: ACTION_BUTTON_HEIGHT,
    });
    resetButton.onTriggered = () => this.resetWorkspace();

    this.testMicButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Test Mic',
      backgroundColor: '#92400e',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP_WIDE,
      opacity: 0.95,
      height: ACTION_BUTTON_HEIGHT,
    });
    this.testMicButton.onTriggered = () => this.runMicCapabilityTest();

    const loadButton = actionsRowBottom.addCol({weight: 1 / 3}).addTextButton({
      text: 'Load',
      backgroundColor: '#4338ca',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP,
      opacity: 0.95,
      height: ACTION_BUTTON_HEIGHT,
    });
    loadButton.onTriggered = () => this.loadWorkspace();

    const micRow = grid.addRow({weight: ROW_WEIGHT_MIC});
    const micStatusCol = micRow.addCol({weight: 1.0});
    this.micDiagnosticsText = micStatusCol.addText({
      text: 'Mic diagnostics: checking...',
      fontSizeDp: MIC_DIAGNOSTICS_FONT_DP,
      fontColor: '#fbcfe8',
      anchorX: 'left',
      anchorY: 'top',
    });

    const previewRow = grid.addRow({weight: ROW_WEIGHT_PREVIEW});
    this.previewImage = previewRow.addImage({
      src: '',
      paddingX: 0.03,
      paddingY: 0.03,
    });

    const saveLoadRow = grid.addRow({weight: ROW_WEIGHT_SAVE});
    const saveButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Save Workspace',
      backgroundColor: '#065f46',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP_WIDE,
      opacity: 0.95,
      height: SECONDARY_BUTTON_HEIGHT,
    });
    saveButton.onTriggered = () => this.saveWorkspace();

    const clearButton = saveLoadRow.addCol({weight: 0.5}).addTextButton({
      text: 'Clear Preview',
      backgroundColor: '#374151',
      fontColor: '#ffffff',
      fontSizeDp: BUTTON_FONT_DP_WIDE,
      opacity: 0.95,
      height: SECONDARY_BUTTON_HEIGHT,
    });
    clearButton.onTriggered = () => {
      this.lastScreenshotDataUrl = '';
      this.previewImage.load('');
      this.setStatus('Screenshot preview cleared.');
    };

    grid.addRow({weight: ROW_WEIGHT_FOOTER}).addText({
      text:
        'Version: ' + SAMPLE_VERSION + '\n' +
        'Phase 1 scaffold: screenshot, prompt, mic diagnostics, job polling, editable asset, save/load.',
      fontSizeDp: FOOTER_FONT_DP,
      fontColor: '#9ca3af',
      anchorX: 'left',
    });

    this.panel.updateLayouts();
  }

  bindSpeechRecognizer() {
    const recognizer = xb.core.sound.speechRecognizer;
    if (!recognizer) {
      this.setStatus('Speech recognition unavailable. Use the default prompt.');
      return;
    }

    recognizer.addEventListener('result', (event) => {
      const {transcript, isFinal} = event;
      this.currentPrompt = transcript || this.currentPrompt;
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
    if (this.promptText) {
      this.promptText.text = `Prompt: ${this.currentPrompt}`;
    }
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
    this.recordButton.text = this.isRecordingPrompt
      ? 'Stop Recording'
      : 'Record Prompt';
  }

  setStatus(text) {
    if (this.statusText) {
      this.statusText.text = text;
    }
  }

  async captureScreenshot() {
    this.setStatus('Capturing screenshot...');
    try {
      const useCameraOverlay = OVERLAY_ON_CAMERA && !!xb.core.deviceCamera;
      const image = await xb.core.screenshotSynthesizer.getScreenshot(
        useCameraOverlay
      );
      this.lastScreenshotDataUrl = image;
      this.previewImage.load(image);
      this.setStatus(
        useCameraOverlay
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

  async loadGeneratedAsset(asset) {
    this.setStatus('Loading generated asset...');

    if (this.activeModelViewer) {
      this.remove(this.activeModelViewer);
      this.activeModelViewer = null;
    }

    const model = new xb.ModelViewer({});
    this.add(model);

    const {path, model: modelName} = this.splitAssetUrl(asset.glbUrl);
    await model.loadGLTFModel({
      data: {
        path,
        model: modelName,
        scale: {x: 0.9, y: 0.9, z: 0.9},
      },
      renderer: xb.core.renderer,
    });
    model.position.set(0, 0.78, -1.1);

    this.activeModelViewer = model;
    this.currentAssetRecord = {
      assetId: asset.assetId,
      latentHandle: asset.latentHandle,
      glbUrl: asset.glbUrl,
      prompt: asset.metadata?.prompt || this.currentPrompt,
      transform: matrixToArray(model),
      thumbnailUrl: asset.thumbnailUrl || this.lastScreenshotDataUrl,
    };

    this.setStatus('Generated asset loaded. Drag to move and rotate in XR.');
  }

  splitAssetUrl(url) {
    const lastSlash = url.lastIndexOf('/') + 1;
    return {
      path: url.slice(0, lastSlash),
      model: url.slice(lastSlash),
    };
  }

  buildWorkspaceSnapshot() {
    if (!this.activeModelViewer || !this.currentAssetRecord) {
      return {
        assets: [],
      };
    }

    return {
      assets: [
        {
          assetId: this.currentAssetRecord.assetId,
          latentHandle: this.currentAssetRecord.latentHandle,
          glbUrl: this.currentAssetRecord.glbUrl,
          prompt: this.currentAssetRecord.prompt,
          thumbnailUrl: this.currentAssetRecord.thumbnailUrl,
          transform: matrixToArray(this.activeModelViewer),
          selections: [],
        },
      ],
    };
  }

  async saveWorkspace() {
    const workspace = this.buildWorkspaceSnapshot();
    await this.apiClient.saveWorkspace(workspace);
    if (workspace.assets.length === 0) {
      this.setStatus('Workspace saved with no assets yet.');
      return;
    }
    this.setStatus('Workspace saved locally through the scaffold client.');
  }

  async loadWorkspace() {
    const saved = await this.apiClient.loadWorkspace();
    if (!saved?.workspace?.assets?.length) {
      this.setStatus('No saved workspace found.');
      return;
    }

    const asset = saved.workspace.assets[0];
    await this.loadGeneratedAsset({
      assetId: asset.assetId,
      glbUrl: asset.glbUrl,
      thumbnailUrl: asset.thumbnailUrl,
      latentHandle: asset.latentHandle,
      metadata: {prompt: asset.prompt},
    });
    this.applyTransformToActiveModel(asset.transform);
    if (asset.thumbnailUrl) {
      this.lastScreenshotDataUrl = asset.thumbnailUrl;
      this.previewImage.load(asset.thumbnailUrl);
    }
    this.currentPrompt = asset.prompt || this.currentPrompt;
    this.refreshPromptText();
    this.setStatus('Workspace restored from the scaffold client save.');
  }

  applyTransformToActiveModel(transformArray) {
    if (!this.activeModelViewer || !transformArray) return;
    const matrix = new THREE.Matrix4().fromArray(transformArray);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    this.activeModelViewer.position.copy(position);
    this.activeModelViewer.quaternion.copy(quaternion);
    this.activeModelViewer.scale.copy(scale);
    this.activeModelViewer.updateMatrix();
  }

  resetWorkspace() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.currentJobId = null;
    this.currentAssetRecord = null;
    this.lastScreenshotDataUrl = '';
    this.previewImage.load('');
    if (this.activeModelViewer) {
      this.remove(this.activeModelViewer);
      this.activeModelViewer = null;
    }
    this.updateMicDiagnostics();
    this.setStatus('Workspace reset.');
  }
}



